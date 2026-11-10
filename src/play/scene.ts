import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Quat } from '../core/imu';
import { type RacketPose } from '../core/racket';
import type { V3 } from '../core/vec';
import {
  HALF_WIDTH,
  BASELINE_Z,
  NET_Z,
  SERVICE_Z,
  WALL_Z,
  WALL_H,
  BALL_RENDER_R,
  HIT_Z,
  FACE_CY,
  FACE_RX,
  FACE_RY,
  RACKET_POS,
} from '../core/court';

/** 屏幕上的特效（击球冲击环、落点圈）。用一个很小的对象池，避免每拍都新建几何体。 */
interface Fx {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  fromScale: number;
  toScale: number;
  rise: number;
  flat: boolean;
}

const TRAIL_LEN = 20;
const TMP_AXIS = new THREE.Vector3();

export class PlayScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private racket: THREE.Group;
  private ball: THREE.Mesh;
  private trail: THREE.Line;
  private trailPos: Float32Array;
  private trailCount = 0;

  /** 地面上的击球面提示条，跟着站位走 */
  private hitStrip!: THREE.Mesh;
  private targetQ = new THREE.Quaternion();
  private smoothQ = new THREE.Quaternion();
  /**
   * 握点 = 球拍 Group 的原点，也是「手」的位置。
   *
   * 走位搬它，手机姿态只改它的**朝向**（`racket.quaternion`）。
   * 于是拍面中心在挥拍时会绕握点扫出去——这正是真实挥拍的样子，
   * 屏幕上看到的和判定用的是同一个 `position + quaternion`。
   *
   * 球按自己的弹道飞，不会在飞行途中被改向去追拍面；喂球只在落地弹起
   * 那一刻瞄一次（`Rally.aimArrival`）。挥拍时拍面扫出去的那段缺口由玩家
   * 自己对准，不再由球补偿。
   */
  private clock = new THREE.Clock();

  private fxPool: Fx[] = [];
  private fxFree: Fx[] = [];

  private racketGlow: THREE.PointLight;
  private glow = 0;
  private ballSpin: V3 = [0, 0, 0];

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#f7f7f5');
    this.scene.fog = new THREE.Fog('#f7f7f5', 14, 34);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 120);
    this.camera.position.set(2.0, 2.3, 3.4);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 1.0, -3.6);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 9;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#d9d5c8', 1.4));
    const key = new THREE.DirectionalLight('#ffffff', 1.7);
    // 光源放得高一些，阴影才会落在球拍脚下而不是飘到别处
    key.position.set(0.8, 7, 1.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 16;
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -3;
    key.shadow.bias = -0.0008;
    // 球拍本来就悬在半空（它是一支虚拟球拍），阴影太重会看着像地上还有一支
    (key.shadow as any).intensity = 0.4;
    this.scene.add(key);

    this.buildGround();
    this.buildWall();
    this.buildHitZone();

    this.racket = new THREE.Group();
    // 初始位姿 = 参考握法（恒等姿态）：握点在 RACKET_POS，拍面中心在它正上方 FACE_CY
    this.racket.position.set(...RACKET_POS);
    // 拍面那层极淡的薄膜挂在组上，不归某个模型管：它解决的是「拍面读不出来」，
    // 和用哪支拍子无关，换模型时不该跟着丢。
    this.racket.add(this.buildMembrane());
    // 先挂程序化球拍，glb 到了再换掉。33KB 的本地文件通常几十毫秒就到，
    // 但网络慢、路径挂了、或者哪天 assets 被清掉时，屏幕上不能没有球拍——
    // 「空手站在场上」会被当成游戏坏了，而其实判定还在正常工作。
    this.racket.add(this.buildRacket());
    this.scene.add(this.racket);
    this.loadRacketModel();

    this.racketGlow = new THREE.PointLight('#ffd9a0', 0, 3.2);
    this.racketGlow.position.set(...RACKET_POS);
    this.scene.add(this.racketGlow);

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RENDER_R, 24, 18),
      new THREE.MeshStandardMaterial({ color: '#d8c93f', roughness: 0.85 })
    );
    this.ball.castShadow = true;
    this.ball.position.set(0, BALL_RENDER_R, -6);
    this.scene.add(this.ball);

    // 拖尾：一颗真实大小的网球在 12 米外只有几个像素，不画拖尾根本看不见球在哪
    this.trailPos = new Float32Array(TRAIL_LEN * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    tg.setDrawRange(0, 0);
    this.trail = new THREE.Line(
      tg,
      new THREE.LineBasicMaterial({ color: '#e8c53a', transparent: true, opacity: 0.55 })
    );
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  /* ---------------- 静态场景 ---------------- */

  private buildGround() {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 90),
      new THREE.MeshStandardMaterial({ color: '#d5dcd3', roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const lineMat = new THREE.MeshStandardMaterial({ color: '#fbfbf8', roughness: 0.9 });
    const seg = (x1: number, z1: number, x2: number, z2: number, w = 0.06) => {
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz) + w;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, 0.004, w), lineMat);
      mesh.position.set((x1 + x2) / 2, 0.003, (z1 + z2) / 2);
      mesh.rotation.y = Math.atan2(-dz, dx);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    };

    const W = HALF_WIDTH;
    seg(-W, BASELINE_Z, W, BASELINE_Z, 0.08); // 底线
    seg(-W, BASELINE_Z, -W, NET_Z); // 单打边线
    seg(W, BASELINE_Z, W, NET_Z);
    seg(-W, SERVICE_Z, W, SERVICE_Z, 0.05); // 发球线
    seg(0, SERVICE_Z, 0, NET_Z, 0.05); // 中央发球线
    seg(-0.16, BASELINE_Z, 0.16, BASELINE_Z, 0.09); // 中点标记

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
    this.scene.add(net);

    const band = new THREE.Mesh(
      new THREE.BoxGeometry(W * 2 + 0.1, 0.06, 0.025),
      new THREE.MeshStandardMaterial({ color: '#fbfbf8', roughness: 0.8 })
    );
    band.position.set(0, 0.9, NET_Z);
    this.scene.add(band);

    const postMat = new THREE.MeshStandardMaterial({ color: '#9aa198', roughness: 0.7 });
    for (const px of [-W - 0.05, W + 0.05]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.07, 12), postMat);
      post.position.set(px, 0.535, NET_Z);
      post.castShadow = true;
      this.scene.add(post);
    }
  }

  /** 对面的练习墙。必须画出来，否则玩家不知道球为什么会在那里弹回来。 */
  private buildWall() {
    const w = HALF_WIDTH * 2 + 1.2;

    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const cx = c.getContext('2d')!;
    cx.fillStyle = '#cfd4cb';
    cx.fillRect(0, 0, 256, 128);
    cx.strokeStyle = 'rgba(255,255,255,0.55)';
    cx.lineWidth = 2;
    for (let i = 0; i <= 256; i += 32) {
      cx.beginPath();
      cx.moveTo(i, 0);
      cx.lineTo(i, 128);
      cx.stroke();
    }
    for (let j = 0; j <= 128; j += 32) {
      cx.beginPath();
      cx.moveTo(0, j);
      cx.lineTo(256, j);
      cx.stroke();
    }
    // 一条横贯的目标带，给「打高一点」一个视觉参照
    cx.fillStyle = 'rgba(22,110,86,0.22)';
    cx.fillRect(0, 128 - 78, 256, 26);

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 1);
    tex.anisotropy = 4;

    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(w, WALL_H),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 })
    );
    wall.position.set(0, WALL_H / 2, WALL_Z);
    wall.receiveShadow = true;
    this.scene.add(wall);

    const top = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.08, 0.08),
      new THREE.MeshStandardMaterial({ color: '#eef0ec', roughness: 0.8 })
    );
    top.position.set(0, WALL_H, WALL_Z);
    this.scene.add(top);
  }

  /**
   * 击球面：地上一条浅色横线，告诉玩家「球到这条线就该出手了」。
   *
   * 宽度跟着拍面走（约 1.4 个拍面宽），并且**跟着站位移动**。
   * 原来画的是 2.9 米（旧击球框宽度），那还是「整条线都能打」时代的提示，
   * 现在可击球面积只有 30cm 宽——画这么长等于在骗人往边上站。
   */
  private buildHitZone() {
    const mat = new THREE.MeshBasicMaterial({
      color: '#3aa07d',
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    this.hitStrip = new THREE.Mesh(new THREE.PlaneGeometry(FACE_RX * 2.8, 0.16), mat);
    this.hitStrip.rotation.x = -Math.PI / 2;
    this.hitStrip.position.set(0, 0.004, HIT_Z);
    this.scene.add(this.hitStrip);
  }

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
  private buildRacket(): THREE.Group {
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
  private buildMembrane(): THREE.Mesh {
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
   * 换上 assets 里的 glb 球拍（`低面数网球拍.glb`，1372 三角面，无贴图）。
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
  private loadRacketModel() {
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
        const pmrem = new THREE.PMREMGenerator(this.renderer);
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

        const fallback = this.racket.getObjectByName('racket-fallback');
        if (fallback) this.racket.remove(fallback);
        this.racket.add(model);
      },
      undefined,
      (err) => {
        console.warn('[racket] glb 加载失败，继续用程序化球拍', err);
      }
    );
  }

  /* ---------------- 运行时 ---------------- */

  /** 传入球拍端算好的四元数（x,y,z,w）。 */
  setOrientation(q: Quat) {
    this.targetQ.set(q[0], q[1], q[2], q[3]).normalize();
  }

  /** 传入球的物理位置与旋转（rad/s），视觉上让球真的在转。 */
  setBall(p: V3, spin: V3) {
    this.ball.position.set(p[0], p[1], p[2]);
    this.ballSpin = spin;
  }

  /** 球穿过击球面时的冲击环。 */
  spawnHitFx(p: V3, charge: number) {
    const fx = this.takeFx('#3aa07d');
    if (!fx) return;
    fx.mesh.position.set(p[0], p[1], p[2]);
    fx.mesh.lookAt(this.camera.position);
    fx.fromScale = 0.12 + charge * 0.1;
    fx.toScale = 1.5 + charge * 2.2;
    fx.life = 0.34;
    fx.flat = false;
    fx.rise = 0;
    this.glow = 0.5 + charge * 1.6;
  }

  /**
   * 检测到挥拍（此时还不知道有没有打到球）就让球拍亮一下。
   *
   * 这不是装饰：它把「没识别到我在挥」和「识别到了但没打中」在视觉上分开了。
   * 打不到球的时候，这一下有没有亮，直接决定了该去查传感器还是查击球判定。
   */
  pulseSwing() {
    this.glow = Math.max(this.glow, 0.9);
  }

  /** 落地圈：贴地扩散。 */
  spawnBounceFx(p: V3) {
    const fx = this.takeFx('#8a8f86');
    if (!fx) return;
    fx.mesh.position.set(p[0], 0.006, p[2]);
    fx.mesh.rotation.set(-Math.PI / 2, 0, 0);
    fx.fromScale = 0.05;
    fx.toScale = 0.55;
    fx.life = 0.5;
    fx.flat = true;
    fx.rise = 0;
  }

  private takeFx(color: string): Fx | null {
    let fx = this.fxFree.pop();
    if (!fx) {
      if (this.fxPool.length >= 14) return null;
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.7, 1, 32),
        new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false })
      );
      mesh.visible = false;
      this.scene.add(mesh);
      fx = { mesh, age: 0, life: 1, fromScale: 1, toScale: 1, rise: 0, flat: false };
      this.fxPool.push(fx);
    }
    (fx.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    fx.mesh.visible = true;
    fx.age = 0;
    return fx;
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 推进球拍的姿态平滑，返回这一帧球拍的世界位姿。
   *
   * 为什么要从 render() 里拆出来：击球判定需要知道「球拍此刻在哪、朝哪」，
   * 而 render() 还要用本帧的球位置。顺序必须是 平滑球拍 → 物理判定 → 渲染球，
   * 全塞在 render 里的话判定只能拿到上一帧的姿态，快速挥拍时会偏几十度。
   */
  syncRacket(now: number, dt: number): RacketPose {
    // 姿态跟手程度按「这一刻转得多快」自适应。
    //
    // 固定 22ms 的一阶低通在慢速时是纯收益（压掉传感器抖动），但快速挥拍时有两个
    // 代价：相位滞后约 τ（22ms），以及峰值被削掉 1/√(1+(ωτ)²)。挥得越快，
    // 屏幕上的拍子越「跟不上手」——这是击球判定之外剩下的主要延迟感。
    //
    // 等效角速度超过 12 rad/s（约 690°/s，正常挥拍中段）时几乎不平滑，拍子完全跟手；
    // 静止和微动时仍然用 22ms，传感器噪声不会漏出来。快速挥拍时人眼本来就看不清细节，
    // 少了平滑也看不出抖。
    const spin = this.smoothQ.angleTo(this.targetQ) / Math.max(dt, 1e-3);
    const tau = spin > 12 ? 0.003 : spin > 4 ? 0.01 : 0.022;
    const k = 1 - Math.exp(-dt / tau);
    this.smoothQ.slerp(this.targetQ, k);

    // 位姿就是「握点 + 手机姿态」：拍面中心挂在 0.6m 的杆子末端，挥拍时随之扫出去。
    //
    // 曾经为了让「挥拍时球一定在拍面上」把拍面中心锚死在空间里（旋转只改朝向），
    // 但那样屏幕上拍子除了转一点平移都没有，根本不像在挥拍。位置交给握点，
    // 球按物理弹道飞行、只在落地弹起时瞄一次，挥拍的缺口由玩家自己对准。
    const p = this.racket.position;
    const pose: RacketPose = {
      t: now,
      pos: [p.x, p.y, p.z],
      q: [this.smoothQ.x, this.smoothQ.y, this.smoothQ.z, this.smoothQ.w],
    };
    // 渲染用的四元数就是这份，判定拿到的也是这份——两者绝不能是两次独立平滑的结果
    this.racket.quaternion.copy(this.smoothQ);
    return pose;
  }

  /**
   * 移动站位：搬的是**握点**（球拍 Group 的原点）。
   *
   * 只搬位置不动姿态：手机只给得出角度，挪位置是键盘/摇杆的事，
   * 两者必须分开，否则「举着手机往右倾」会同时想改朝向和位置。
   */
  setRacketBase(x: number, y: number, z: number) {
    const dx = x - this.racket.position.x;
    const dz = z - this.racket.position.z;
    this.racket.position.set(x, y, z);
    this.racketGlow.position.set(x, y, z);
    this.hitStrip.position.x = x;

    // 相机跟着平移同样距离。
    // 人的眼睛长在头上，走位时视野是跟着动的；相机不动的话，往边上走两步
    // 球拍就出画了，玩家会以为「拍子没了」而不是「我走开了」。
    // 只平移不转向，环视仍然由鼠标拖动控制，两者互不干扰。
    if (dx !== 0 || dz !== 0) {
      this.camera.position.x += dx;
      this.camera.position.z += dz;
      this.controls.target.x += dx;
      this.controls.target.z += dz;
    }
  }

  render(frameDt?: number) {
    const dt = frameDt ?? this.clock.getDelta();

    // 拖尾：只保留最近 20 个位置
    if (this.trailCount < TRAIL_LEN) {
      this.trailCount++;
    } else {
      this.trailPos.copyWithin(0, 3);
    }
    const base = (this.trailCount - 1) * 3;
    this.trailPos[base] = this.ball.position.x;
    this.trailPos[base + 1] = this.ball.position.y;
    this.trailPos[base + 2] = this.ball.position.z;
    const geo = this.trail.geometry;
    geo.setDrawRange(0, this.trailCount);
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    // 让球真的转起来：上旋和下旋看球的转动方向就能区分，这是旋转唯一的视觉线索
    const spinRate = Math.hypot(this.ballSpin[0], this.ballSpin[1], this.ballSpin[2]);
    if (spinRate > 20) {
      const ax = this.ballSpin[0] / spinRate;
      const ay = this.ballSpin[1] / spinRate;
      const az = this.ballSpin[2] / spinRate;
      this.ball.rotateOnWorldAxis(TMP_AXIS.set(ax, ay, az), spinRate * dt);
    }

    // 击球瞬间让球拍亮一下，配合音效给「打中了」的即时反馈
    this.glow *= Math.exp(-dt / 0.12);
    this.racketGlow.intensity = this.glow;

    for (const fx of this.fxPool) {
      if (!fx.mesh.visible) continue;
      fx.age += dt;
      const t = fx.age / fx.life;
      if (t >= 1) {
        fx.mesh.visible = false;
        this.fxFree.push(fx);
        continue;
      }
      const s = fx.fromScale + (fx.toScale - fx.fromScale) * t;
      fx.mesh.scale.setScalar(s);
      (fx.mesh.material as THREE.MeshBasicMaterial).opacity = fx.flat ? 0.45 * (1 - t) : 0.8 * (1 - t) ** 2;
      if (fx.rise) fx.mesh.position.y += fx.rise * dt;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
