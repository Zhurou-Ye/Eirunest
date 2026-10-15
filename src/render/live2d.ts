import type { RigPose } from '../anim/rig';
import type { Appearance, Mood } from '../core/types';
import type { BodyPart, CharacterRenderer } from './renderer';
import { expressionFor, motionFor, type CharacterProfile } from '../core/profile';

/**
 * Live2D 渲染器（真实可用版）。
 *
 * 依赖按需加载：只有用户切到 Live2D 立绘时才会拉三个 vendor 脚本，
 * 默认的矢量立绘首屏不付这笔流量。
 *
 * 加载顺序有讲究：live2dcubismcore（专有运行时）必须先于 cubism4 插件，
 * 否则插件启动时找不到 Core 会静默失败。
 */

const VENDOR = {
  pixi: '/vendor/pixi.min.js',
  core: '/vendor/live2dcubismcore.min.js',
  cubism4: '/vendor/cubism4.min.js',
};

interface PIXIApp {
  stage: { addChild: (c: unknown) => void; removeChild: (c: unknown) => void };
  ticker: { add: (fn: (t: number) => void) => void };
  renderer: { resize: (w: number, h: number) => void; view: HTMLCanvasElement };
  destroy: (removeView?: boolean) => void;
}

type MatrixLike = {
  apply: (p: { x: number; y: number }, out?: { x: number; y: number }) => { x: number; y: number };
};
type BoundsLike = { x: number; y: number; width: number; height: number };

interface Live2DModelLike {
  x: number;
  y: number;
  scale: { set: (v: number) => void; x: number; y: number };
  anchor: { set: (x: number, y: number) => void; x: number; y: number };
  width: number;
  height: number;
  /** 屏幕坐标 → 模型局部坐标（PIXI DisplayObject 方法） */
  toLocal: (p: { x: number; y: number }) => { x: number; y: number };
  /** 命中模型自带 HitAreas，返回区域名数组。官方样例模型大多是空的 */
  hitTest: (x: number, y: number) => string[];
  hitAreas: Record<string, { index: number }>;
  /** PIXI 世界变换矩阵（模型局部 → 屏幕） */
  transform: { worldTransform: MatrixLike };
  internalModel: {
    coreModel: {
      setParameterValueById: (id: string, v: number) => void;
      getDrawableVertices?: (i: number) => Float32Array;
    };
    motionManager: { state: { currentGroup: string } };
    /** 模型自带 HitAreas（名 → {index}），如 Head/Body */
    hitAreas?: Record<string, { index: number }>;
    /** model 单位 → 模型局部坐标 */
    localTransform?: MatrixLike;
    /** drawable 在 model 坐标下的包围盒（实时，随动作变化） */
    getDrawableBounds?: (index: number, out: BoundsLike) => BoundsLike;
  };
  expression: (name: string) => Promise<void>;
  motion: (group: string, index?: number) => Promise<void>;
  destroy: () => void;
}

type Live2DFactory = {
  from: (url: string) => Promise<Live2DModelLike>;
};

type Live2DNamespace = {
  /** 工厂挂在 Live2DModel 上，不是命名空间根上 */
  Live2DModel: Live2DFactory;
};

type PIXIStatic = {
  Application: new (o: unknown) => PIXIApp;
  live2d: Live2DNamespace;
};

export interface Live2DStatus {
  loading: boolean;
  ready: boolean;
  error?: string;
}

export class Live2DCharacterRenderer implements CharacterRenderer {
  readonly kind = 'live2d';

  private profile: CharacterProfile;
  private app: PIXIApp | null = null;
  private model: Live2DModelLike | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;

  private currentExpression: string | undefined;
  private currentMotion: string | undefined;
  private blinkPhase = 0;
  private blinkValue = 1;

  /**
   * 人物在「模型包围盒」内的真实轮廓（归一化 0~1）。
   *
   * 为什么需要它：Live2D 模型的 bounds 里含大片透明留白 —— 实测 Haru 的
   * 人物只占水平 32%~68%、垂直 5%~94%，两侧 1/3 都是空的。
   * 直接按整包围盒分区，会把左右空白也当成「手」，点空处也触发牵手。
   *
   * 这个值在加载时用 extract 读一次 alpha 算出，与缩放无关（缩放不会改变
   * 人物在包围盒内的相对位置），所以只需测量一次。
   */
  private silhouette = { l: 0.32, r: 0.68, t: 0.05, b: 0.94 };

  /** 头部宽度占包围盒宽度的比例（实测）。各模型头身比差很多，配件按头宽缩放才准。 */
  private headWRatio = 0.22;

