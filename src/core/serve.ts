/**
 * 发球几何：发球区、站位、抛球、击球区、拍面瞄准。
 *
 * 全部是纯函数 / 纯常量，`Duel`（判定）、`app.ts`（HUD 指示）、`scene.ts`（地面高亮）
 * 和单测用的是同一份。这一层最容易出的错是「左右搞反」——发球区是斜对角的，
 * 从发球方的右区发到接发方的右区，而两边都朝球网看，所以世界的 x 符号是**反的**。
 * 这里只有一处定义（`serveBox` / `serveStandX`），别在别处再推一遍。
 *
 * ## 坐标提醒
 *
 * 玩家在 +z 侧、面朝 -z，右手边是 **+x**；机器在 -z 侧、面朝 +z，右手边是 **-x**。
 * 所以「右区（deuce）」对玩家是 x>0 半场，对机器是 x<0 半场；而发球要发到
 * **接发方的右区**，于是玩家的右区发球落点是 x<0（对面那半场的右侧），依此类推。
 *
 * ## 抛球为什么锚在「身体」而不是「拍面」
 *
 * 11-15 真机反馈：抛球太低、而且「相对球拍的位置不合理」。两个问题同源——原来的
 * 抛球点取的是**拍面中心**，而拍面中心挂在握点沿拍柄 0.6m 的杆子上：手机竖握时
 * 它在握点正上方（球抛在头顶），横握时它在握点正前方 0.6m（球抛在胸前，而且离手
 * 一截），屏幕朝上时又是另一个方向。同一句「抛球」在三种握法下抛到三个地方，
 * 玩家把拍子举到头顶时球不在那儿，当然打不着、也发不进区。
 *
 * 现在抛球点和击球区都锚在**握点**上（`SERVE_STRIKE_UP/FWD`）：头顶前上方那一块，
 * 与手机怎么转无关。拍面中心离这个锚点太远时（`SERVE_ANCHOR_R`）把它拉回来，
 * 于是横握也够得着，而竖握时用的仍然是真正的拍面中心（视觉上球就打在拍线上）。
 */

import { BALL_R, HALF_WIDTH, HIT_Z, NET_Z, SERVICE_Z } from './court';
import { faceCenter, frontFace, type RacketPose } from './racket';
import type { Side, ServeCourt } from './match';
import type { V3 } from './vec';

/** 对手侧的发球线 z（把本地发球线沿球网镜像） */
export const OPP_SERVICE_Z = 2 * NET_Z - SERVICE_Z;

/**
 * 发球站位：左右各离中线这么远。
 *
 * 真实发球站在单打边线与中线之间，靠中线。1.2m 已经能把「右区 / 左区」
 * 在画面里区分出来，又不至于站到双打通道里去。
 */
export const SERVE_STAND_X = 1.2;

/** 发球站位的纵深：退到底线附近（走位范围的最后沿，`HIT_Z + 1.0`）。 */
export const SERVE_STAND_Z = HIT_Z + 1.0;

/**
 * 抛球的出手高度（米）。
 *
 * 取 2.05 = 站位握点 1.62 上方 0.43m，也就是「举拍发球时手所在的高度」。
 * 原来的 1.95 只比拍面中心低 27cm，球一出手就躺在判定球里，而且整个抛球弧顶
 * 只在拍面上方 0.5m——看起来不像抛球，像把球往上一递。
 */
export const TOSS_Y0 = 2.05;

/**
 * 抛球初速（m/s）。顶点 = 2.05 + 5.2²/19.6 ≈ **3.43m**。
 *
 * 这个数决定「上手发球」这件事成不成立：
 *   - 顶点 3.43m 在举高的拍面（2.22m）上方 **1.2m**，球有明显的上升段和下坠段，
 *     玩家能在球下坠时迎上去打，这才是上手发球的节奏（原来是 0.5m，几乎贴着拍面）；
 *   - 从出手到落进击球区（2.57m）约 **0.95 秒**：比真人发球（约 1 秒）一样，
 *     又不至于慢到像在等电梯；
 *   - 到地面还有 1.4 秒，`TOSS_TIMEOUT_MS`=3.2s 兜得住。
 */
export const TOSS_VY = 5.2;

/**
 * 抛球点相对站位的纵深：**朝球网方向 0.25m**。
 *
 * 真人发球把球抛在身体前上方，击球点在额头前方，不在正头顶——正头顶那一下
 * 是靠腰压不出去的。这里连同 `SERVE_STRIKE_FWD` 一起，把握点、抛球点、击球点
 * 放在同一条竖直线上，只是比站位靠网 0.25m。
 */
