import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Quat } from '../core/imu';
import { type RacketPose } from '../core/racket';
import { SwingRig } from '../core/swing-rig';
import type { V3 } from '../core/vec';
import { BALL_RENDER_R, FACE_CY, RACKET_POS } from '../core/court';
import { buildCourt, buildHitStrip } from './meshes/court';
import { buildOpponent } from './meshes/opponent';
import { buildMembrane, buildRacketMesh, loadRacketModel } from './meshes/racket';

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

/**
 * 相机预设：**相对握点基座**的机位与视点（米）。
 *
 * 为什么做成预设而不是一个固定机位：玩家要的东西是互相矛盾的——看得清拍面
 * 就得贴近，看得见球场和来球就得退开。一张图给不出两个答案，所以给两档，
 * 按 `Z` 切（`scene.toggleCamera()`）。
 *
 * `near` 的取值是按「球拍在画面里的高度占比」定的：握点到相机约 2.2m，
 * 50° 竖直视角下画面高 2.0m，0.8m 长的拍子占 40%。改之前是 3.9m / 22%——
 * 拍面在整个画面里只有巴掌大，根本判断不了球会打在框上还是线上。
 *
 * 机位摆在握点右后方（+0.45 / +2.35），视点压到击球面前方 1.3m：这样球拍落在
 * 画面中间偏下、球道在它上方铺开，来球和拍面在同一个视野里。往上抬一点（视点 y
 * 1.0）会把练习墙顶切掉，往下压一点（1.35）会把蹲下接低球时的拍子切掉——
 * 1.2 是两头的折中，蹲到握点 0.7m、举到 1.65m 都还在画内。
 */
export interface CameraPreset {
  /** 机位，相对握点基座 (x, z) 的偏移；y 是绝对高度。 */
  cam: [number, number, number];
  /** 视点，同上。 */
  tgt: [number, number, number];
}