  status: Live2DStatus = { loading: false, ready: false };
  onStatusChange?: (s: Live2DStatus) => void;

  constructor(profile: CharacterProfile) {
    this.profile = profile;
  }

  /** 加载模型。失败返回 false，调用方应回退到矢量渲染器。 */
  async load(): Promise<boolean> {
    if (this.model) return true;
    this.setStatus({ loading: true, ready: false });

    try {
      await this.ensureVendor();

      const PIXI = (window as unknown as { PIXI?: PIXIStatic }).PIXI;
      const factory = PIXI?.live2d?.Live2DModel;
      if (!PIXI || !factory) {
        throw new Error('Live2D 运行时未就绪：请确认 vendor 三件套已放入 public/vendor/');
      }

      const spec = this.profile.renderer;
      const url = `/character/${spec.modelDir}/${spec.modelName}.model3.json`;

      // view 必须显式给 canvas；resizeTo 不能再给 canvas（会被当成 window 处理）
      this.app = new PIXI.Application({
        view: this.canvas ?? undefined,
        backgroundAlpha: 0,
        antialias: true,
        autoStart: true,
        // PIXI 7 的字段名是 devicePixelRatio + autoDensity
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      }) as unknown as PIXIApp;

      this.model = await factory.from(url);
      this.model.scale.set(spec.scale ?? 0.3);
      this.app.stage.addChild(this.model);
      this.layout();

      // pixi-live2d-display 不会自动播 Idle，必须显式启动，否则角色是僵的
      const firstMotion = motionFor(this.profile, 'idle');
      if (firstMotion) {
        this.playMotion(firstMotion.group, firstMotion.index);
      }
      this.currentMotion = 'idle';

      // 轮廓必须等 idle 姿态生效后再量：bind pose 手臂是张开的，量出来偏宽，
      // 会让两侧空白被误判成身体。延时一拍等动作把姿势摆成日常站姿。
      window.setTimeout(() => {
        if (this.model) {
          this.measureSilhouette();
          // 用实测轮廓重新落地：脚锚点跟着真实脚位走，地平线不变，角色就不会再悬空
          this.layout();
        }
      }, 600);

      this.setStatus({ loading: false, ready: true });
      return true;
    } catch (err) {
      // err 不一定是 Error 实例（PIXI 可能抛字符串或事件对象），统一兜住
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : (() => {
                try {
                  return JSON.stringify(err);
                } catch {
                  return '未知错误';
                }
              })();
      console.error('[live2d] 模型加载失败', err);
      this.setStatus({ loading: false, ready: false, error: message });
      return false;
    }
  }

  private async ensureVendor(): Promise<void> {
    // 顺序固定：core 必须在 cubism4 之前
    await injectScript(VENDOR.pixi);
    await injectScript(VENDOR.core);
    await injectScript(VENDOR.cubism4);
  }

  private setStatus(s: Live2DStatus): void {
    this.status = s;
    this.onStatusChange?.(s);
  }

  mount(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.app?.renderer.resize(w, h);
    this.layout();
  }

  /**
   * 按视口摆放模型。
   *
   * 关键：用**脚部锚点**而不是中心锚点。
   * Live2D 模型的包围盒底部一大截是透明留白，若用中心锚点把模型中心放在画面
   * 中线，角色的脚其实悬在半空——这就是之前"人浮在天上"的原因。
   * 改为 anchor.y = 人物脚在包围盒里的归一化位置（silhouette.b），再把模型 y
   * 钉在地面线 floorY，无论模型多大、缩放多少，脚都稳稳踩在地上。
   */
  private layout(): void {
    if (!this.model || !this.w || !this.h) return;
    const spec = this.profile.renderer;
    const fit = Math.min(1, this.h / 880);
    const base = (spec.scale ?? 0.13) * fit;
    this.model.scale.set(base);

    // 自动适配：不同模型原生尺寸差很多（Haru 内部高约 4500、Natori 约 7000），
    // 用固定 scale 会让大模型"顶穿"屏幕 —— 曾出现 Natori 整人飞到屏幕上方。
    // 这里按"人物可见身体高度占屏比例"反推缩放，任何模型都能整齐地站在地面上。
    const s = this.silhouette;
    const bodyRatio = Math.max(0.2, s.b - s.t);
    const h0 = this.model.height || 0;
    if (h0 > 0) {
      const targetBody = this.h * (spec.bodyHeightRatio ?? 0.76);
      this.model.scale.set(base * (targetBody / (bodyRatio * h0)));
    }

    this.model.anchor.set(0.5, s.b);
    this.model.x = this.w * (spec.xRatio ?? 0.42);
    // 地面线：脚底落点。horizon（墙地交线）在 0.62h，脚落在 0.86h 刚好站在地板上
    this.model.y = this.h * (spec.floorYRatio ?? 0.86);
  }

