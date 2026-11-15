/**
 * 对打无头模拟：验证脚本回球机到底能不能连续接球。
 *
 * 玩家一侧是「近乎完美的脚本」：按预测到面点摆拍、到点就挥。
 * 所以这里出现的失败，基本都能归到回球机头上——那正是要测的东西。
 *
 *   node scripts/duel-sim.mjs
 *   node scripts/duel-sim.mjs --seconds 120 --level 2
 */
const { Duel } = require('../.tmp-duel/core/duel.js');
const { predictAtPlane, MACHINE_L1, MACHINE_L2, MACHINE_L3 } = require('../.tmp-duel/core/machine.js');
const { HIT_Z, OPP_HIT_Z, NET_Z, OPP_BASELINE_Z, BASELINE_Z, HALF_WIDTH, BALL_R, RACKET_POS } = require('../.tmp-duel/core/court.js');
const { aimIntoCourt } = require('../.tmp-duel/core/physics.js');
const { serveBox, serveStrike, SERVE_STAND_Z } = require('../.tmp-duel/core/serve.js');
const { AUTO_MOVE_DEFAULTS } = require('../.tmp-duel/core/auto-move.js');

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
};
const SECONDS = argOf('--seconds', 60);
const TRACE = argv.includes('--trace');
const TRACE_M = argv.includes('--trace-m');

/** 绕给定世界轴转 deg 度 */
function quatAxis(axis, deg) {
  const a = (deg * Math.PI) / 360;
  const s = Math.sin(a);
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos(a)];
}