const CAMERA: Record<'near' | 'far', CameraPreset> = {
  // 近景用来盯对手的来球、看清球打在框上还是线上
  near: { cam: [0, 3.0, 4.3], tgt: [0, 1.05, -3.8] },
  // 全景能一眼看到两侧底线，对打默认用这一档
  far: { cam: [0, 4.2, 6.9], tgt: [0, 0.9, -10.8] },
};

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
  /** 玩家发球时高亮的发球区（半个区，斜对角那个） */
  private serveBoxMesh: THREE.Mesh | null = null;
  /** 拍面指向的地面落点圈。发球时它就是「这一拍会落在哪」 */
  private serveAimMesh: THREE.Mesh | null = null;
  private targetQ = new THREE.Quaternion();
  private smoothQ = new THREE.Quaternion();
  /**
   * 握点**基座** = 走位的目的地，球拍组原点的静止位置。
   *
   * 走路搬的是它；手机姿态只改朝向；挥拍时 `SwingRig` 再在这个基座上补一段弧，
   * 让握点绕腰/肘走过去而不是钉在原地转。三者叠起来才是 `RacketPose`——
   * 屏幕上看到的和判定用的是同一个 `position + quaternion`。
   */
  private base = new THREE.Vector3();
  /** 挥拍枢轴：腰 → 肘 → 腰。见 `core/swing-rig.ts`。 */
  private rig = new SwingRig();
  /** `G` 键 / `?rig=0` 关掉枢轴（真机 A/B 用）。 */
  private rigOn = true;
  /** 上一帧的平滑姿态，用来量手部角速度（切枢轴要用真实角速度，不能用平滑误差）。 */
  private lastSmoothQ = new THREE.Quaternion();
  /** 手部角速度（rad/s），低通一下再喂给枢轴，免得单帧噪声把腰/肘切来切去。 */
  private spinRad = 0;
  private camPreset: 'near' | 'far';
  /**
   * 球按自己的弹道飞，不会在飞行途中被改向去追拍面——回球机在出球那一刻就把
   * 落点定死了。挥拍时拍面扫出去的那段缺口由玩家自己对准，不再由球补偿。
   */
  private clock = new THREE.Clock();
  /**
   * 还没搬完的相机平移量（米）。`setRacketBase` 只往里加，`render` 每帧追一截。
   *
   * 为什么不让相机跟基座刚性绑定：那样每一帧的走位修正都会变成整屏平动，
   * 规划器偶尔改一次主意（4–8cm/帧）看起来就是视野猛抽一下。累积 + 指数追赶
   * 保住总位移不变（走多远跟多远），只把单帧突变摊薄。
   */
  private camLag = new THREE.Vector3();

  private fxPool: Fx[] = [];
  private fxFree: Fx[] = [];

  private racketGlow: THREE.PointLight;
  private glow = 0;
  private ballSpin: V3 = [0, 0, 0];

  /** 对手（脚本回球机）的球拍。 */
  private oppRacket: THREE.Group | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#f7f7f5');
    // 场地是「我这边 + 对面」两块拼起来的，雾的远端必须推到对手底线之外，
    // 否则整支对手拍子会被雾吃掉。
    this.scene.fog = new THREE.Fog('#f7f7f5', 22, 70);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 120);

    /** 走位给出的握点基座。球拍的实际位置 = 基座 + 挥拍枢轴（`SwingRig`）的弧。 */
    this.base.set(...RACKET_POS);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 32;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    // 机位由预设决定（见 CAMERA），`Z` 键在两档之间切；鼠标滚轮仍然可以微调
    this.camPreset = 'far';
    this.applyCamera();

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#d9d5c8', 1.4));
    const key = new THREE.DirectionalLight('#ffffff', 1.7);
    // 光源放得高一些，阴影才会落在球拍脚下而不是飘到别处
    key.position.set(0.8, 7, 1.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 16;
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    key.shadow.bias = -0.0008;
    // 球拍本来就悬在半空（它是一支虚拟球拍），阴影太重会看着像地上还有一支
    (key.shadow as any).intensity = 0.4;
    this.scene.add(key);

    buildCourt(this.scene);
    const opp = buildOpponent();
    this.scene.add(opp.group);
    this.oppRacket = opp.group;
    this.oppGlow = opp.glow;
    this.hitStrip = buildHitStrip();
    this.scene.add(this.hitStrip);

    this.racket = new THREE.Group();
    // 初始位姿 = 参考握法（恒等姿态）：握点在 RACKET_POS，拍面中心在它正上方 FACE_CY
    this.racket.position.set(...RACKET_POS);
    // 拍面那层极淡的薄膜挂在组上，不归某个模型管：它解决的是「拍面读不出来」，
    // 和用哪支拍子无关，换模型时不该跟着丢。
    this.racket.add(buildMembrane());
    // 先挂程序化球拍，glb 到了再换掉。33KB 的本地文件通常几十毫秒就到，
    // 但网络慢、路径挂了、或者哪天 assets 被清掉时，屏幕上不能没有球拍——
    // 「空手站在场上」会被当成游戏坏了，而其实判定还在正常工作。
    this.racket.add(buildRacketMesh());
    this.scene.add(this.racket);
    loadRacketModel(this.racket, this.renderer);

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

  private oppGlow: THREE.PointLight | null = null;

  /** 抄一份对手位姿给渲染。每帧调用，参数就是判定层用的那份 pose。 */
  syncOpponent(pose: RacketPose) {
    const g = this.oppRacket;
    if (!g) return;
    g.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    g.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
    if (this.oppGlow) {
      this.oppGlow.position.set(pose.pos[0], pose.pos[1] + FACE_CY, pose.pos[2]);
    }
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

  /**
   * 玩家发球时高亮目标发球区，其余时候传 null。
   *
   * 发球区是**斜对角**的那半个：从右区发到对面的右区。这件事只有画出来
   * 才看得懂——靠文字说「右区」没几个人能立刻对上。
   */
  setServeBox(box: { x0: number; x1: number; z0: number; z1: number } | null) {
    if (!box) {
      if (this.serveBoxMesh) this.serveBoxMesh.visible = false;
      return;
    }
    if (!this.serveBoxMesh) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          color: '#3aa07d',
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.005;
      mesh.visible = false;
      this.scene.add(mesh);
      this.serveBoxMesh = mesh;
    }
    const m = this.serveBoxMesh;
    m.visible = true;
    m.scale.set(Math.abs(box.x1 - box.x0), Math.abs(box.z1 - box.z0), 1);
    m.position.set((box.x0 + box.x1) / 2, 0.005, (box.z0 + box.z1) / 2);
  }

  /**
   * 拍面指向的地面落点。`inBox` 决定颜色：落在正确的发球区里是绿的，
   * 出区是红的——玩家在抛球之前就能看到自己瞄对了没有。
   */
  setServeAim(p: V3 | null, inBox: boolean) {
    if (!p) {
      if (this.serveAimMesh) this.serveAimMesh.visible = false;
      return;
    }
    if (!this.serveAimMesh) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.3, 0.42, 40),
        new THREE.MeshBasicMaterial({
          color: '#2f9e6f',
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.012;
      mesh.visible = false;
      this.scene.add(mesh);
      this.serveAimMesh = mesh;
    }
    const m = this.serveAimMesh;
    m.visible = true;
    m.position.set(p[0], 0.012, p[2]);
    (m.material as THREE.MeshBasicMaterial).color.set(inBox ? '#2f9e6f' : '#cf5b5b');
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

    // 手部**真实**角速度：相邻两帧平滑姿态的夹角 / dt。
    //
    // 上面那个 `spin` 是「平滑还差多少」，量纲上像角速度但差一个 τ 因子，
    // 慢速时几乎恒等于 0（平滑早就跟上了）。挥拍枢轴要用它切腰/肘：
    // 用 `spin` 的话，起势阶段（平滑已经贴住目标、但手真的在转）会被判成
    // 「没在动」而一直挂在腰上，正好和想要的相反。
    const rawSpin = this.lastSmoothQ.angleTo(this.smoothQ) / Math.max(dt, 1e-3);
    this.lastSmoothQ.copy(this.smoothQ);
    // τ=35ms 的短低通：够快（一次挥拍的中段只有 60–100ms），又能压掉单帧噪声
    this.spinRad += (Math.min(rawSpin, 80) - this.spinRad) * (1 - Math.exp(-dt / 0.035));

    // 挥拍枢轴：握点从基座上绕腰/肘走一段弧。
    //
    // 这一步之前，「挥拍」就是整支拍子绕握点转（拍柄底部当铰链），玩家反馈
    // 「不像真的挥拍」。现在握点自己也会走弧：慢速（起势、随挥）绕腰，
    // 快速（击球前一刻的肘部制动）绕肘——两段之间的切换由角速度决定，
    // 见 `core/swing-rig.ts`。姿态一个字节都没改，改的只是握点去哪。
    const rigPos = this.rigOn
      ? this.rig.update(
          [this.base.x, this.base.y, this.base.z],
          [this.smoothQ.x, this.smoothQ.y, this.smoothQ.z, this.smoothQ.w],
          this.spinRad,
          dt
        )
      : [this.base.x, this.base.y, this.base.z];
    this.racket.position.set(rigPos[0], rigPos[1], rigPos[2]);

    // 位姿就是「握点 + 手机姿态」。握点现在会随挥拍走弧，拍面中心随之扫出去。
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
   * 移动站位：搬的是**握点基座**。
   *
   * 只搬位置不动姿态：手机只给得出角度，挪位置是键盘/摇杆的事，
   * 两者必须分开，否则「举着手机往右倾」会同时想改朝向和位置。
   *
   * 挥拍那段弧不在这里——它是 `syncRacket` 每帧按姿态算的，基座上不加状态。
   */
  setRacketBase(x: number, y: number, z: number) {
    const dx = x - this.base.x;
    const dz = z - this.base.z;
    this.base.set(x, y, z);
    this.racketGlow.position.set(x, y, z);
    this.hitStrip.position.x = x;

    // 相机跟着平移同样距离，但**不在一帧里搬完**。
    //
    // 人的眼睛长在头上，走位时视野是跟着动的；相机不动的话，往边上走两步
    // 球拍就出画了，玩家会以为「拍子没了」而不是「我走开了」。只平移不转向，
    // 环视仍然由鼠标拖动控制，两者互不干扰。
    //
    // 但刚性跟随会把**每一帧的位置修正**都放大成整屏平动：规划器偶尔改一次主意
    // 就是 4–8cm/帧，画面上是视野猛地一抽（真机反馈的「有时还是会抖」）。
    // 这里只累积、不立即搬，由 `render` 用 τ=0.12s 追上去——总位移守恒（走多远
    // 相机就跟多远），单帧的突变被摊成几帧，视觉上是「跟着走」而不是「被拽」。
    this.camLag.x += dx;
    this.camLag.z += dz;
  }

  /** 按当前预设摆机位。机位是相对**基座**的，所以走位之后切档也不会跑到场外。 */
  private applyCamera() {
    const p = CAMERA[this.camPreset];
    // 换档是「重新摆机位」，不能还欠着上一段的追赶量，否则会多搬一次
    this.camLag.set(0, 0, 0);
    this.camera.position.set(
      this.base.x + p.cam[0],
      p.cam[1],
      this.base.z + p.cam[2]
    );
    this.controls.target.set(
      this.base.x + p.tgt[0],
      p.tgt[1],
      this.base.z + p.tgt[2]
    );
    this.controls.update();
  }

  /** `Z` 键：近景 ⇄ 全景。返回切换后的档位，给 HUD 提示用。 */
  toggleCamera(): 'near' | 'far' {
    this.camPreset = this.camPreset === 'near' ? 'far' : 'near';
    this.applyCamera();
    return this.camPreset;
  }

  /**
   * `G` 键 / `?rig=0`：挥拍枢轴开关。
   *
   * 关掉之后回到「握点钉死、整支拍子绕拍柄底部转」的老行为。留着这个开关是为了
   * 真机 A/B——枢轴是**平移**握点，它会不会让人更容易打空，只有手能回答。
   */
  setRigEnabled(on: boolean) {
    this.rigOn = on;
    if (!on) this.rig.reset();
  }

  /** 重连 / 换会话：挥拍枢轴的准备姿态必须重新学。 */
  resetRig() {
    this.rig.reset();
    this.lastSmoothQ.copy(this.targetQ);
    this.spinRad = 0;
  }

  render(frameDt?: number) {
    const dt = frameDt ?? this.clock.getDelta();

    // 相机追赶（见 `camLag`）。τ=0.12s：走到位的延迟肉眼看不出，
    // 但一帧 8cm 的突变会被摊成约 3 帧。残余不足 2mm 就一次搬完，否则会永远差一点。
    if (this.camLag.x !== 0 || this.camLag.z !== 0) {
      const k = 1 - Math.exp(-Math.max(dt, 0) / 0.12);
      let mx = this.camLag.x * k;
      let mz = this.camLag.z * k;
      if (Math.abs(this.camLag.x - mx) < 0.002) mx = this.camLag.x;
      if (Math.abs(this.camLag.z - mz) < 0.002) mz = this.camLag.z;
      this.camera.position.x += mx;
      this.camera.position.z += mz;
      this.controls.target.x += mx;
      this.controls.target.z += mz;
      this.camLag.x -= mx;
      this.camLag.z -= mz;
    }

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