  /** 角色脚下在屏幕上的位置（用于画接触阴影）。锚点已是脚部，model.y 即脚底。 */
  charGround(): { x: number; y: number } | null {
    if (!this.model || !this.w || !this.h) return null;
    return { x: this.model.x, y: this.model.y };
  }

  /**
   * 各部位锚点（CSS 像素）+ 头宽，供配件叠加定位/缩放。
   * 关键是**用实测头宽**而不是固定比例——各模型头身比差很多（Haru 头大、
   * Natori 是高个子小头），固定比例会让帽子在 Natori 头上飘起来。
   * 头各部位的纵向位置都用"头高"推导（头高≈头宽/0.78）。
   */
  charAnchors(): {
    head: { x: number; y: number };
    face: { x: number; y: number };
    neck: { x: number; y: number };
    hand: { x: number; y: number };
    headW: number;
    bodyH: number;
  } | null {
    const m = this.model;
    if (!m || !this.w || !this.h) return null;
    const s = this.silhouette;
    const bodyH = (s.b - s.t) * m.height;

    const im = m.internalModel;
    const headIdx = im?.hitAreas?.Head?.index;
    const lt = im?.localTransform;
    const wt = m.transform?.worldTransform;

    let head: { x: number; y: number } | null = null;
    let face: { x: number; y: number } = { x: m.x, y: 0 };
    let neck: { x: number; y: number } = { x: m.x, y: 0 };
    let headW = 0;

    // 首选：模型自带 Head HitArea 的**实时**包围盒 → 屏幕坐标（随头部动作变化，配件"贴在脸上跟着动"）
    // 注意：getDrawableBounds 依赖 this，必须直接以 im 调用，不能拆出来单独引用。
    if (headIdx != null && headIdx >= 0 && im?.getDrawableBounds && lt && wt) {
      const b = im.getDrawableBounds(headIdx, { x: 0, y: 0, width: 0, height: 0 });
      const toScreen = (mx: number, my: number): { x: number; y: number } => {
        const local = lt.apply({ x: mx, y: my });
        return wt.apply(local);
      };
      const p1 = toScreen(b.x, b.y);
      const p2 = toScreen(b.x + b.width, b.y + b.height);
      const left = Math.min(p1.x, p2.x);
      const right = Math.max(p1.x, p2.x);
      const top = Math.min(p1.y, p2.y);
      const bottom = Math.max(p1.y, p2.y);
      const w = right - left;
      const h = bottom - top;
      if (w > 10 && h > 10) {
        const cx = (left + right) / 2;
        headW = w;
        head = { x: cx, y: top + h * 0.3 }; // 帽子：贴头顶
        face = { x: cx, y: top + h * 0.8 }; // 眼镜：眼睛一带
        neck = { x: cx, y: bottom + h * 0.08 }; // 围巾：脖子
      }
    }

    // 兜底：没有 Head HitArea 时用实测轮廓估算（不随头动，但位置/大小合理）
    if (!head) {
      const topY = m.y - bodyH;
      const hw = this.headWRatio * m.width;
      const hh = hw / 0.78;
      const x = m.x;
      headW = hw;
      head = { x, y: topY + hh * 0.42 };
      face = { x, y: topY + hh * 0.8 };
      neck = { x, y: topY + hh * 1.08 };
    }

    // 手持物锚点：身体中线、胸口高度
    const hand = { x: m.x, y: m.y - bodyH * 0.5 };
    return { head, face, neck, hand, headW, bodyH };
  }