export const TOSS_FWD = 0.25;

/** 抛球点的 z（世界坐标，站位靠网 0.25m）。`playerServeSetup` 托球时用同一个。 */
export const SERVE_TOSS_Z = SERVE_STAND_Z - TOSS_FWD;

/**
 * 击球区锚点：握点**上方 0.53m、前方 0.25m**。
 *
 * 0.53 = 拍面中心挂在握点外 0.6m 的杆子上、竖握时它就在 2.22；锚点取 2.15 是为了
 * 让「竖握」和「斜着握」都落在同一个判定球里。它是**与手机朝向无关**的：
 * 无论屏幕朝前还是朝上，球都抛到这儿、也在这一带被击出。
 */
export const SERVE_STRIKE_UP = 0.53;
export const SERVE_STRIKE_FWD = 0.25;

/**
 * 拍面中心离锚点超过这个距离就朝锚点收（米）。
 *
 * 横握（屏幕朝前、拍面水平）时拍面中心在握点正前方 0.6m，离锚点 0.63m；
 * 不收回来，那颗抛在头顶的球就永远在判定球外面——这正是真机反馈里
 * 「抛球相对球拍的位置不合理，很难把球发进区」的几何来源。
 *
 * 0.35 = 竖握时中心离锚点 0.07（不动），横握时只收 0.28，视觉上球还在拍子附近。
 */
export const SERVE_ANCHOR_R = 0.35;

/**
 * 发球时「球在拍面上」的判定半径（米）。
 *
 * 发球不用 `sweepFace` 的平面穿越判据：抛球几乎是竖直的，而竖直持拍时拍面
 * 也是竖直的，球会**沿着**拍面所在平面走，`n0/n1` 永远同号，一次都判不到。
 * 这里改成「球到击球区中心的最近距离」——一个球形判定，既绕开这个退化，
 * 又正好符合发球时「球在拍面上方一点点」的实际情况。
 *
 * 0.42 = 拍面竖直半轴 0.19 + 球半径 0.034 + 一个明显更宽的余量。发球是一次
 * 主动的、把球抛起来再打的动作，比接杀该宽容得多；0.34 那一档实测「等球落进
 * 来」的窗口只有 0.2 秒，手一慢就漏。
 */
export const SERVE_REACH = 0.42;

/**
 * 抛球还在上升时允许多快的竖直速度（m/s）就当作可击球。
 *
 * 0.5 只留一点余量给顶点附近的抖动：真实接触点在**下落段**。见 `tossContact`。
 */
export const MAX_TOSS_RISE = 0.5;

/**
 * 左右瞄准的**灵敏度**：把「拍面偏角相对区中心」压缩到 0.65 倍再用。
 *
 * 1.0 就是老老实实按射线求交，此时从发球位看，对角发球区只张开 **15.6°**
 * （实测：指向区左边缘 −20.4°、右边缘 −4.8°）——拍面偏 8° 就出区。手机上没有人
 * 能一边控制俯角、一边把偏航压进 ±8°。0.65 把合法窗口撑到 **24°**，同时中心
 * 仍然对着区中心（偏角是相对它压缩的），所以「指向区中心 = 绿」这条直觉不变；
 * 瞄另一半区仍然要明显转过头（实测转过头 17° 就出区），照样失误。
 *
 * 为什么不像俯角那样直接**映射**到区宽：左右是「发错区 = 失误」这条规则的
 * 全部依据，映射等于把失误抹掉。压缩保留方向感，也不给白送的进区。
 */
export const YAW_GAIN = 0.65;

