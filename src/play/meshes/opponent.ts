/**
 * 对手（脚本回球机）那支球拍。位姿每帧从 `Duel.machinePose()` 抄过来，
 * 和判定用的是**同一个** `RacketPose`——否则又是一次「看着碰到了没打到」。
 */

import * as THREE from 'three';
import { OPP_HIT_Z } from '../../core/court';
import { buildRacketMesh } from './racket';

/**
 * 对打模式下的对手（脚本回球机）。
 *
 * 只用程序化球拍，不加载 glb：那支模型是给玩家手里那支用的，对手在 20 米外，
 * 细节全被雾和透视吃掉，多加载一份只会多一次可能失败的请求。
 */
export function buildOpponent(): { group: THREE.Group; glow: THREE.PointLight } {
  const group = new THREE.Group();
  group.position.set(0, 1.0, OPP_HIT_Z);
  group.add(buildRacketMesh());

  const glow = new THREE.PointLight('#9ec7ff', 0.9, 4.5);
  glow.position.set(0, 1.6, OPP_HIT_Z);
  return { group, glow };
}