function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** q 作用在向量上 */
function qrot(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

/** 拍柄朝上、拍面朝 -z 的基准姿态（和探针 `lib/probe-player.cjs` 同一个构造） */
function racketQuat(thetaDeg) {
  const half = (thetaDeg * Math.PI) / 360;
  return [0, Math.cos(half), Math.sin(half), 0];
}

const THETA = 14;
const Q = racketQuat(THETA);
/** 握点 → 拍面中心的偏移（世界系）。拍面中心 = 握点 + 这个向量。 */
const FACE_OFF = qrot(Q, [0, 0.6, 0]);
const FACE_DIR = qrot(Q, [0, 0, 1]);

const SWING_LEAD = 0.075;
/**
 * 横向跑动速度。直接取 `AUTO_MOVE_DEFAULTS.speed`：脚本玩家不能拥有真机没有的
 * 跑动能力，也不能比真机慢——两边一旦漂了，门禁量到的就不是玩家身上的行为。
 */
const MOVE = AUTO_MOVE_DEFAULTS.speed;

/**
 * 发球站位上握点举多高。
 *
 * 真机那边 `app.ts` 搬的是 `RACKET_POS[1] + 0.32`（`Duel.playerAtStance` 要求
 * 高过 `+0.25`），这里用同一个数，否则脚本玩家永远站不到位、每分都等到
 * `SETUP_MAX_MS` 超时才抛球。
 */
const SERVE_GRIP_Y = RACKET_POS[1] + 0.32;

/**
 * 发球拍面：从 `contact` 指向地面上的 `(tx, tz)`。
 *
 * `serveAim` 只读拍面的**水平偏角**（决定左右）和**俯角**（映射成区内的深浅），
 * 所以这里不用去解弹道——挑一个中段的俯角（3°–18° 行程的中间 ≈ 10.5°），
 * 再让偏角指向目标点就够了。落点最终由 `Duel.launchServe` 的求解器保证。
 */
function serveFace(contact, tx, tz) {
  const pitch = (10.5 * Math.PI) / 180;
  // atan2(dx, dz 的相反数)：目标总在 -z 方向，所以 `contact[2] - tz > 0`
  const yaw = Math.atan2(tx - contact[0], contact[2] - tz);
  return [
    Math.cos(pitch) * Math.sin(yaw),
    -Math.sin(pitch),
    -Math.cos(pitch) * Math.cos(yaw),
  ];
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function run(level, cfg, seed, seconds) {
  const realRandom = Math.random;
  const rng = makeRng(seed);
  Math.random = rng;

  const duel = new Duel(undefined, cfg);
  duel.reset(1000);

  const dt = 1000 / 60;
  const now0 = 1000;
  const frames = Math.round((seconds * 1000) / dt);

  let gripX = 0;
  // 握点行程直接取 `AUTO_MOVE_DEFAULTS`：真机的自动走位就是按这一对上下限搬握点的
  // （`minGripY`=0.70 深屈膝 / `maxGripY`=1.65 举拍）。这里曾经硬写成
  // `RACKET_POS[1]` 和 `RACKET_POS[1]-0.38`，那是 11-13 之前的旧模型——照着它量，
  // 「接不到球」会被误判成回球机的问题，实际是测试玩家比真机矮了一截。
  const GRIP_TOP = AUTO_MOVE_DEFAULTS.maxGripY;
  const GRIP_LOW = AUTO_MOVE_DEFAULTS.minGripY;
  let gripY = RACKET_POS[1];
  let lastSubmit = -1e9;
  let lastAim = null;
  let clampedLow = 0;
  let clampedHigh = 0;
  /** 玩家刚发出一个球、还没被接到（用来数「接发球成功率」） */
  let awaitReturn = false;

  const stat = {
    playerPoints: 0,
    machinePoints: 0,
    rallies: [],
    reasons: {},
    machineHits: 0,
    machineMiss: { timing: 0, reach: 0, solve: 0 },
    playerReachIssue: 0,
    serves: 0,
    aimNull: 0,
    swingsMade: 0,
    /** 脚本玩家真正挥出去的发球数（抛球落下 → 挥到） */
    playerServes: 0,
    /** 玩家发球失误：一发 / 二发分开数，二发失误就是双误 */
    playerFault1: 0,
    playerFault2: 0,
    /** 玩家的发球被回球机接回来的次数（与 `playerServes` 相除就是接发球成功率） */
    machineServeReturns: 0,
  };

  try {
    for (let i = 0; i < frames; i++) {
      const now = now0 + i * dt;

      // ---- 玩家：发球局站发球位，其余时间「预测到面点 → 摆拍 → 到点就挥」 ----
      //
      // `playerServeStanceX` 非 null 就说明这一刻轮到玩家发球（包含分与分之间的
      // `wait`），站位由发球区决定。**它优先于自动走位**，和真机 `app.ts` 一致：
      // 发球是站位固定的动作，一边跑一边发不是网球。
      const stanceX = duel.playerServeStanceX;
      const serving = stanceX !== null;

      let pred = null;
      if (!serving && duel.receiver === 'player' && duel.ball.v[2] > 0.5 && duel.phase === 'live') {
        pred = predictAtPlane(duel.ball, HIT_Z);
      }

      if (serving) {
        gripX = stanceX;
        gripY = SERVE_GRIP_Y;
      } else if (pred) {
        // 横向走位（限速），纵向靠抬高/压低握点模拟屈膝
        const step = (MOVE * dt) / 1000;
        gripX += Math.max(-step, Math.min(step, pred.x - gripX));
        // 站位边界和真机同一组常量：11-15 起横向放到边线外 1.5m、纵向到网前 4m，
        // 脚本也得按这个夹——否则它会「跑到」真机根本去不了的位置。
        gripX = Math.max(-AUTO_MOVE_DEFAULTS.maxX, Math.min(AUTO_MOVE_DEFAULTS.maxX, gripX));
        // 真实玩家的握点上限恒是 RACKET_POS[1]，拍面中心只能在半径 0.6 的球壳上。
        // 这里按同一段夹住，别让测试玩家拥有真机没有的「蹲下去」能力——否则测出来
        // 的命中率是假的。上下限都由 `RACKET_POS[1]` 推，握点一改这里跟着改。
        const wantY = pred.y - FACE_OFF[1];
        gripY = Math.max(GRIP_LOW, Math.min(GRIP_TOP, wantY));
        if (wantY < GRIP_LOW) clampedLow++;
        if (wantY > GRIP_TOP) clampedHigh++;
      }

      const pose = {
        t: now,
        pos: [gripX, gripY, serving ? SERVE_STAND_Z : HIT_Z - FACE_OFF[2]],
        q: [...Q],
      };
      duel.pushRacket(pose);

      if (serving) {
        // 抛球 → 等它过了最高点、落进击球区（`serveStrike` + `SERVE_REACH`）→ 挥。
        //
        // 「下落段才可打」是 `tossContact` 的硬条件：出手点本来就在击球区下方
        // 不到一个判定半径，不卡这一条，脚本玩家会在抛出的那一帧就把球打出去。
        //
        // 判定中心必须用 `serveStrike`（握点锚点 + 拍面中心钳制），不能用拍面中心：
        // 11-15 之后抛球点锚在身体前上方，横握时拍面中心在侧方 0.6m，
        // 按拍面中心等球会**永远等不到**（球根本不去那儿）。
        if (duel.phase === 'toss' && duel.ball.v[1] < 0) {
          const sc = serveStrike(pose);
          if (Math.abs(duel.ball.p[1] - sc[1]) < 0.3) {
            const box = serveBox('player', duel.serveInfo.court);
            const face = serveFace(sc, (box.x0 + box.x1) / 2, (box.z0 + box.z1) / 2);
            // 挥拍方向**平行于拍面**：`shotFromStroke` 的旋转是 face×head 的切向分量，
            // 两者一平行就没有侧旋。侧旋在这里是有毒的——发球落点被判在发球区内，
            // 但球到对面击球面时已经被甩出 1.5m，回球机的 reachX 够不着，
            // 于是每一分都变成「发球直接赢」，看不到任何回合。
            duel.submit({
              t: now,
              peakW: 15,
              head: [face[0] * 20, face[1] * 20, face[2] * 20],
              speed: 14,
              face,
              grip: [0, 1, 0],
              charge: 0.6,
              used: false,
            });
            stat.swingsMade++;
            stat.playerServes++;
            lastSubmit = now;
          }
        }
      } else if (pred && duel.phase === 'live' && now - lastSubmit > 260) {
        const tta = pred.t;
        if (tta > 0 && tta < SWING_LEAD) {
          // 玩家的出球也走求解器，但**只约束落点在对方场内**、不约束到面高度：
          // 回球机会自己跑位去迎，所以「打到哪」才是玩家该操心的事。
          // 真机上玩家的出球来自 shotFromStroke（比这更野），用求解器是为了
          // 让这个测试脚本稳定输出「能过网、能落界内」的球，好把回球机的
          // 失败单独暴露出来。
          const tx = (rng() - 0.5) * 5.2;
          const tz = NET_Z - 1.4 - rng() * 7.4;
          const at = [pred.x, pred.y, HIT_Z];
          const pOpts = {
            zMin: OPP_BASELINE_Z + 0.3,
            zMax: NET_Z - 0.3,
            // 下限必须高于 SPEED_MIN=18：求解出来的速度如果低于 18，
            // shotFromStroke 会把它抬回 18，方向不变、球多飞三成，直接出界。
            // 上限对 SPEED_MAX=32 留余量，避免被削顶。
            speed: [18.5, 30],
          };
          // 和回球机一样退让两档：想打的角度打不出来就先保证过网落界内。
          const aim =
            aimIntoCourt(at, [tx, BALL_R, tz], [0, 0, 0], { ...pOpts, maxClear: 1.8 }) ??
            aimIntoCourt(at, [tx * 0.6, BALL_R, (tz - 1.2)], [0, 0, 0], { ...pOpts, maxClear: 2.2 }) ??
            aimIntoCourt(at, [0, BALL_R, NET_Z - 4], [0, 0, 0], { ...pOpts, maxClear: 2.6 });
          if (aim) {
            lastAim = aim;
            // `shotFromStroke` 里出球方向是 `face*0.72 + unit(head)*0.3 + [0,0.06,0]`
            // 再归一化，速度是 `dot(head,dir)*0.85 + 3` 夹到 18–32。
            // 直接拿求解结果当 head 会同时偏方向和偏快（多 15%），球大多出底线，
            // 测出来全是「玩家出界」，看不到回球机。这里把这两个换算反解掉。
            const S = Math.hypot(aim[0], aim[1], aim[2]);
            const d = [aim[0] / S, aim[1] / S, aim[2] / S];
            // 让 shotFromStroke 吐回来的东西**正好**是这条速度：
            //   dir = unit(face*0.72 + unit(head)*0.3 + [0,0.06,0])
            // 取 head ∥ d、face = d - [0, 0.06/0.72, 0]，两项一减正好抵消，
            // dir 就等于 d；同时 head 与 dir 严格平行 ⇒ 切向分量为零 ⇒ 无旋转。
            // 不这么做的话，那个 +0.06 会让拍面法线和挥拍方向差 3°，
            // 切出来的 backspin 有 -30 rad/s，球会飘出去 3 米——测出来的全是出界。
            const face = [d[0], d[1] - 0.06 / 0.72, d[2]];
            const h = (S - 3) / 0.85;
            stat.swingsMade++;
            duel.submit({
              t: now,
              peakW: 15,
              head: [d[0] * h, d[1] * h, d[2] * h],
              speed: h,
              face,
              grip: [0, 1, 0],
              charge: 0.6,
              used: false,
            });
          } else {
            stat.aimNull++;
          }
          lastSubmit = now;
        }
      }

      for (const e of duel.update(dt / 1000, now)) {
        if (e.kind === 'point') {
          if (e.winner === 'player') stat.playerPoints++;
          else stat.machinePoints++;
          stat.rallies.push(e.rally);
          stat.reasons[`${e.winner}:${e.reason}`] = (stat.reasons[`${e.winner}:${e.reason}`] || 0) + 1;
        } else if (e.kind === 'hit' && e.by === 'player') {
          stat.playerHits = (stat.playerHits || 0) + 1;
          if (TRACE && stat.playerHits <= 14) {
            const v = duel.ball.v;
            console.log(
              `  [玩家击球#${stat.playerHits}] 接触点 (${e.at[0].toFixed(2)}, ${e.at[1].toFixed(2)}, ${e.at[2].toFixed(2)}) ` +
                `v=(${v[0].toFixed(1)}, ${v[1].toFixed(1)}, ${v[2].toFixed(1)}) |v|=${Math.hypot(v[0], v[1], v[2]).toFixed(1)} ` +
                `求解=(${lastAim ? lastAim.map((n) => n.toFixed(1)).join(', ') : '发球'})`
            );
          }
        } else if (e.kind === 'hit' && e.by === 'machine') {
          stat.machineHits++;
          if (!e.serve && awaitReturn) {
            stat.machineServeReturns++;
            awaitReturn = false;
          }
          if (TRACE && stat.machineHits <= 12) {
            console.log(
              `  [机器击球#${stat.machineHits}] 出球点 z=${e.at[2].toFixed(1)} y=${e.at[1].toFixed(2)} ` +
                `v=${e.speed.toFixed(1)} 目标 z=${duel.machine.lastTarget ? duel.machine.lastTarget[2].toFixed(2) : '??'} ` +
                `x=${duel.machine.lastTarget ? duel.machine.lastTarget[0].toFixed(2) : '??'}`
            );
          }
        } else if (e.kind === 'serve') {
          stat.serves++;
          if (e.by === 'player') awaitReturn = true;
        } else if (e.kind === 'point') {
          // 一分结束了还没被接回来 = 这一发接发球失败
          awaitReturn = false;
        } else if (e.kind === 'fault' && e.by === 'player') {
          if (e.attempt === 1) stat.playerFault1++;
          else stat.playerFault2++;
          if (TRACE) console.log(`  [玩家发球失误] ${e.attempt}发 · ${e.reason}`);
        } else if (e.kind === 'out' && TRACE) {
          console.log(
            `  [出界·${e.by}] 落点 x=${e.at[0].toFixed(2)} z=${e.at[2].toFixed(2)} ` +
              `(边线 ${HALF_WIDTH} / 底线 ${BASELINE_Z})`
          );
        }
      }

      if (TRACE_M && duel.receiver === 'machine' && duel.phase === 'live' && i % 15 === 0) {
        const m = duel.machine;
        const pr = m.pred;
        console.log(
          `    t=${(now / 1000).toFixed(2)} 球 z=${duel.ball.p[2].toFixed(1)} y=${duel.ball.p[1].toFixed(2)} ` +
            `vz=${duel.ball.v[2].toFixed(1)} | 机器 z=${m.pos[2].toFixed(1)} x=${m.pos[0].toFixed(1)} y=${m.pos[1].toFixed(2)} ` +
            `| 迎击 ${pr ? `t=${pr.t.toFixed(2)} (${pr.x.toFixed(1)}, ${pr.y.toFixed(2)}, ${pr.z.toFixed(1)})` : 'null'}`
        );
      }

      // 回球机的失败原因任何时候都可能残留，只要读到就记一次再清掉
      const m = duel.machine.lastMiss;
      if (m) {
        stat.machineMiss[m]++;
        duel.machine.lastMiss = null;
      }
    }
  } finally {
    Math.random = realRandom;
  }

  stat.playerReachIssue = clampedLow + clampedHigh;
  return stat;
}

const LEVELS = [
  { name: 'L1 新手', cfg: MACHINE_L1 },
  { name: 'L2 中等', cfg: MACHINE_L2 },
  { name: 'L3 强', cfg: MACHINE_L3 },
];
const levelArg = argOf('--level', 0);
const picked = levelArg ? [LEVELS[levelArg - 1]] : LEVELS;

/**
 * 门禁断言。
 *
 * 只钉「塌了就是塌了」的几条，不钉具体数字——回合长度会随着瞄准策略和
 * 落点带变化，写死一个平均值只会让以后每次调参都得改断言。
 *
 * 特别不钉「比分」：这个脚本里的玩家是近乎完美的（球一定接到、一定打进界内），
 * 它赢多少分只反映它自己多强，跟回球机好不好无关。要看难度梯度得看
 * 「机器在同样时间里接了多少球」。
 */
const fails = [];
const check = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) fails.push(msg);
};

