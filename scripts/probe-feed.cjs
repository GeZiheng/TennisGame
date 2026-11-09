/**
 * 诊断：喂球把球送到哪、以及「发球之后玩家走开了」还送不送得到。
 *
 *   node scripts/probe-feed.cjs
 *
 * 输出每一球的：发球分支 / 落点 / 落点离玩家多远 / 弹起后穿过拍面时
 * 相对拍面中心的偏差（Δx, Δy）。Δ 是「看起来够到了却没打到」的直接度量：
 * 拍面半宽 15cm、半高 19cm（再加球半径），Δ 超过它必空。
 */
const { Rally } = require('../.tmp-sim/core/rally.js');
const { faceCenter } = require('../.tmp-sim/core/racket.js');
const { RACKET_POS, HIT_Z, FACE_RX, FACE_RY, BALL_R } = require('../.tmp-sim/core/court.js');
const phys = require('../.tmp-sim/core/physics.js');

const branches = [];
const origBounce = phys.feedBounce;
phys.feedBounce = function (...args) {
  const r = origBounce.apply(null, args);
  branches.push({ d: args[3], ok: !!r, dropZ: r ? r.dropZ : null, hitVy: r ? r.hitVy : null });
  return r;
};

/** Quat4 = [x,y,z,w]：把局部 +y（拍柄）转到 dir */
function quatFromGrip(dir) {
  const [x, y, z] = dir;
  const len = Math.hypot(x, y, z);
  const d = [x / len, y / len, z / len];
  const up = [0, 1, 0];
  const dot = d[1];
  if (dot > 0.9999) return [0, 0, 0, 1];
  if (dot < -0.9999) return [1, 0, 0, 0];
  const ax = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]];
  const s = Math.sqrt((1 + dot) * 2);
  return [ax[0] / s, ax[1] / s, ax[2] / s, s / 2];
}

function run(label, gripDir, walk) {
  const r = new Rally();
  const dt = 1000 / 60;
  let now = 1000;
  const q = quatFromGrip(gripDir);
  let x = 0;
  // 位姿和游戏里一致：握点 + 朝向（拍面中心挂在 0.6m 杆末，由 faceCenter 算）。
  // 这里拍子不挥，所以拍面中心恒在握点上方 FACE_CY。
  const pose = () => ({ t: now, pos: [x, RACKET_POS[1], HIT_Z], q });

  branches.length = 0;
  const rows = [];
  const served = []; // 每球：{at, dropZ, dist}
  let cur = null;
  let prevZ = null;
  let crossed = false;
  let walked = false;

  for (let i = 0; i < 60 * 12; i++) {
    now += dt;
    // 走位：发球后 0.35 秒开始横移 1.2 米（复现「球发出去了我才挪了一步」）
    if (walk && cur && !walked && now - cur.at > 350) {
      walked = true;
      x = 1.2;
    }
    r.pushRacket(pose());

    for (const e of r.update(dt / 1000, now)) {
      if (e.kind === 'serve') {
        cur = { at: now };
        walked = false;
        const f = faceCenter(pose());
        const b = branches.find((v) => v.ok) || {};
        rows.push(
          `\n  发球：拍面中心 y=${f[1].toFixed(2)} z=${f[2].toFixed(2)}` +
            `  落点z=${b.dropZ === null || b.dropZ === undefined ? '—' : b.dropZ.toFixed(2)}` +
            ` (离玩家 ${(HIT_Z - (b.dropZ ?? HIT_Z)).toFixed(2)}m, 离拍面 ${(b.dropZ === undefined || b.dropZ === null ? 0 : f[2] - b.dropZ).toFixed(2)}m) 到面vy=${b.hitVy === null || b.hitVy === undefined ? '—' : b.hitVy.toFixed(2)}`
        );
      }
      if (e.kind === 'miss') {
        rows.push(`    漏接 ${e.reason}`);
        cur = null;
        crossed = false;
        prevZ = null;
      }
      if (e.kind === 'hit') {
        rows.push(`    命中 offset=${r.diag.lastOffCenter === null ? '—' : (r.diag.lastOffCenter * 100).toFixed(0) + '%'}`);
        cur = null;
        crossed = false;
        prevZ = null;
      }
    }

    if (r.phase === 'incoming' && prevZ !== null && !crossed) {
      const f = faceCenter(pose());
      if (prevZ < f[2] && r.ball.p[2] >= f[2]) {
        crossed = true;
        rows.push(
          `    过拍面 Δx=${(r.ball.p[0] - f[0]).toFixed(2)} Δy=${(r.ball.p[1] - f[1]).toFixed(2)} ` +
            `vy=${r.ball.v[1].toFixed(1)} vz=${r.ball.v[2].toFixed(1)} 可击|Δx|<${(FACE_RX + BALL_R + 0.02).toFixed(2)} |Δy|<${(FACE_RY + BALL_R + 0.02).toFixed(2)}`
        );
      }
    }
    prevZ = r.ball.p[2];
  }
  console.log(`${label}`);
  console.log(rows.slice(0, 30).join('\n'));
}

console.log(`拍面半宽 ${FACE_RX} 半高 ${FACE_RY} 球半径 ${BALL_R}`);
run('A 竖握、站着不动', [0, 1, 0], false);
run('\nB 竖握、发球后横移 1.2 米（考验落地重瞄）', [0, 1, 0], true);
run('\nC 横握前伸、站着不动', [0, 0, -1], false);