  draw(pose: RigPose, appearance: Appearance, mood: Mood, timeSec: number): void {
    void appearance;
    if (!this.model) return;

    const cm = this.model.internalModel?.coreModel;
    if (!cm) return;

    // 眨眼：Live2D 模型多半自带眨眼动画，这里只在模型没有该参数时才接管
    this.blinkPhase += 1;
    if (this.blinkPhase > 150 + Math.random() * 40) this.blinkPhase = 0;
    this.blinkValue = this.blinkPhase < 12 ? 1 - this.blinkPhase / 12 : (this.blinkPhase - 12) / 138;

    const safe = (id: string, v: number) => {
      try {
        cm.setParameterValueById(id, v);
      } catch {
        /* 模型没有这个参数就跳过，不同模型参数集不同 */
      }
    };

    // 头部角度
    safe('ParamAngleX', pose.headYaw * 22);
    safe('ParamAngleY', -pose.headPitch * 18);
    safe('ParamAngleZ', pose.headYaw * 8);
    // 身体角度（躯干倾斜）
    safe('ParamBodyAngleX', pose.torsoTilt * 0.4);
    safe('ParamBodyAngleY', pose.torsoTilt * 0.25);
    // 视线
    safe('ParamEyeBallX', pose.gazeX);
    safe('ParamEyeBallY', pose.gazeY);
    // 眉毛
    safe('ParamBrowLY', (pose.browRaise - 0.3) * 0.6);
    safe('ParamBrowRY', (pose.browRaise - 0.3) * 0.6);
    // 嘴型：说话张嘴由口型驱动，不说话用微笑曲线
    safe('ParamMouthOpenY', pose.mouthOpen);
    safe('ParamMouthForm', pose.mouthSmile * 2 - 1);
    // 呼吸：模型自带的物理会叠加，这里只给一个轻量驱动
    safe('ParamBreath', Math.sin(timeSec * 1.6) * 0.5 + 0.5);

    // 眨眼接管：只在模型确实有参数时才写，否则会跟模型自带眨眼打架
    if (pose.eyeOpen < 0.95) {
      safe('ParamEyeLOpen', pose.eyeOpen * this.blinkValue);
      safe('ParamEyeROpen', pose.eyeOpen * this.blinkValue);
    }

    // 手臂：Mark 有 ParamArmL/R，Ren/Natori 是多段手臂，只有单段参数可写
    safe('ParamArmL', pose.armL / 60);
    safe('ParamArmR', pose.armR / 60);

    // 表情切换：同一表情不重复触发
    const want = expressionFor(this.profile, mood);
    if (want && want !== this.currentExpression) {
      this.currentExpression = want;
      void this.model.expression(want).catch(() => {
        /* 模型没有这个表情，忽略 */
      });
    } else if (!want && this.currentExpression) {
      this.currentExpression = undefined;
    }
  }

  /** 活动切换时播一次对应动作组 */
  syncActivity(activity: Parameters<typeof motionFor>[1]): void {
    if (!this.model) return;
    const key = String(activity);
    if (key === this.currentMotion) return;
    this.currentMotion = key;

    const spec = motionFor(this.profile, activity);
    if (!spec) return;
    this.playMotion(spec.group, spec.index);
  }

  /**
   * 播一个动作组，先把索引夹到模型实际拥有的范围内。
   *
   * 为什么必须夹：不同模型的同一动作组数量不同 —— Haru 的 Idle 有 2 个、
   * Natori 有 3 个，但 Mao 只有 1 个。resting / sleeping 在 profile 里映射到
   * Idle index 1，对 Mao 越界。pixi-live2d-display 的 startMotion 对越界索引
   * 是「返回 false」而非抛错，所以 .catch 兜不住，人物会僵在原地。
   * 这里在播放前夹一下，保证「换人设不崩、动作不丢」。
   *
   * definitions 是 pixi-live2d-display 内部的动作清单：{ [group]: MotionDef[] }。
   */
  private playMotion(group: string, index: number): void {
    const m = this.model;
    if (!m) return;
    const defs = (
      m as unknown as {
        internalModel?: { motionManager?: { definitions?: Record<string, unknown[]> } };
      }
    ).internalModel?.motionManager?.definitions;
    const list = defs?.[group];
    const count = Array.isArray(list) ? list.length : 0;
    if (count === 0) return; // 模型没有这个动作组
    const idx = Math.max(0, Math.min(index, count - 1));
    void m.motion(group, idx).catch(() => {
      /* 播放失败（资源缺失等）忽略 */
    });
  }

  /** 被摸头/收礼等一次性反馈时，播一个反应动作 */
  playReaction(): void {
    if (!this.model) return;
    this.playMotion('TapBody', 0);
  }

