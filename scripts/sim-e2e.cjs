/**
 * 端到端模拟：从「真机形态的角速度串」一路跑到「对拉」。
 *
 * 和单元测试的区别在于输入是刻意做脏的：
 *   - 大屏 60Hz 发包，姿态只有 30Hz → 每个角速度值被连发 2 次（平台段）
 *   - 挥拍峰值在 5.5–28 rad/s 之间扫，覆盖「轻碰」到「全力」
 * 只有这样才复现得出「球到面 43 次、挥拍只记到 1 次」那种现场。
 *
 * 每一档跑多个种子：发球的横向扰动是随机的，而「补偿器选了高吊弧线 →
 * 回球在脚前弹起 → reach」这类漏接**只在特定扰动的耦合下出现**。
 * 单种子跑过不代表没问题——这个档位曾经单种子 15 拍全中、换个种子就连挂三次。
 */
const { SwingDetector } = require('../.tmp-sim/core/swing.js');
const { Rally } = require('../.tmp-sim/core/rally.js');
const { HIT_Z, RACKET_POS } = require('../.tmp-sim/core/court.js');
const { faceCenter } = require('../.tmp-sim/core/racket.js');
const { makeBall, advance } = require('../.tmp-sim/core/physics.js');
const { planAutoMove, stepAxis, AUTO_MOVE_DEFAULTS } = require('../.tmp-sim/core/auto-move.js');
const { FACE_CY } = require('../.tmp-sim/core/court.js');

/**
 * 走位方式，由环境变量 `MOVE` 选，默认 `naive`（历史行为，门禁按它判）。
 *
 *   naive —— 朝球的**当前**横向位置跑（本文档下面解释为什么不做弹道外推）
 *   auto  —— 用玩家侧真正上线的那套 `planAutoMove`：预测球穿击球面时的 x，
 *            限速搬过去，没来球时回中线。和 `src/play/app.ts` 同一份代码。
 *   off   —— 人站着不动。用来量化「不走到球的落点上，命中率到底是多少」，
 *            也就是自动走位这个功能存在的理由。
 */
const MOVE = process.env.MOVE ?? 'naive';

/**
 * 「球还有多久到拍面」——直接拿物理往前推，而不是按当前速度外推。
 *
 * 为什么必须这么算：来球现在会先落地再弹起，落地前后速度方向相差很大，
 * 按落地前的速度外推「还要多久到」会提前一秒起势（发球落点在击球线前方
 * 1.9m，比触发的距离阈值还近）。这不是玩家会犯的错——人看的是球，
 * 不是当前速度向量。
 */
function predictReach(ball, faceZ) {
  const b = makeBall(ball.p, ball.v, ball.spin);
  b.bounces = ball.bounces;
  b.wallHits = ball.wallHits;
  let zPrev = b.p[2];
  let t = 0;
  for (let i = 0; i < 240 * 3; i++) {
    advance(b, 1 / 240, () => {});
    t += 1 / 240;
    if (zPrev < faceZ && b.p[2] >= faceZ) return t;
    if (!b.live) return null;
    zPrev = b.p[2];
  }
  return null;
}

/**
 * 可复现的伪随机。发球横向扰动、以及一切 Math.random 都走它，
 * 这样「哪一局暴露了问题」是可复现的，修没修好也能逐种子核对。
 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** 每档跑几个种子。6 个足够覆盖扰动的常见组合，也不至于让模拟变慢。 */
const SEEDS = [11, 222, 3333, 44444, 555555, 6666666];

/**
 * 球拍姿态：拍柄向后上方倾 θ 度，拍面朝球场。
 *
 * 这个倾斜不是装饰。拍柄严格竖直时，拍头速度 v = ω × r 在几何上**必然水平**，
 * 球只会以 3° 飞出去然后直接落地——那是模拟器的缺陷，不是玩家的动作。
 *
 * 推导：q 是 180° 旋转，轴取 (0, cos(θ/2), sin(θ/2))，即 q = [0, cos(θ/2), sin(θ/2), 0]。
 * 180° 旋转作用在 [0,1,0] 上得 grip = [0, cosθ, sinθ]，作用在 [0,0,1] 上得 face = [0, sinθ, -cosθ]。
 * 注意是**半角**——写成 [0, cosθ, sinθ, 0] 会得到两倍的角度，球会直接飞出墙顶。
 *
 * θ 随发力程度递减，因为这是真实球员在做的事：同样的拍面角度挥得越猛，球飞得越高越远，
 * 所以发力时必须压平拍面。固定 20° 打满力，球回来时还在头顶两米以上，根本够不着。
 */
function racketQuat(thetaDeg) {
  const half = (thetaDeg * Math.PI) / 360;
  return [0, Math.cos(half), Math.sin(half), 0];
}

/** 绕给定世界轴转 deg 度 */
function quatAxis(axis, deg) {
  const a = (deg * Math.PI) / 360;
  const s = Math.sin(a);
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos(a)];
}