export interface ServeBox {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * 发球该落进的那个区（世界坐标，x0<x1、z0<z1）。
 *
 * `server` 是**发球方**，`court` 是发球方站的那半边。落点永远在斜对角：
 * 玩家从右区发 → 机器的右区（世界 x<0）；玩家从左区发 → 世界 x>0。
 */
export function serveBox(server: Side, court: ServeCourt): ServeBox {
  const deuce = court === 'deuce';
  if (server === 'player') {
    // 对手半场：发球线在 z=-16.5，网在 z=-10.5
    return {
      x0: deuce ? -HALF_WIDTH : 0,
      x1: deuce ? 0 : HALF_WIDTH,
      z0: OPP_SERVICE_Z,
      z1: NET_Z,
    };
  }
  return {
    x0: deuce ? 0 : -HALF_WIDTH,
    x1: deuce ? HALF_WIDTH : 0,
    z0: NET_Z,
    z1: SERVICE_Z,
  };
}

/**
 * 发球站位的 x。
 *
 * 玩家的右区 = +x，机器的右区 = -x（两边都朝球网看）。所以这里是
 * 「自己那一侧」×「右/左」，而不是直接拿 `court` 当符号。
 */
export function serveStandX(server: Side, court: ServeCourt): number {
  const side = server === 'player' ? 1 : -1;
  const half = court === 'deuce' ? 1 : -1;
  return SERVE_STAND_X * side * half;
}

export function inServeBox(p: V3, server: Side, court: ServeCourt): boolean {
  const b = serveBox(server, court);
  return p[0] >= b.x0 - 1e-9 && p[0] <= b.x1 + 1e-9 && p[2] >= b.z0 - 1e-9 && p[2] <= b.z1 + 1e-9;
}

/**
 * 发球时的击球区中心（世界坐标）。
 *
 * 锚在握点的前上方（见文件头），再把拍面中心拽到 `SERVE_ANCHOR_R` 以内：
 * 竖握时拍面中心本来就贴着锚点，原样返回（球就打在拍线上）；横握 / 斜握时
 * 拍面在侧面，收回来一点，判定仍然成立。
 */
export function serveStrike(pose: RacketPose): V3 {
  const ax = pose.pos[0];
  const ay = pose.pos[1] + SERVE_STRIKE_UP;
  const az = pose.pos[2] - SERVE_STRIKE_FWD;
  const c = faceCenter(pose);
  const dx = c[0] - ax;
  const dy = c[1] - ay;
  const dz = c[2] - az;
  const l = Math.hypot(dx, dy, dz);
  if (l <= SERVE_ANCHOR_R || l < 1e-9) return c;
  const k = SERVE_ANCHOR_R / l;
  return [ax + dx * k, ay + dy * k, az + dz * k];
}

export interface ServeAim {
  /** 拍面指到的地面落点（世界坐标，y=0 平面） */
  point: V3;
  /** 水平偏角（度，正 = 偏 +x） */
  yawDeg: number;
  /** 这个落点在不在正确的发球区里。决定 HUD 上那圈是绿还是红。 */
  inBox: boolean;
  /** 拍面几乎没朝前，落点是硬截出来的，一定不准 */
  far: boolean;
}

/**
 * 拍面朝向 → 发球落点。
 *
 * ## 为什么纵深不直接取「射线与地面的交点」
 *
 * 直接取交点的话，落点纵深由**拍面俯角**唯一决定：从 2.5m 高、14m 外的
 * 发球区看，能落进区的俯角窗口只有几度。手机上这比走钢丝还难，而它还不是
 * 「技术」，只是几何太窄。
 *
 * 所以纵深改成**映射**：俯角 3° 打深（靠近发球线），18° 打浅（靠近网），
 * 中间线性。于是「拍面压得越多，球越短」这条直觉还在，但整段 15° 的行程
 * 全都落在发球区里，玩家只需要控制**左右**——那才是网球发球真正的难点。
 *
 * 左右不夹，只做灵敏度压缩（`YAW_GAIN`）：指向另一半区或者转过头，就是失误。
 * 这是「必须发到正确的区」这条规则的用处所在，夹住就没人会失误了。
 *
 * @param face 拍面法线（`Stroke.face` 或 `vrot(q,[0,0,1])`）。双面的问题在内部处理。
 * @param shaft 拍柄方向（`Stroke.grip` 或 `vrot(q,[0,1,0])`）。拍面朝天时改用它当准星。
 */
export function serveAim(
  contact: V3,
  face: V3,
  server: Side,
  court: ServeCourt,
  shaft?: V3
): ServeAim {
  const box = serveBox(server, court);
  const axis = aimAxis(unit(face), shaft ? unit(shaft) : null);
  const yaw = Math.atan2(axis[0], -axis[2]);

  // 拍面（和拍框）都没朝球场：硬给一个落点，反正一定在区外
  if (axis[2] > -0.08) {
    const p: V3 = [contact[0] + axis[0] * 20, BALL_R, contact[2] + axis[2] * 20];
    return { point: p, yawDeg: (yaw * 180) / Math.PI, inBox: false, far: true };
  }

  const pitch = Math.asin(clamp(-axis[1], -1, 1)); // 正 = 拍面下压
  const T_DEEP = (3 * Math.PI) / 180;
  const T_SHORT = (18 * Math.PI) / 180;
  const u = clamp((pitch - T_DEEP) / (T_SHORT - T_DEEP), 0, 1);

  const zDeep = box.z0 + 0.7;
  const zShort = box.z1 - 1.0;
  const z = zDeep + (zShort - zDeep) * u;

  // 左右：以「指向区中心」为 0 点，按 `YAW_GAIN` 压缩偏角（见常量说明）
  const cx = (box.x0 + box.x1) / 2;
  const cz = (box.z0 + box.z1) / 2;
  const yawBox = Math.atan2(cx - contact[0], contact[2] - cz);
  const yawEff = clamp(yawBox + (yaw - yawBox) * YAW_GAIN, -1.3, 1.3);
  const x = contact[0] + Math.tan(yawEff) * (contact[2] - z);
  const point: V3 = [x, BALL_R, z];

  return {
    point,
    yawDeg: (yaw * 180) / Math.PI,
    inBox: x >= box.x0 && x <= box.x1,
    far: false,
  };
}

/**
 * 选一根「准星」轴。
 *
 * 拍面朝球场（法线 -z）时当然用它——那是玩家真正在控制的东西。
 * 但举拍发球时，手机很自然会被握成**屏幕朝天**：这时法线的水平分量几乎为零，
 * 按法线算出来的偏角是一条噪声，任何人都不可能发进区。而这一刻拍框的朝向
 * （拍柄方向）恰好指着前上方，它才是玩家脑子里的「往哪儿打」。
 *
 * 所以退一步：法线不朝球场时，从拍柄的两头里挑朝网的那一头。两条都不可用时
 * 仍然返回法线，交给 `far` 分支当作一次失误。
 */
function aimAxis(face: V3, shaft: V3 | null): V3 {
  const front = frontFace(face);
  if (front[2] <= -0.08 || !shaft) return front;
  const s = shaft[2] > 0 ? ([-shaft[0], -shaft[1], -shaft[2]] as V3) : shaft;
  return s[2] < front[2] ? s : front;
}

export interface TossHit {
  /** 球离击球区中心最近的那个点（当作击球点） */
  at: V3;
  /** 偏离中心的比例（0 = 正中，1 = 判定球面边缘） */
  off: number;
}

/**
 * 抛球有没有碰到拍面。
 *
 * 球形判定，理由见 `SERVE_REACH`；中心不是拍面中心而是 `serveStrike`（锚点钳制后的）。
 * 取球在这一子步内离中心的**最近点**，比「子步端点」更稳：球一帧走十几厘米，
 * 端点判定会让击球点偏半帧。
 *
 * ## 为什么还要卡「还在上升」
 *
 * 抛球出手点在锚点下方 0.1m，**已经躺在判定球里**。不卡这一条，玩家抛球的同时
 * 随手一挥就能在出手高度把球打出去：判定上没错，但那是「发球」吗？真实发球
 * 是球升到最高点开始下落、拍子迎上去在头顶击球。
 *
 * 所以只接受 `vy <= maxRise`（≈最高点之后）的接触。球从 2.05 升到 3.43 顶点，
 * 再落回 2.57 ± 的那一段才可打——距抛球约 0.95 秒，正好是真实发球的节奏。
 *
 * @param vy 球在这一刻的竖直速度（m/s）。不传就等于不卡这一条（单测用）。
 */
export function tossContact(
  pose: RacketPose,
  p0: V3,
  p1: V3,
  vy = -1,
  radius = SERVE_REACH
): TossHit | null {
  if (vy > MAX_TOSS_RISE) return null;
  const c = serveStrike(pose);
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const dz = p1[2] - p0[2];
  const len2 = dx * dx + dy * dy + dz * dz;

  let s = 0;
  if (len2 > 1e-12) {
    s = ((c[0] - p0[0]) * dx + (c[1] - p0[1]) * dy + (c[2] - p0[2]) * dz) / len2;
    s = clamp(s, 0, 1);
  }
  const q: V3 = [p0[0] + dx * s, p0[1] + dy * s, p0[2] + dz * s];
  const dist = Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]);
  if (dist > radius) return null;
  return { at: q, off: dist / radius };
}

/* ---------------- 本地小工具 ---------------- */

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function unit(a: readonly number[]): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, -1];
}