  /**
   * 精确触点判定。
   *
   * 第一层用模型自带的 HitAreas（Head / Body）拿准确边界 —— 这比按视口高度
   * 猜靠谱得多，模型转头、低头时边界会跟着变。
   * 第二层在命中区域内按相对位置细分：头部分上/中/下（摸头/戳脸），
   * 身体分左/中/右（牵手/戳肚子/靠一会）。
   *
   * hitTest 需要模型局部坐标，所以先把屏幕坐标转成模型坐标系。
   */
  /**
   * 触点判定。
   *
   * 说明：pixi-live2d-display 的 hitTest 依赖 internalModel.hitAreas，
   * 而官方样例模型的 HitArea 是「不可见辅助 drawable」，顶点读出来全是 0，
   * 所以这条精确路线走不通（试过，见 git 历史）。
   *
   * 现在的方案：用模型自身包围盒 + 固定人体比例分区。
   * 模型包围盒每帧都是准的（跟着姿势变），比例分区是常量，合起来足够
   * 支撑「摸头 / 戳脸 / 牵手 / 靠一会儿」这类交互，且实现简单可靠。
   *
   * 想做到像素级，需要模型自带正确配置的 HitArea（ArtMesh 而非辅助层），
   * 换自己的模型时可以在 Cubism 编辑器里配。
   */
  /** 用 extract 读一次模型 alpha，量出人物在包围盒内的真实轮廓。失败则保留默认值。 */
  private measureSilhouette(): void {
    const m = this.model;
    const renderer = (this.app as unknown as {
      renderer?: { extract?: { canvas?: (t: unknown) => HTMLCanvasElement } };
    })?.renderer;
    const extract = renderer?.extract;
    if (!m || !extract?.canvas) return;
    try {
      const src = extract.canvas(m);
      if (!src?.width || !src?.height) return;
      // 原图 2400×4500，getImageData 太吃内存；先缩到小图再读 alpha
      const W = 120;
      const H = Math.max(1, Math.round((W * src.height) / src.width));
      const small = document.createElement('canvas');
      small.width = W;
      small.height = H;
      const ctx = small.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(src, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data;
      let minX = W;
      let maxX = 0;
      let minY = H;
      let maxY = 0;
      // 逐行记录左右边界，用于估计"头部宽度"
      const rowL = new Int16Array(H).fill(W);
      const rowR = new Int16Array(H).fill(-1);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (data[(y * W + x) * 4 + 3] > 32) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (x < rowL[y]) rowL[y] = x;
            if (x > rowR[y]) rowR[y] = x;
          }
        }
      }
      if (maxX > minX && maxY > minY) {
        this.silhouette = { l: minX / W, r: maxX / W, t: minY / H, b: maxY / H };

        // 头部宽度：取最上方 16% 内容行里最宽的一行（含头发，足够代表头的横向尺寸）
        const contentH = maxY - minY;
        const headBand = minY + Math.max(4, Math.round(contentH * 0.16));
        let maxRowW = 0;
        for (let y = minY; y <= headBand && y < H; y++) {
          const w = rowR[y] - rowL[y];
          if (w > maxRowW) maxRowW = w;
        }
        if (maxRowW > 0) this.headWRatio = maxRowW / W;
      }
    } catch (err) {
      console.warn('[live2d] 轮廓测量失败，改用默认比例', err);
    }
  }

  hitTest(screenX: number, screenY: number): BodyPart | null {
    const m = this.model;
    if (!m || !this.w || !this.h) return null;

    // 注意：Live2DModel 的 width/height 已经是「缩放后」的屏幕尺寸
    // （= internalModel.width * scale），这里不能再乘 scale，否则会二次缩放。
    const bw = m.width;
    const bh = m.height;
    if (!bw || !bh) return null;
    const left = m.x - bw * m.anchor.x;
    const top = m.y - bh * m.anchor.y;

    // 归一化到包围盒
    const rx = (screenX - left) / bw;
    const ry = (screenY - top) / bh;

    // 先排除透明留白：不在人物轮廓带内就是没点到
    const s = this.silhouette;
    if (rx < s.l || rx > s.r || ry < s.t || ry > s.b) return null;

    // 映射到「人物自身」坐标 0~1
    const sx = (rx - s.l) / (s.r - s.l);
    const sy = (ry - s.t) / (s.b - s.t);

    // 头顶 -> 脸 -> 躯干 -> 腿（比例按实测人物站位标定）
    if (sy < 0.09) return 'head';
    if (sy < 0.19) return 'face';
    if (sy > 0.72) return 'leg';
    // 躯干两侧算手（人物本身只占中段，这里的 20% 是相对人物宽度）
    if (sx < 0.2 || sx > 0.8) return 'hand';
    return 'torso';
  }

  dispose(): void {
    this.model?.destroy();
    this.model = null;
    // 注意：不能传 removeView=true。那会把 canvas 从 DOM 里摘掉，
    // 之后再切回 Live2D 就找不到这个 canvas 了。
    this.app?.destroy(false);
    this.app = null;
    this.setStatus({ loading: false, ready: false });
  }
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`脚本加载失败: ${src}（请检查 public/vendor/ 下是否有该文件）`));
    document.head.appendChild(s);
  });
}