/** q0 * q1：先在 q1 里转，再整体用 q0 摆正 —— 也就是「绕拍子自己的轴转」 */
function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/**
 * 挥拍时球拍**真的在转**，不是只在角速度上有个数。
 *
 * 这一条是之前模拟最大的漏洞：位姿全程是同一个 Q，只有 omega 在变。
 * 于是「握点固定 + 绕握点旋转 → 拍面中心甩出半米」这条真机主路径
 * 从来没被模拟覆盖过（单测全绿、真机全漏）。
 *
 * 转角由角速度积分得到（ω = peakW·sin(πu)），绕**局部 x 轴**（拍面横轴）转：
 * 拍面像正手一样从上往下压，拍面中心随之绕握点扫出去 0.3–0.6m。
 * 球不再追拍面；这里压测的是「拍面真的在转时，物理弹道还能不能命中」。
 */
function swingDeg(peakW, u) {
  if (u <= 0) return 0;
  const k = Math.min(u, 1);
  return ((peakW * (SWING_MS / 1000)) / Math.PI) * (1 - Math.cos(Math.PI * k)) * (180 / Math.PI);
}

const SWING_MS = 150;
const RESAMPLE = 2; // 几个发包才有一个新姿态帧

function run({ peakW, label, seed }) {
  const r = new Rally();
  const det = new SwingDetector();
  const dt = 1000 / 60;
  const now0 = 1000;

  let swingStart = null; // 波形起点（绝对时刻）
  let hasSwung = false; // 本个来球是否已经挥过
  // 发力越大，拍面越平：20° 打轻球，全力时压到 7°
  const theta = Math.max(5.5, 20 - (peakW - 5.5) * 0.66);
  const Q = racketQuat(theta);

  let held = 0.4; // 平台段里被重复发送的值
  let frame = 0;

  // 站位。严格碰撞之后拍面只有 30×38cm，不走到球的落点上就打不到——
  // 这里按真实速度限制移动，而不是瞬移过去，否则模拟出来的「命中率」
  // 会比真机高，掩盖掉走位不足的问题。
  let racketX = 0;
  const SPEED = 5.5; // m/s，接近职业球员的横移冲刺

  const stats = { hits: 0, misses: 0, nets: 0, ends: 0, serves: 0, swings: 0, trace: [] };

  // 本局随机源：只影响发球横向扰动
  const rng = makeRng(seed);
  const realRandom = Math.random;
  Math.random = rng;
  try {
    for (let i = 0; i < 60 * 40; i++) {
      const now = now0 + i * dt;

      // 球打出去、或者这一球已经断了，都重新允许挥拍。
      // 只判 outgoing 是不够的：漏接时阶段从 contact 直接跳 dead，不经过 outgoing，
      // hasSwung 会永远卡在 true，之后每个球都「不挥」，模拟出来的结果全是漏接。
      if (r.phase === 'outgoing' || r.phase === 'dead') hasSwung = false;

      // ---- 1. 决定什么时候挥：球快到拍面时起势，峰值落在球穿过拍面那一刻 ----
      // 用物理前推算「还有多久到」（predictReach），不用当前速度外推：
      // 来球会先落地再弹起，落地前后速度方向差很远，外推会提前一秒起势。
      //
      // 目标是 HIT_Z：球按自己的弹道飞，按球到达击球面那一刻起势就够；
      // 落地弹起那一次重瞄（aimArrival）已经把球送到拍面附近。
      //
      // 触发阈值收在 75ms：起势太早会让峰值落在球到面之前，那一下拍面
      // 已经转过去，球就打不到了。这是玩家的时机，不该由球去补偿。
      // 现在按「球快到了就挥」处理，峰值落在球到面附近，误差在 ±75ms 以内。
      // 直接看「球还有多久到击球面」（z 距离 / z 速度），不用整条弹道前推：
      // 来球中途还会落地弹一次，整条弹道外推会把落地那一拐算进去，时机反而飘。
      // 这里只要 75ms 内的判断，线性足够。
      const tta = r.ball.v[2] > 0.5 ? (HIT_Z - r.ball.p[2]) / r.ball.v[2] : Infinity;
      if (!hasSwung && swingStart === null && r.phase === 'incoming' && tta > 0 && tta < 0.075) {
        swingStart = now;
        hasSwung = true;
      }

      // ---- 2. 生成这一帧的角速度（只有每 RESAMPLE 帧才真的更新 → 平台段）----
      if (frame % RESAMPLE === 0) {
        if (swingStart === null) {
          held = 0.4;
        } else {
          const u = (now - swingStart) / SWING_MS;
          held = u <= 0 || u >= 1 ? 0.4 : peakW * Math.sin(Math.PI * u);
        }
      }
      frame++;

      // ---- 2.2 挥拍时球拍真的在转 ----
      // 转角 = 角速度的积分。绕**局部 x 轴**（拍面横轴）转，等于一次正手压拍：
      // 拍面中心跟着绕握点扫出 0.3–0.6m。球不再追拍面，这段缺口由玩家
      // 自己对准；正常挥拍节奏下球到面时转角还小，落地重瞄已经够用。
      const uSwing = swingStart === null ? -1 : (now - swingStart) / SWING_MS;
      const deg = uSwing < 0 ? 0 : swingDeg(peakW, uSwing);
      const qSwing = qmul(Q, quatAxis([1, 0, 0], deg));

      if (swingStart !== null && now - swingStart > SWING_MS + 60) {
        swingStart = null;
        // 挥了一空拍。真实玩家会接着再来一次，所以这里也允许重新瞄准。
        hasSwung = false;
      }

      // ---- 2.5 走位 ----
      if (MOVE === 'auto') {
        // 和 `src/play/app.ts` 同一套决策，但**只吃 x**：这个脚本的挥拍时机是按
        // 「球到 HIT_Z」算的，站位跟着 z 变会把时机判据一起改掉，A/B 就不可比了。
        // 竖握（center 朝上）时拍面中心就在握点正上方，x 目标与中心目标一致。
        const plan = planAutoMove(
          r.ball,
          { x: racketX, z: HIT_Z, center: [0, FACE_CY, 0] },
          AUTO_MOVE_DEFAULTS,
        );
        const speed = plan.chasing ? AUTO_MOVE_DEFAULTS.speed : AUTO_MOVE_DEFAULTS.homeSpeed;
        const next = stepAxis(racketX, plan.target, speed * (dt / 1000), AUTO_MOVE_DEFAULTS.deadband);
        racketX = Math.max(-3, Math.min(3, next));
      } else if (MOVE === 'naive' && r.ball.v[2] > 0.5) {
        // 朝球的**当前**横向前进，不做弹道外推：来球还要落地弹一次，
        // 整条弹道外推会把落地那一拐算进去，走位容易追过头。直接朝球走，天然收敛。
        const aim = Math.max(-3, Math.min(3, r.ball.p[0]));
        const step = SPEED * (dt / 1000);
        racketX += Math.max(-step, Math.min(step, aim - racketX));
      }
      // 位姿 = 握点 + 朝向。拍面中心随之绕握点扫动，这是真实的挥拍几何。
      r.pushRacket({ t: now, pos: [racketX, RACKET_POS[1], HIT_Z], q: qSwing });

      // ---- 3. 走检测器（每帧都喂，模拟 60Hz 发包）----
      const stroke = det.push({ t: now, omega: [held, 0, 0], q: qSwing });
      if (stroke) {
        stats.swings++;
        r.submit(stroke);
      }

      // ---- 4. 推进状态机 ----
      for (const e of r.update(dt / 1000, now)) {
        if (e.kind === 'hit') stats.hits++;
        else if (e.kind === 'miss') {
          stats.misses++;
          if (stats.trace.length < 4) {
            stats.trace.push(
              `${e.reason} 球=(${r.ball.p.map((v) => v.toFixed(2)).join(',')}) ` +
                `拍心=(${faceCenter({ t: now, pos: [racketX, RACKET_POS[1], HIT_Z], q: qSwing }).map((v) => v.toFixed(2)).join(',')}) 转角${deg.toFixed(0)}° ` +
                `v=(${r.ball.v.map((x) => x.toFixed(1)).join(',')}) ` +
                `lag=${r.diag.lastLag === null ? 'null' : Math.round(r.diag.lastLag)}`
            );
          }
        } else if (e.kind === 'net') stats.nets++;
        else if (e.kind === 'end') stats.ends++;
        else if (e.kind === 'serve') stats.serves++;
      }
    }
  } finally {
    Math.random = realRandom;
  }

  const ok = stats.hits >= 8 && stats.misses === 0 && stats.nets === 0;
  const lag = r.diag.lastLag === null ? '—' : `${r.diag.lastLag > 0 ? '+' : ''}${Math.round(r.diag.lastLag)}ms`;
  console.log(
    `${ok ? '  ok ' : ' FAIL'} ${label.padEnd(20)} 种子${String(seed).padStart(7)} | ` +
      `峰值${String(peakW).padStart(4)} 识别${String(stats.swings).padStart(3)} 击球${String(stats.hits).padStart(3)} ` +
      `漏接${stats.misses} 撞网${stats.nets} 断球${stats.ends} 连拍${r.streak} 最好${r.best} 仰角${theta.toFixed(0)}° 末次时差${lag}` +
      (stats.trace.length ? `\n       漏接详情: ${stats.trace.join('  ')}` : '')
  );
  return ok;
}

console.log(`端到端：60Hz 发包 + 30Hz 姿态（平台段输入），走位=${MOVE}，每档多个种子\n`);
const cases = [
  { peakW: 5.5, label: '轻挥（刚过门槛）' },
  { peakW: 8, label: '中力' },
  { peakW: 12, label: '正常发力' },
  { peakW: 18, label: '大力' },
  { peakW: 28, label: '全力（近削顶）' },
];
const results = cases.flatMap((c) => SEEDS.map((seed) => run({ ...c, seed })));
console.log(results.every(Boolean) ? '\n全部通过' : '\n有失败项');
process.exit(results.every(Boolean) ? 0 : 1);
