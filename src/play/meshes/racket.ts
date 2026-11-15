/**
 * 球拍的几何：程序化兜底模型、拍面薄膜、以及 glb 的加载替换。
 *
 * 从 `scene.ts` 搬出来的原因：约 210 行纯建模，没有任何每帧状态。它也是**最常被
 * 单独调整**的一块（近景机位、拍面观感、换模型），隔离出来之后改它不用读整个场景类。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { FACE_CY, FACE_RX, FACE_RY } from '../../core/court';

/**
 * 网球拍。
 *
 * 之前那支是照着羽毛球拍做的：细拍杆（Ø2.2cm）、窄长小拍面、拍框管径只有 1.1cm、
 * 没有喉部三角。网球拍的特征几乎全在反面——粗框、宽椭圆拍面、拍喉明显分叉、
 * 握把更粗更长。所以这里按成人拍的真实比例重做：
 *
 *   总长 0.78m，拍面 31 × 37cm（原来 25 × 33cm，面积 +39%），框管 Ø2.6cm。
 *
 * 注意：拍面变大**不影响物理**。击球判定用的是时间窗（球穿过击球面的时刻 ± 150ms），
 * 和拍面几何没有任何关系；`SWING_ARM` 也保持 0.68 不变，免得把已经调好的手感打乱。
 */
/**
 * 程序化兜底球拍。
 *
 * 只在 `models/racket.glb` 加载失败时露脸，所以它的取舍是「一定画得出来」，
 * 不是「画得最好」：全部用 three 内置几何体拼，没有外部依赖、没有异步。
 * 尺寸仍然按 FACE_* 常量来，这样就算兜底被顶上来，视觉和判定也是对齐的。
 */
export function buildRacketMesh(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'racket-fallback';

  /* ---- 尺寸（米） ---- */
  const gripLen = 0.212;
  const gripR = 0.0215;
  const headCY = 0.6; // 拍面中心
  const rx = 0.148; // 半宽 → 拍面宽 30cm
  const ry = 0.19; // 半长 → 拍面长 38cm（长宽比 1.28，接近真实 oversize 拍面）
  const headBottom = headCY - ry;
  const frameR = 0.013; // 框管半径，网球拍明显比羽毛球拍粗
  const throatHalfX = 0.056;
  const throatTop = headBottom + 0.004;

  const frameMat = new THREE.MeshStandardMaterial({ color: '#2b3336', roughness: 0.3, metalness: 0.55 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: '#0f6e56',
    roughness: 0.45,
    metalness: 0.25,
    side: THREE.DoubleSide,
  });
  const gripMat = new THREE.MeshStandardMaterial({ color: '#2c2825', roughness: 0.95 });

  /* ---- 握把：尾盖 + 缠带 ---- */
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(gripR, gripR * 0.96, gripLen, 24), gripMat);
  grip.position.y = gripLen / 2;
  grip.castShadow = true;
  g.add(grip);

  // 吸汗带缠绕：一叠细环。近看是纹理，远看只是一点点起伏，比纯圆柱诚实得多
  const wrapGeo = new THREE.TorusGeometry(gripR + 0.0006, 0.0017, 6, 22);
  for (let i = 0; i < 9; i++) {
    const ring = new THREE.Mesh(wrapGeo, gripMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.045 + i * 0.018;
    g.add(ring);
  }

  const butt = new THREE.Mesh(new THREE.CylinderGeometry(gripR * 1.14, gripR * 1.14, 0.014, 24), frameMat);
  butt.position.y = 0.007;
  butt.castShadow = true;
  g.add(butt);

  /* ---- 拍喉：两根分叉杆 + 中间的三角涂装 ---- */
  for (const s of [-1, 1]) {
    const dy = throatTop - gripLen;
    const dx = s * throatHalfX;
    const len = Math.hypot(dx, dy);
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.0115, 0.014, len, 14), frameMat);
    strut.position.set(dx / 2, (gripLen + throatTop) / 2, 0);
    // 圆柱默认沿 +Y，转到 (dx, dy) 方向
    strut.rotation.z = -Math.atan2(dx, dy);
    strut.castShadow = true;
    g.add(strut);
  }

  const plate = new THREE.Shape();
  plate.moveTo(-throatHalfX + 0.011, throatTop - 0.006);
  plate.lineTo(throatHalfX - 0.011, throatTop - 0.006);
  plate.quadraticCurveTo(0, gripLen + 0.062, -throatHalfX + 0.011, throatTop - 0.006);
  const plateMesh = new THREE.Mesh(new THREE.ShapeGeometry(plate, 14), accentMat);
  g.add(plateMesh);

  /* ---- 拍框：椭圆管 ---- */
  // 不能用 Torus + scale：那会把管子本身也压扁，椭圆长轴处框变细、短轴处变粗。
  // 沿椭圆采样点再扫掠，管径才是均匀的。
  const ringPts: THREE.Vector3[] = [];
  const SEG = 72;
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    ringPts.push(new THREE.Vector3(Math.cos(a) * rx, headCY + Math.sin(a) * ry, 0));
  }
  const frame = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ringPts, true), 144, frameR, 10, true),
    frameMat
  );
  frame.castShadow = true;
  g.add(frame);

  /* ---- 拍线 14 × 16 ---- */
  // 14×16 而不是真实的 16×19：再密一点在 1080p 下会糊成一片灰。
  const pts: number[] = [];
  const NV = 14;
  const NH = 16;
  const inRx = rx - frameR * 0.75;
  const inRy = ry - frameR * 0.75;
  for (let i = 1; i <= NV; i++) {
    const x = (-1 + (2 * i) / (NV + 1)) * inRx;
    const yy = inRy * Math.sqrt(Math.max(0, 1 - (x / inRx) ** 2));
    pts.push(x, headCY - yy, 0, x, headCY + yy, 0);
  }
  for (let i = 1; i <= NH; i++) {
    const y = (-1 + (2 * i) / (NH + 1)) * inRy;
    const xx = inRx * Math.sqrt(Math.max(0, 1 - (y / inRy) ** 2));
    pts.push(-xx, headCY + y, 0, xx, headCY + y, 0);
  }
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(
    new THREE.LineSegments(
      gridGeo,
      new THREE.LineBasicMaterial({ color: '#8d9c93', transparent: true, opacity: 0.9 })
    )
  );

  return g;
}

