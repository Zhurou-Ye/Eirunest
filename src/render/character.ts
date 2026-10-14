import type { RigPose } from '../anim/rig';
import type { Appearance, Mood } from '../core/types';
import type { BodyPart, CharacterRenderer } from './renderer';

/**
 * 程序化矢量角色渲染器。
 *
 * 这不是"贴一张静态图"，而是每一帧按 RigPose 的骨骼角度
 * 用 Canvas 路径重新绘制：呼吸起伏、眨眼、视线偏移、嘴型张口、
 * 手臂抬起、躯干倾斜都是真实计算出来的。
 *
 * 它的价值是零素材依赖 + 全平台一致，也作为 Live2D 之前的可玩版本。
 */

export class VectorCharacterRenderer implements CharacterRenderer {
  readonly kind = 'procedural-vector';

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;

  /** 角色基准锚点与缩放，每帧重算，供命中检测复用 */
  private metrics = { cx: 0, baseY: 0, scale: 1, headR: 0, shoulderY: 0, hipY: 0 };

  mount(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (this.canvas) {
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** 角色站位：画面偏左，留出右侧气泡与对话区 */
  private layout(appearance: Appearance, pose: RigPose) {
    // 整体尺寸按视口高度推，但整体上移，给底部操作区留出空间
    const scale = (this.h / 900) * appearance.height * pose.scale;
    const cx = this.w * 0.4;
    const baseY = this.h * 0.78;
    // 头身比控制在 1:5.5 左右，避免"大头娃娃"观感
    const bodyH = 250 * scale;
    const headR = 33 * scale;
    return {
      scale,
      cx,
      baseY,
      headR,
      hipY: baseY - bodyH * 0.5,
      shoulderY: baseY - bodyH * 0.84,
      torsoTop: baseY - bodyH * 0.84,
    };
  }

  /** 公开尺寸，供切换立绘时传递视口大小 */
  get viewWidth(): number {
    return this.w;
  }

  get viewHeight(): number {
    return this.h;
  }

  draw(pose: RigPose, appearance: Appearance, mood: Mood, timeSec: number): void {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.clearRect(0, 0, this.w, this.h);

    const L = this.layout(appearance, pose);
    const bob = pose.bodyOffsetY * L.scale;

    // 地面阴影：随高度和缩放变化，让角色"落地"
    this.drawShadow(ctx, L, pose);

    const tilt = pose.torsoTilt;

    ctx.save();
    ctx.translate(L.cx, L.baseY + bob);

    // 关键：平移之后坐标系原点已在脚下（baseY），
    // 下面的绘制函数都用局部坐标，所以要把绝对 y 换算成相对值。
    const local: typeof L = {
      ...L,
      shoulderY: L.shoulderY - L.baseY,
      hipY: L.hipY - L.baseY,
      baseY: 0,
    };

    // ── 腿 ──────────────────────────────
    this.drawLeg(ctx, -1, pose, local, appearance, timeSec);
    this.drawLeg(ctx, 1, pose, local, appearance, timeSec);

    // ── 躯干 ────────────────────────────
    ctx.save();
    ctx.rotate((tilt * Math.PI) / 180);
    this.drawTorso(ctx, pose, local, appearance);
    ctx.restore();

    // ── 手臂（在躯干之后画前景侧）────────
    this.drawArm(ctx, -1, pose, local, appearance, timeSec, false);
    this.drawArm(ctx, 1, pose, local, appearance, timeSec, true);

    // 头部中心应在肩线之上一个头半径处
    const headY = local.shoulderY - L.headR * 0.92;
    ctx.save();
    ctx.translate(0, headY);
    ctx.rotate((pose.headYaw * Math.PI) / 180);
    this.drawHead(ctx, pose, L, appearance, mood, timeSec);
    ctx.restore();

    ctx.restore();

    this.metrics = {
      cx: L.cx,
      baseY: L.baseY,
      scale: L.scale,
      headR: L.headR,
      shoulderY: L.shoulderY + bob,
      hipY: L.hipY + bob,
    };
  }

  private drawShadow(
    ctx: CanvasRenderingContext2D,
    L: ReturnType<VectorCharacterRenderer['layout']>,
    pose: RigPose,
  ): void {
    const w = 78 * L.scale * (0.9 + pose.scale * 0.1);
    const lift = Math.max(0, -pose.bodyOffsetY) * 0.12;
    ctx.save();
    ctx.globalAlpha = 0.16 + lift * 0.02;
    ctx.fillStyle = '#3b3226';
    ctx.beginPath();
    ctx.ellipse(L.cx, L.baseY + 6, w, 12 * L.scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawLeg(
    ctx: CanvasRenderingContext2D,
    side: -1 | 1,
    pose: RigPose,
    L: ReturnType<VectorCharacterRenderer['layout']>,
    appearance: Appearance,
    timeSec: number,
  ): void {
    const angle = (side < 0 ? pose.legL : pose.legR) * (Math.PI / 180);
    const hipX = side * 15 * L.scale;
    const legLen = L.baseY - L.hipY;
    const thigh = legLen * 0.5;

    ctx.save();
    ctx.translate(hipX, L.hipY);
    ctx.rotate(angle);

    // 腿（裤）
    ctx.fillStyle = '#3f4756';
    this.roundRect(ctx, -8 * L.scale, 0, 16 * L.scale, thigh + 6, 8 * L.scale);
    ctx.fill();

    // 小腿 + 鞋
    ctx.save();
    ctx.translate(0, thigh);
    const kneeBend = Math.sin(timeSec * 1.6 + (side < 0 ? 0 : 0.6)) * 0.5 + 0.5;
    ctx.rotate(kneeBend * 0.04);
    ctx.fillStyle = '#3f4756';
    this.roundRect(ctx, -7 * L.scale, 0, 14 * L.scale, thigh * 0.9, 7 * L.scale);
    ctx.fill();

    ctx.translate(0, thigh * 0.9);
    ctx.fillStyle = appearance.outfit === 'hoodie' ? '#2f3540' : '#4a4034';
    this.roundRect(ctx, -10 * L.scale, -2, 22 * L.scale, 12 * L.scale, 5 * L.scale);
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  private drawTorso(
    ctx: CanvasRenderingContext2D,
    pose: RigPose,
    L: ReturnType<VectorCharacterRenderer['layout']>,
    appearance: Appearance,
  ): void {
    const torsoW = 78 * L.scale;
    const torsoH = L.shoulderY - L.hipY;

    // 衣服
    // 衣服配色：保证与浅色墙面有足够对比，角色轮廓必须清晰
    const colors: Record<Appearance['outfit'], [string, string]> = {
      sweater: ['#8fa9c4', '#5d7a99'],
      hoodie: ['#4d5b6b', '#33404e'],
      shirt: ['#b8b0a0', '#8a8272'],
    };
    const [c1, c2] = colors[appearance.outfit];

    const grad = ctx.createLinearGradient(-torsoW / 2, 0, torsoW / 2, 0);
    grad.addColorStop(0, c2);
    grad.addColorStop(0.45, c1);
    grad.addColorStop(1, c2);

    ctx.fillStyle = grad;
    this.roundRect(
      ctx,
      -torsoW / 2,
      L.shoulderY,
      torsoW,
      torsoH + 8 * L.scale,
      16 * L.scale,
    );
    ctx.fill();

    // 领口
    ctx.fillStyle = appearance.skinTone;
    ctx.beginPath();
    ctx.ellipse(0, L.shoulderY + 2 * L.scale, 13 * L.scale, 7 * L.scale, 0, 0, Math.PI * 2);
    ctx.fill();

    // 腹部褶皱：随呼吸变化，呼吸时布料有收放
    ctx.strokeStyle = 'rgba(0,0,0,0.14)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 2; i++) {
      const y = L.shoulderY + torsoH * (0.45 + i * 0.22);
      const w = torsoW * (0.5 - i * 0.06) * (0.94 + (pose.breathPhase % 1) * 0.06);
      ctx.beginPath();
      ctx.moveTo(-w, y);
      ctx.quadraticCurveTo(0, y + 3, w, y);
      ctx.stroke();
    }

    // 衣摆阴影：让躯干有体积感，而不是一块平色
    const hem = ctx.createLinearGradient(0, L.shoulderY + torsoH * 0.7, 0, L.shoulderY + torsoH + 8);
    hem.addColorStop(0, 'rgba(0,0,0,0)');
    hem.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = hem;
    this.roundRect(ctx, -torsoW / 2, L.shoulderY + torsoH * 0.7, torsoW, torsoH * 0.3 + 8, 16 * L.scale);
    ctx.fill();
  }

  private drawArm(
    ctx: CanvasRenderingContext2D,
    side: -1 | 1,
    pose: RigPose,
    L: ReturnType<VectorCharacterRenderer['layout']>,
    appearance: Appearance,
    timeSec: number,
    front: boolean,
  ): void {
    const shoulderAngle = (side < 0 ? pose.armL : pose.armR) * (Math.PI / 180);
    const elbow = (side < 0 ? pose.elbowL : pose.elbowR) * (Math.PI / 180);
    const shoulderX = side * 30 * L.scale;
    const upperLen = 52 * L.scale;

    ctx.save();
    ctx.translate(shoulderX, L.shoulderY + 8 * L.scale);
    // 侧向外张
    ctx.rotate(shoulderAngle + side * 0.12);
    // 轻微摆动，避免手臂像棍子
    const sway = Math.sin(timeSec * 1.6 + (side < 0 ? 0 : 0.8)) * 0.02;
    ctx.rotate(sway);

    const sleeve =
      appearance.outfit === 'hoodie'
        ? '#3f4c5b'
        : appearance.outfit === 'sweater'
          ? '#6b87a5'
          : '#9a9284';
    const skin = appearance.skinTone;

    // 上臂（袖子）
    ctx.fillStyle = sleeve;
    this.roundRect(ctx, -9 * L.scale, 0, 18 * L.scale, upperLen, 9 * L.scale);
    ctx.fill();

    // 前臂
    ctx.save();
    ctx.translate(0, upperLen);
    ctx.rotate(elbow);
    ctx.fillStyle = sleeve;
    this.roundRect(ctx, -7.5 * L.scale, 0, 15 * L.scale, upperLen * 0.55, 7 * L.scale);
    ctx.fill();

    // 手
    ctx.translate(0, upperLen * 0.55);
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(0, 6 * L.scale, 9 * L.scale, 10.5 * L.scale, 0, 0, Math.PI * 2);
    ctx.fill();

    // 手指分界线
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = 0.8;
    for (let f = -1; f <= 1; f++) {
      ctx.beginPath();
      ctx.moveTo(f * 3.4 * L.scale, 8 * L.scale);
      ctx.lineTo(f * 3.9 * L.scale, 14 * L.scale);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
    void front;
  }

  private drawHead(
    ctx: CanvasRenderingContext2D,
    pose: RigPose,
    L: ReturnType<VectorCharacterRenderer['layout']>,
    appearance: Appearance,
    mood: Mood,
    timeSec: number,
  ): void {
    const r = L.headR;
    const pitch = (pose.headPitch * Math.PI) / 180;

    ctx.save();
    // 头部随俯仰做轻微 Y 缩放，模拟低头看东西
    ctx.scale(1, 1 - Math.abs(Math.sin(pitch)) * 0.08);

    // 脖子
    ctx.fillStyle = shade(appearance.skinTone, -12);
    ctx.fillRect(-r * 0.28, r * 0.55, r * 0.56, r * 0.55);

    // 后发（在脸后面）
    ctx.fillStyle = shade(appearance.hairColor, -18);
    this.drawHairBack(ctx, r, appearance);

    // 脸
    const faceGrad = ctx.createLinearGradient(0, -r, 0, r);
    faceGrad.addColorStop(0, shade(appearance.skinTone, 6));
    faceGrad.addColorStop(1, shade(appearance.skinTone, -10));
    ctx.fillStyle = faceGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.86, r, 0, 0, Math.PI * 2);
    ctx.fill();

    // 耳
    ctx.fillStyle = shade(appearance.skinTone, -6);
    ctx.beginPath();
    ctx.ellipse(-r * 0.85, r * 0.08, r * 0.11, r * 0.17, 0, 0, Math.PI * 2);
    ctx.ellipse(r * 0.85, r * 0.08, r * 0.11, r * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();

    this.drawEyes(ctx, pose, r, appearance);
    this.drawBrows(ctx, pose, r, appearance);
    this.drawMouth(ctx, pose, r, mood, timeSec);
    this.drawBlush(ctx, pose, r);
    this.drawNose(ctx, r);
    this.drawHairFront(ctx, r, appearance);

    ctx.restore();
  }

  private drawEyes(
    ctx: CanvasRenderingContext2D,
    pose: RigPose,
    r: number,
    appearance: Appearance,
  ): void {
    const open = Math.max(0.04, pose.eyeOpen);
    const eyeY = -r * 0.08;
    const eyeDX = r * 0.34;
    const eyeW = r * 0.2;
    const eyeH = r * 0.19 * open;

    for (const side of [-1, 1] as const) {
      const ex = side * eyeDX;

      // 眼白
      if (open > 0.14) {
        ctx.fillStyle = '#fbf7f2';
        ctx.beginPath();
        ctx.ellipse(ex, eyeY, eyeW, eyeH, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // 瞳孔：随 gaze 偏移，偏移量被眼白宽度限制，不会溢出眼眶
      const px = ex + pose.gazeX * eyeW * 0.42;
      const py = eyeY + pose.gazeY * eyeH * 0.42;
      const pr = Math.min(eyeW * 0.62, eyeH * 1.05);
      if (open > 0.1 && pr > 0.6) {
        ctx.fillStyle = appearance.eyeColor;
        ctx.beginPath();
        ctx.ellipse(px, py, pr, pr * 1.08, 0, 0, Math.PI * 2);
        ctx.fill();

        // 瞳孔中心深色
        ctx.fillStyle = 'rgba(20,14,10,0.82)';
        ctx.beginPath();
        ctx.ellipse(px, py, pr * 0.5, pr * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();

        // 高光：让眼神有神采
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.ellipse(px - pr * 0.32, py - pr * 0.36, pr * 0.26, pr * 0.22, 0, 0, Math.PI * 2);
        ctx.ellipse(px + pr * 0.28, py + pr * 0.2, pr * 0.13, pr * 0.11, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // 上眼线：闭眼时变成一条弯线
      ctx.strokeStyle = '#3a2f28';
      ctx.lineWidth = Math.max(1, r * 0.055);
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (open > 0.14) {
        ctx.moveTo(ex - eyeW, eyeY - eyeH * 0.55);
        ctx.quadraticCurveTo(ex, eyeY - eyeH * 1.5, ex + eyeW, eyeY - eyeH * 0.5);
      } else {
        ctx.moveTo(ex - eyeW, eyeY);
        ctx.quadraticCurveTo(ex, eyeY + r * 0.06, ex + eyeW, eyeY);
      }
      ctx.stroke();

      // 睫毛
      if (side === 1) {
        ctx.lineWidth = Math.max(0.8, r * 0.03);
        ctx.beginPath();
        ctx.moveTo(ex + eyeW * 0.9, eyeY - eyeH * 0.6);
        ctx.lineTo(ex + eyeW * 1.3, eyeY - eyeH * 0.95);
        ctx.stroke();
      }
    }
  }

  private drawBrows(
    ctx: CanvasRenderingContext2D,
    pose: RigPose,
    r: number,
    appearance: Appearance,
  ): void {
    const y = -r * 0.42 - pose.browRaise * r * 0.1;
    const tilt = (pose.browAngle * Math.PI) / 180;
    const w = r * 0.28;

    ctx.strokeStyle = shade(appearance.hairColor, -6);
    ctx.lineWidth = Math.max(1.4, r * 0.075);
    ctx.lineCap = 'round';

    for (const side of [-1, 1] as const) {
      const bx = side * r * 0.34;
      ctx.save();
      ctx.translate(bx, y);
      ctx.rotate(side * tilt);
      ctx.beginPath();
      ctx.moveTo(-w * 0.85, r * 0.03);
      ctx.quadraticCurveTo(0, -r * 0.07, w * 0.85, r * 0.01);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawMouth(
    ctx: CanvasRenderingContext2D,
    pose: RigPose,
    r: number,
    mood: Mood,
    timeSec: number,
  ): void {
    const my = r * 0.42;
    const mw = r * 0.26;
    const open = Math.max(0, Math.min(1, pose.mouthOpen));
    const smile = pose.mouthSmile;

    ctx.save();
    ctx.translate(0, my);

    if (open > 0.06) {
      // 张口：椭圆随口型开合，内部深色 + 一点舌色
      const h = r * 0.16 + open * r * 0.24;
      ctx.fillStyle = '#5c2f34';
      ctx.beginPath();
      ctx.ellipse(0, h * 0.35, mw * 0.78, h, 0, 0, Math.PI * 2);
      ctx.fill();

      // 下唇
      ctx.strokeStyle = '#a86a5c';
      ctx.lineWidth = r * 0.045;
      ctx.beginPath();
      ctx.ellipse(0, h * 0.42, mw * 0.78, h, 0, 0.15, Math.PI - 0.15);
      ctx.stroke();

      // 说话时的轻微抖动，让口型更活
      if (open > 0.3) {
        const jitter = Math.sin(timeSec * 26) * r * 0.012;
        ctx.translate(0, jitter);
      }
    } else {
      // 闭口：一笔弧线，笑时上扬、生气时下垂
      ctx.strokeStyle = '#7d4438';
      ctx.lineWidth = Math.max(1.4, r * 0.062);
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (mood === 'sulky') {
        ctx.moveTo(-mw * 0.8, r * 0.04);
        ctx.quadraticCurveTo(0, -r * 0.06, mw * 0.8, r * 0.04);
      } else {
        const depth = smile * r * 0.1;
        ctx.moveTo(-mw, 0);
        ctx.quadraticCurveTo(0, depth * 1.5, mw, 0);
      }
      ctx.stroke();

      // 下唇阴影
      ctx.strokeStyle = 'rgba(180,120,105,0.35)';
      ctx.lineWidth = r * 0.03;
      ctx.beginPath();
      ctx.moveTo(-mw * 0.5, r * 0.075);
      ctx.quadraticCurveTo(0, r * 0.1, mw * 0.5, r * 0.075);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawBlush(ctx: CanvasRenderingContext2D, pose: RigPose, r: number): void {
    if (pose.blush <= 0.03) return;
    ctx.save();
    ctx.globalAlpha = Math.min(0.75, pose.blush);
    ctx.fillStyle = '#f19a92';
    for (const side of [-1, 1] as const) {
      ctx.beginPath();
      ctx.ellipse(side * r * 0.56, r * 0.2, r * 0.19, r * 0.11, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawNose(ctx: CanvasRenderingContext2D, r: number): void {
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = Math.max(1, r * 0.04);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(r * 0.04, r * 0.06);
    ctx.lineTo(r * 0.1, r * 0.2);
    ctx.stroke();
  }

  private drawHairBack(
    ctx: CanvasRenderingContext2D,
    r: number,
    appearance: Appearance,
  ): void {
    ctx.fillStyle = shade(appearance.hairColor, -22);
    ctx.beginPath();
    if (appearance.hairStyle === 'ponytail') {
      ctx.ellipse(0, -r * 0.1, r * 0.98, r * 1.06, 0, 0, Math.PI * 2);
      // 扎起的马尾
      ctx.moveTo(-r * 0.8, -r * 0.5);
      ctx.quadraticCurveTo(-r * 1.7, -r * 0.1, -r * 1.35, r * 0.75);
      ctx.quadraticCurveTo(-r * 1.05, r * 0.2, -r * 0.72, -r * 0.15);
      ctx.fill();
    } else if (appearance.hairStyle === 'messy') {
      // 碎发轮廓
      ctx.moveTo(-r * 1.02, r * 0.1);
      ctx.lineTo(-r * 1.08, -r * 0.5);
      ctx.lineTo(-r * 0.55, -r * 0.92);
      ctx.lineTo(-r * 0.1, -r * 1.15);
      ctx.lineTo(r * 0.35, -r * 0.98);
      ctx.lineTo(r * 0.85, -r * 1.02);
      ctx.lineTo(r * 1.08, -r * 0.45);
      ctx.lineTo(r * 1.0, r * 0.15);
      ctx.lineTo(r * 0.7, -r * 0.35);
      ctx.lineTo(-r * 0.7, -r * 0.3);
      ctx.closePath();
    } else {
      ctx.ellipse(0, -r * 0.08, r * 0.95, r * 1.04, 0, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  private drawHairFront(
    ctx: CanvasRenderingContext2D,
    r: number,
    appearance: Appearance,
  ): void {
    const c = shade(appearance.hairColor, 8);
    ctx.fillStyle = c;

    // 刘海：三种发型三种形状
    ctx.beginPath();
    if (appearance.hairStyle === 'messy') {
      ctx.moveTo(-r * 0.9, -r * 0.28);
      ctx.lineTo(-r * 0.72, -r * 0.92);
      ctx.lineTo(-r * 0.2, -r * 1.06);
      ctx.lineTo(r * 0.3, -r * 0.98);
      ctx.lineTo(r * 0.82, -r * 0.8);
      ctx.lineTo(r * 0.92, -r * 0.2);
      // 锯齿状发梢
      ctx.lineTo(r * 0.62, -r * 0.42);
      ctx.lineTo(r * 0.44, -r * 0.1);
      ctx.lineTo(r * 0.2, -r * 0.46);
      ctx.lineTo(-r * 0.06, -r * 0.14);
      ctx.lineTo(-r * 0.34, -r * 0.5);
      ctx.lineTo(-r * 0.56, -r * 0.16);
      ctx.closePath();
    } else if (appearance.hairStyle === 'ponytail') {
      ctx.moveTo(-r * 0.92, -r * 0.42);
      ctx.quadraticCurveTo(-r * 0.5, -r * 1.12, r * 0.4, -r * 0.95);
      ctx.quadraticCurveTo(r * 0.9, -r * 0.82, r * 0.92, -r * 0.34);
      ctx.quadraticCurveTo(r * 0.5, -r * 0.72, r * 0.1, -r * 0.6);
      ctx.quadraticCurveTo(-r * 0.4, -r * 0.5, -r * 0.92, -r * 0.42);
      ctx.closePath();
    } else {
      ctx.moveTo(-r * 0.94, -r * 0.36);
      ctx.quadraticCurveTo(-r * 0.86, -r * 1.05, 0, -r * 1.02);
      ctx.quadraticCurveTo(r * 0.86, -r * 1.05, r * 0.94, -r * 0.36);
      ctx.quadraticCurveTo(r * 0.55, -r * 0.6, r * 0.18, -r * 0.5);
      ctx.quadraticCurveTo(-r * 0.2, -r * 0.42, -r * 0.5, -r * 0.58);
      ctx.quadraticCurveTo(-r * 0.75, -r * 0.7, -r * 0.94, -r * 0.36);
      ctx.closePath();
    }
    ctx.fill();

    // 高光：一条斜向发丝反光
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.moveTo(-r * 0.42, -r * 0.86);
    ctx.quadraticCurveTo(-r * 0.05, -r * 0.96, r * 0.32, -r * 0.84);
    ctx.quadraticCurveTo(0, -r * 0.88, -r * 0.42, -r * 0.86);
    ctx.fill();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  hitTest(x: number, y: number): BodyPart | null {
    const m = this.metrics;
    const dx = x - m.cx;
    const headCY = m.shoulderY - m.headR * 0.92;

    if (Math.hypot(dx, (y - headCY) * 1.05) < m.headR * 0.95) {
      // 上半脸是 face，下半脸与下巴是 head（摸头区）
      return y < headCY - m.headR * 0.05 ? 'face' : 'head';
    }
    if (y > m.shoulderY - 10 && y < m.hipY + 14) {
      return Math.abs(dx) > m.scale * 34 ? 'hand' : 'torso';
    }
    if (y >= m.hipY && y <= m.baseY + 14) return 'leg';
    return null;
  }

  dispose(): void {
    this.canvas = null;
    this.ctx = null;
  }
}

function shade(hex: string, amt: number): string {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return `rgb(${r},${g},${b})`;
}