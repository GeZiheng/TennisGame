/**
 * 场地与地面标记的建模。纯 three.js 构造，不持有任何状态。
 *
 * 从 `scene.ts` 搬出来的原因：这一块是「照着真实球场尺寸画一遍」（地面、边线、
 * 球网、网柱、击球面提示条），约 140 行，改它的理由永远是「画得对不对」，
 * 和每帧的渲染/判定没有交集。
 */

import * as THREE from 'three';
import {
  BASELINE_Z,
  FACE_RX,
  HALF_WIDTH,
  HIT_Z,
  NET_Z,
  OPP_BASELINE_Z,
  SERVICE_Z,
} from '../../core/court';

export function buildCourt(scene: THREE.Scene) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 90),
    new THREE.MeshStandardMaterial({ color: '#d5dcd3', roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const lineMat = new THREE.MeshStandardMaterial({ color: '#fbfbf8', roughness: 0.9 });
  const seg = (x1: number, z1: number, x2: number, z2: number, w = 0.06) => {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz) + w;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, 0.004, w), lineMat);
    mesh.position.set((x1 + x2) / 2, 0.003, (z1 + z2) / 2);
    mesh.rotation.y = Math.atan2(-dz, dx);
    mesh.receiveShadow = true;
    scene.add(mesh);
  };

  const W = HALF_WIDTH;
  // 边线一直拉到对面底线，其余线条按球网镜像一份。整块场地 = 我这边 + 对面，
  // 球网在中间——这不是「画两面墙」，是同一片场地的两半。
  const zFar = OPP_BASELINE_Z;
  const svc = 2 * NET_Z - SERVICE_Z;
  seg(-W, BASELINE_Z, W, BASELINE_Z, 0.08); // 底线
  seg(-W, BASELINE_Z, -W, zFar); // 单打边线
  seg(W, BASELINE_Z, W, zFar);
  seg(-W, SERVICE_Z, W, SERVICE_Z, 0.05); // 发球线
  seg(0, SERVICE_Z, 0, NET_Z, 0.05); // 中央发球线
  seg(-0.16, BASELINE_Z, 0.16, BASELINE_Z, 0.09); // 中点标记
  seg(-W, OPP_BASELINE_Z, W, OPP_BASELINE_Z, 0.08);
  seg(-W, svc, W, svc, 0.05);
  seg(0, svc, 0, NET_Z, 0.05);
  seg(-0.16, OPP_BASELINE_Z, 0.16, OPP_BASELINE_Z, 0.09);

  // 网：用程序生成的网格纹理，比一块半透明色块更像网
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const cx = c.getContext('2d')!;
  cx.strokeStyle = 'rgba(74,80,72,0.6)';
  cx.lineWidth = 1;
  for (let i = 0; i <= 128; i += 8) {
    cx.beginPath();
    cx.moveTo(i + 0.5, 0);
    cx.lineTo(i + 0.5, 64);
    cx.stroke();
  }
  for (let j = 0; j <= 64; j += 8) {
    cx.beginPath();
    cx.moveTo(0, j + 0.5);
    cx.lineTo(128, j + 0.5);
    cx.stroke();
  }
  const netTex = new THREE.CanvasTexture(c);
  netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping;
  netTex.repeat.set(5, 1);
  netTex.anisotropy = 4;

  const net = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 2, 0.9),
    new THREE.MeshBasicMaterial({
      map: netTex,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      opacity: 0.85,
    })
  );
  net.position.set(0, 0.45, NET_Z);
  scene.add(net);

  const band = new THREE.Mesh(
    new THREE.BoxGeometry(W * 2 + 0.1, 0.06, 0.025),
    new THREE.MeshStandardMaterial({ color: '#fbfbf8', roughness: 0.8 })
  );
  band.position.set(0, 0.9, NET_Z);
  scene.add(band);

  const postMat = new THREE.MeshStandardMaterial({ color: '#9aa198', roughness: 0.7 });
  for (const px of [-W - 0.05, W + 0.05]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.07, 12), postMat);
    post.position.set(px, 0.535, NET_Z);
    post.castShadow = true;
    scene.add(post);
  }
}

/**
 * 击球面：地上一条浅色横线，告诉玩家「球到这条线就该出手了」。
 *
 * 宽度跟着拍面走（约 1.4 个拍面宽），并且**跟着站位移动**。
 * 原来画的是 2.9 米（旧击球框宽度），那还是「整条线都能打」时代的提示，
 * 现在可击球面积只有 30cm 宽——画这么长等于在骗人往边上站。
 */
export function buildHitStrip(): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    color: '#3aa07d',
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(FACE_RX * 2.8, 0.16), mat);
  strip.rotation.x = -Math.PI / 2;
  strip.position.set(0, 0.004, HIT_Z);
  return strip;
}