/**
 * 拍面上那层 5% 白的薄膜。
 *
 * 只有拍线时，浅色背景一拍过去拍面就像个空环，读起来像羽毛球拍那种细框。
 * 5% 的白几乎不影响透视，但眼睛会把它识别成一个完整的拍面。
 * 直径收到拍框内沿以内（0.9 倍）：溢到框上会看起来像玻璃贴片而不是拍面。
 */
export function buildMembrane(): THREE.Mesh {
  const membrane = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  membrane.position.y = FACE_CY;
  membrane.scale.set(FACE_RX * 0.9, FACE_RY * 0.9, 1);
  return membrane;
}

/**
 * 换上 `public/models/racket.glb` 里的球拍模型（1372 三角面，无贴图）。
 *
 * 模型自报的元数据和球拍组的约定完全一致——pivot 在柄底中心、拍头沿 +Y、
 * 拍面法线 +Z、单位米，所以朝向一个都不用调，只差尺寸：
 *
 *   模型是真实比例（拍框外沿半宽 12.8cm，拍面中心在柄底上方 51.5cm），
 *   而判定椭圆是 FACE_RX 15cm / FACE_RY 19cm、中心 FACE_CY 60cm。
 *
 * 直接摆进去，视觉拍面会比判定盘低 8.5cm：球从拍面下沿掠过时判「没打到」，
 * 可看起来明明碰到了——这比尺寸差一点更伤人。所以两个轴分别拉：
 *
 *   - x 拉到拍框外沿正好等于 FACE_RX。这一条是**精确**对齐，不是凑数：
 *     sweepFace 的判据是「球心在 FACE_RX + 球半径 的椭圆内」，也就是球体
 *     贴着框外沿算命中——视觉框边正好落在 FACE_RX 上，两者严丝合缝。
 *   - y 拉到拍面中心落在 FACE_CY（0.6/0.515 ≈ 1.165），顺带把柄长拉到 21.5cm。
 *
 * 非均匀缩放的代价是框管截面被压扁 0.6%（2.4cm 的管子差 1.5mm），肉眼不可能
 * 看出来；换来的是「看到的拍面就是判定的拍面」。整体长度 68.5cm → 79.7cm，
 * 和原来程序化那支（80.3cm）几乎一样，所以换拍之后场景观感不会跳。
 */
export function loadRacketModel(racket: THREE.Group, renderer: THREE.WebGLRenderer) {
  /** 模型 accessors 的包围盒：拍框外沿半宽、拍线区中心的 y */
  const GLB_FRAME_HALF_X = 0.128;
  const GLB_FACE_CY = 0.515;
  const sx = FACE_RX / GLB_FRAME_HALF_X;
  const sy = FACE_CY / GLB_FACE_CY;

  new GLTFLoader().load(
    `${import.meta.env.BASE_URL}models/racket.glb`,
    (gltf) => {
      // 石墨框 metallic 0.18 / roughness 0.34，在只有半球光+平行光的场景里会
      // 糊成一块死黑（金属没有环境可反射就等于黑色）。给球拍单独一张环境贴图，
      // 只赋给它的材质，不动 scene.environment——场地、球、墙的观感不该被换拍改掉。
      const pmrem = new THREE.PMREMGenerator(renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();

      const model = gltf.scene;
      model.scale.set(sx, sy, 1);
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const mat = m as THREE.MeshStandardMaterial;
          if ('envMap' in mat) {
            mat.envMap = env;
            mat.envMapIntensity = 0.6;
            mat.needsUpdate = true;
          }
        }
      });

      const fallback = racket.getObjectByName('racket-fallback');
      if (fallback) racket.remove(fallback);
      racket.add(model);
    },
    undefined,
    (err) => {
      console.warn('[racket] glb 加载失败，继续用程序化球拍', err);
    }
  );
}