const summary = {};

for (const { name, cfg } of picked) {
  const agg = {
    playerPoints: 0,
    machinePoints: 0,
    rallies: [],
    reasons: {},
    machineHits: 0,
    machineMiss: { timing: 0, reach: 0, solve: 0 },
    playerReachIssue: 0,
    serves: 0,
    aimNull: 0,
    swingsMade: 0,
    /** 脚本玩家真正挥出去的发球数（抛球落下 → 挥到） */
    playerServes: 0,
    /** 玩家发球失误：一发 / 二发分开数，二发失误就是双误 */
    playerFault1: 0,
    playerFault2: 0,
    /** 玩家的发球被回球机接回来的次数（与 `playerServes` 相除就是接发球成功率） */
    machineServeReturns: 0,
  };
  const SEEDS = [11, 222, 3333, 44444, 555555, 6666666];
  for (const seed of SEEDS) {
    const s = run(name, cfg, seed, SECONDS);
    agg.playerPoints += s.playerPoints;
    agg.machinePoints += s.machinePoints;
    agg.rallies.push(...s.rallies);
    agg.machineHits += s.machineHits;
    agg.playerReachIssue += s.playerReachIssue;
    agg.serves += s.serves;
    agg.aimNull += s.aimNull;
    agg.swingsMade += s.swingsMade;
    agg.playerServes += s.playerServes;
    agg.playerFault1 += s.playerFault1;
    agg.playerFault2 += s.playerFault2;
    agg.machineServeReturns += s.machineServeReturns;
    for (const [k, v] of Object.entries(s.reasons)) agg.reasons[k] = (agg.reasons[k] || 0) + v;
    for (const [k, v] of Object.entries(s.machineMiss)) agg.machineMiss[k] += v;
  }

  const total = agg.playerPoints + agg.machinePoints;
  const avg = agg.rallies.length ? agg.rallies.reduce((a, b) => a + b, 0) / agg.rallies.length : 0;
  const max = agg.rallies.length ? Math.max(...agg.rallies) : 0;
  const long = agg.rallies.filter((r) => r >= 6).length;

  console.log(`\n=== ${name} ===`);
  console.log(
    `比分 玩家 ${agg.playerPoints} : ${agg.machinePoints} 机器（${total} 分 / ${SEEDS.length} 局 × ${SECONDS}s）`
  );
  console.log(
    `回合 平均 ${avg.toFixed(1)} 拍 · 最长 ${max} 拍 · ≥6 拍占比 ${((long / (agg.rallies.length || 1)) * 100).toFixed(0)}%`
  );
  console.log(`机器击球 ${agg.machineHits} 次 · 发球 ${agg.serves} 次`);
  console.log(`机器挥空 ${agg.machineMiss.timing} · 够不着 ${agg.machineMiss.reach} · 解不出 ${agg.machineMiss.solve}`);
  console.log(`玩家挥拍 ${agg.swingsMade} 次 · 求解失败 ${agg.aimNull} 次`);
  const serveReturnPct = agg.playerServes ? (agg.machineServeReturns / agg.playerServes) * 100 : 0;
  console.log(
    `玩家发球 ${agg.playerServes} 次 · 一发失误 ${agg.playerFault1} · 二发失误（双误）${agg.playerFault2}` +
      ` · 被接回来 ${agg.machineServeReturns}（${serveReturnPct.toFixed(0)}%）`
  );
  console.log(`玩家够不着（握点被夹）${agg.playerReachIssue} 帧`);
  const rk = Object.keys(agg.reasons).sort((a, b) => agg.reasons[b] - agg.reasons[a]);
  for (const k of rk) console.log(`  ${k.padEnd(20)} ${agg.reasons[k]}`);

  summary[cfg.seed] = { name, hits: agg.machineHits, avg, max, serves: agg.serves };
  const machineFails = agg.machineMiss.timing + agg.machineMiss.reach + agg.machineMiss.solve;
  const label = name;

  check(total > 0, `${label}：至少有球可打`);
  check(agg.machineHits > 0, `${label}：回球机能真的把球打回来`);
  check(
    machineFails < agg.machineHits,
    `${label}：够不着/挥空/解不出（${machineFails}）少于成功回球（${agg.machineHits}）`
  );
  check(agg.aimNull * 2 < agg.serves + agg.swingsMade, `${label}：测试玩家自己求解失败不过半`);
  // 发球必须能被接回来。这条是 4.24 那轮的教训：发球一旦发成「接不到的球」，
  // 每一分都会变成「发球直接得分」，而所有旧断言都还是绿的（回合数不为 0 是因为
  // 极少数球碰巧能接），直到有人去看「平均回合 0.0 拍」才暴露。
  check(
    agg.playerServes === 0 || agg.machineServeReturns * 4 >= agg.playerServes,
    `${label}：玩家的发球有四分之一以上被接回来（${agg.machineServeReturns}/${agg.playerServes}）`
  );
  if (argv.includes('--level') && levelArg === 2) {
    check(avg >= 2.5, `${label}：平均回合 ≥ 2.5 拍（实测 ${avg.toFixed(1)}）`);
  }
}

// 难度梯度只在跑满三档时判：强档在同样时间里应该接到更多球。
if (!levelArg) {
  const [l1, l2, l3] = LEVELS.map((l) => summary[l.cfg.seed]);
  console.log('\n=== 门禁 ===');
  check(l3.hits > l1.hits, `L3 回球次数（${l3.hits}）> L1（${l1.hits}）：难度梯度方向正确`);
  check(l2.max >= 3, `L2 最长回合 ≥ 3 拍（实测 ${l2.max}）`);
}

if (fails.length) {
  console.error(`\n✗ ${fails.length} 条断言未通过`);
  process.exit(1);
}
console.log('\n✓ 对打模拟通过');
