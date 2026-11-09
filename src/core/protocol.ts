/**
 * 传感器数据包格式。
 *
 * 设计原则：定长、小端、无反射、无 JSON。60Hz 下每包 60 字节，
 * 加上 WebRTC 头也不到 10 kbps —— 带宽从来不是瓶颈，延迟和抖动才是。
 *
 *   0   u32   seq      包序号，用来估算丢包
 *   4   f64   tSend    发送时刻（球拍端 performance.now()，毫秒）
 *  12   f64   tSample  这一帧姿态被传感器采到的时刻（球拍端同一时钟）
 *  20   f32   qx qy qz qw   归一化后的相对姿态四元数
 *  36   f32   gx gy gz      角速度，rad/s，设备坐标系
 *  48   f32   ax ay az      加速度，单位 g，设备坐标系（含重力）
 *  60   f32   peakG          本次会话加速度峰值（g），用来判断量程是否被打爆
 *  64   f32   peakW          本次会话角速度峰值（rad/s）
 *
 * 为什么同时要 tSend 和 tSample：tSend 量到「网络 + 排队」，tSample 量到「采样 →
 * 渲染」的整条路。只报 tSend 会把手机传感器那 0–30ms 藏起来，让人误以为网络很慢。
 */
export const PACKET_BYTES = 68;

/** 旧版定长（没有 tSample 字段），只用于解码兼容，不再发出 */
export const LEGACY_BYTES = 60;

export interface ImuPacket {
  seq: number;
  tSend: number;
  /** 这一帧姿态被采到的时刻；拿不到时填和 tSend 相同的值 */
  tSample: number;
  q: [number, number, number, number];
  gyro: [number, number, number];
  accel: [number, number, number];
  peakG: number;
  peakW: number;
}

export function encodePacket(p: ImuPacket, out?: ArrayBuffer): ArrayBuffer {
  const buf = out ?? new ArrayBuffer(PACKET_BYTES);
  const dv = new DataView(buf);
  dv.setUint32(0, p.seq >>> 0, true);
  dv.setFloat64(4, p.tSend, true);
  dv.setFloat64(12, p.tSample, true);
  dv.setFloat32(20, p.q[0], true);
  dv.setFloat32(24, p.q[1], true);
  dv.setFloat32(28, p.q[2], true);
  dv.setFloat32(32, p.q[3], true);
  dv.setFloat32(36, p.gyro[0], true);
  dv.setFloat32(40, p.gyro[1], true);
  dv.setFloat32(44, p.gyro[2], true);
  dv.setFloat32(48, p.accel[0], true);
  dv.setFloat32(52, p.accel[1], true);
  dv.setFloat32(56, p.accel[2], true);
  dv.setFloat32(60, p.peakG, true);
  dv.setFloat32(64, p.peakW, true);
  return buf;
}

export function decodePacket(buf: ArrayBuffer): ImuPacket | null {
  const dv = new DataView(buf);
  if (buf.byteLength >= PACKET_BYTES) {
    return {
      seq: dv.getUint32(0, true),
      tSend: dv.getFloat64(4, true),
      tSample: dv.getFloat64(12, true),
      q: [dv.getFloat32(20, true), dv.getFloat32(24, true), dv.getFloat32(28, true), dv.getFloat32(32, true)],
      gyro: [dv.getFloat32(36, true), dv.getFloat32(40, true), dv.getFloat32(44, true)],
      accel: [dv.getFloat32(48, true), dv.getFloat32(52, true), dv.getFloat32(56, true)],
      peakG: dv.getFloat32(60, true),
      peakW: dv.getFloat32(64, true),
    };
  }

  // 旧版 60 字节格式（没有 tSample）。手机浏览器很爱缓存页面，改协议之后
  // 手机端没刷新就会一直发旧包——不兼容的话大屏会「一条都收不到」，
  // 看起来像整条链路坏了，其实只是缓存。这里退化成 tSample = tSend，
  // 端到端延迟会少算手机那一段，但能正常玩。
  if (buf.byteLength >= LEGACY_BYTES) {
    const tSend = dv.getFloat64(4, true);
    return {
      seq: dv.getUint32(0, true),
      tSend,
      tSample: tSend,
      q: [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)],
      gyro: [dv.getFloat32(28, true), dv.getFloat32(32, true), dv.getFloat32(36, true)],
      accel: [dv.getFloat32(40, true), dv.getFloat32(44, true), dv.getFloat32(48, true)],
      peakG: dv.getFloat32(52, true),
      peakW: dv.getFloat32(56, true),
    };
  }

  return null;
}

/** 手机常见 MEMS 的量程上限，用来判断数据是否被削顶。 */
export const ACCEL_FULL_SCALE_G = 16;
export const GYRO_FULL_SCALE_RAD = (2000 * Math.PI) / 180;

export type CtrlMsg =
  | { t: 'hello'; ua: string; hz: number; motion: boolean; orientation: boolean }
  | { t: 'ping'; t0: number }
  | { t: 'pong'; t0: number; t1: number; t2: number }
  | { t: 'recal' }
  | { t: 'recal-ack'; at: number };
