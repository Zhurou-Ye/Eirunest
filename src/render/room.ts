import type { DayPhase, RoomState } from '../core/types';

/**
 * 小屋场景渲染。
 * 纯 Canvas 绘制，不依赖任何位图素材。
 *
 * 视觉升级要点（这一版相比初版）：
 *  - 木地板带透视板缝 + 窗光反射，不再是纯色块
 *  - 家具都补了落地阴影，物件"压得住"地面
 *  - 墙上挂了一只钟，指针跟随真实时间（和顶部时钟一致）
 *  - 加了绿植、墙上相框、床头小物，房间有生活感
 *  - 角色脚下有接触阴影（由 game 传入脚底坐标），人不再"飘"
 */

interface Palette {
  wallTop: string;
  wallBottom: string;
  wainscot: string;
  baseboard: string;
  floorTop: string;
  floorBottom: string;
  plank: string;
  floorSheen: string;
  light: string;
  lightAlpha: number;
  ambient: number;
  sky: string;
  skyLow: string;
}

const PHASE_LOOK: Record<DayPhase, Palette> = {
  morning: {
    wallTop: '#f6ead9',
    wallBottom: '#ead8c2',
    wainscot: '#e2cdb2',
    baseboard: '#cbb191',
    floorTop: '#cba078',
    floorBottom: '#b98a5f',
    plank: 'rgba(120,84,52,0.25)',
    floorSheen: 'rgba(255,238,205,0.20)',
    light: '#fff2d2',
    lightAlpha: 0.36,
    ambient: 1,
    sky: '#cfe6f4',
    skyLow: '#e8f3f4',
  },
  noon: {
    wallTop: '#fdf3e4',
    wallBottom: '#f0e1cc',
    wainscot: '#ead8bd',
    baseboard: '#d3ba99',
    floorTop: '#d7b085',
    floorBottom: '#c69a6d',
    plank: 'rgba(120,84,52,0.22)',
    floorSheen: 'rgba(255,244,216,0.26)',
    light: '#fffbe8',
    lightAlpha: 0.22,
    ambient: 1,
    sky: '#e3f2fb',
    skyLow: '#f4fbfd',
  },
  evening: {
    wallTop: '#eccdb0',
    wallBottom: '#d7ad8b',
    wainscot: '#c99b76',
    baseboard: '#ad7f5c',
    floorTop: '#a97f5c',
    floorBottom: '#93674a',
    plank: 'rgba(80,50,32,0.30)',
    floorSheen: 'rgba(255,196,140,0.22)',
    light: '#ffb877',
    lightAlpha: 0.42,
    ambient: 0.84,
    sky: '#f6bd8d',
    skyLow: '#f2a06e',
  },
  night: {
    wallTop: '#3b4159',
    wallBottom: '#2c3145',
    wainscot: '#343a51',
    baseboard: '#272b3d',
    floorTop: '#5b463a',
    floorBottom: '#463328',
    plank: 'rgba(20,14,10,0.35)',
    floorSheen: 'rgba(150,170,220,0.10)',
    light: '#9fb4e8',
    lightAlpha: 0.16,
    ambient: 0.5,
    sky: '#1d2438',
    skyLow: '#141a2b',
  },
};

export class RoomRenderer {
  private ctx: CanvasRenderingContext2D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private lampFlicker = 0;

  mount(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const c = this.canvas;
    if (c) {
      c.width = Math.floor(w * this.dpr);
      c.height = Math.floor(h * this.dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /**
   * @param charX     角色脚底 x（CSS 像素），用于画接触阴影；为 null 时不画
   * @param charFeetY 角色脚底 y
   * @param clock     当前显示时间（小时，实数），驱动墙上挂钟
   */
  draw(
    room: RoomState,
    phase: DayPhase,
    timeSec: number,
    lampOn: boolean,
    charX?: number | null,
    charFeetY?: number | null,
    clock = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);

    const look = { ...PHASE_LOOK[phase] } as Palette;
    // 台灯点亮后覆盖环境光
    if (lampOn) {
      look.light = '#ffd79a';
      look.lightAlpha = 0.5;
      look.ambient = Math.min(1, look.ambient + 0.18);
    }

    const horizon = this.h * 0.62;

    this.drawWall(look, horizon);
    this.drawFloor(look, horizon);
    this.drawRug(room, look, horizon);
    // 接触阴影画在角色脚下的地面上（地毯之后，才不会被地毯盖住；角色在上层 canvas，会盖在它上面）
    if (charX != null && charFeetY != null) this.drawContactShadow(charX, charFeetY);
    this.drawShelf(room, look, horizon);
    this.drawBed(room, look, horizon);
    this.drawDesk(room, look, horizon);
    this.drawLamp(room, look, horizon, timeSec, lampOn);
    this.drawWindow(room, look, horizon);
    this.drawWallClock(look, horizon, clock);
    this.drawProps(room, look, horizon);
    this.drawLightOverlay(look, horizon, lampOn, timeSec);
  }

  // ── 基础面 ──────────────────────────────
  private drawWall(p: Palette, horizon: number): void {
    const ctx = this.ctx!;
    const g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, p.wallTop);
    g.addColorStop(1, p.wallBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, horizon);

    // 极淡的竖条墙纸，靠确定性分布避免闪烁
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = '#ffffff';
    for (let x = 0; x < this.w; x += 26) ctx.fillRect(x, 0, 12, horizon);
    ctx.globalAlpha = 1;

    // 墙裙
    const sk = horizon - 58;
    ctx.fillStyle = p.wainscot;
    ctx.fillRect(0, sk, this.w, horizon - sk);
    // 墙裙压条
    ctx.fillStyle = p.baseboard;
    ctx.fillRect(0, sk - 5, this.w, 5);
    ctx.fillRect(0, horizon - 4, this.w, 4);
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, sk);
    ctx.lineTo(this.w, sk);
    ctx.stroke();
  }

  private drawFloor(p: Palette, horizon: number): void {
    const ctx = this.ctx!;
    const g = ctx.createLinearGradient(0, horizon, 0, this.h);
    g.addColorStop(0, p.floorTop);
    g.addColorStop(1, p.floorBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, this.w, this.h - horizon);

    // 板缝：向消失点(角色站位)收拢，制造纵深
    const vpx = this.w * 0.42;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, horizon, this.w, this.h - horizon);
    ctx.clip();
    ctx.strokeStyle = p.plank;
    ctx.lineWidth = 1;
    for (let i = -8; i <= 8; i++) {
      ctx.beginPath();
      ctx.moveTo(vpx + i * 34, horizon);
      ctx.lineTo(vpx + i * 150, this.h);
      ctx.stroke();
    }
    // 横向接缝：越近越疏
    for (let i = 1; i <= 5; i++) {
      const t = i / 5;
      const y = horizon + (this.h - horizon) * t * t;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.w, y);
      ctx.stroke();
    }
    ctx.restore();

    // 窗光在地板的反射
    const sheen = ctx.createLinearGradient(this.w * 0.55, horizon, this.w * 0.75, this.h);
    sheen.addColorStop(0, p.floorSheen);
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.moveTo(this.w * 0.6, horizon);
    ctx.lineTo(this.w * 0.72, horizon);
    ctx.lineTo(this.w * 0.95, this.h);
    ctx.lineTo(this.w * 0.55, this.h);
    ctx.closePath();
    ctx.fill();
  }

  /** 角色脚下的柔和接触阴影，让角色"踩"在光里而不是飘着 */
  private drawContactShadow(x: number, y: number): void {
    const ctx = this.ctx!;
    const rx = Math.min(120, Math.max(58, this.w * 0.16));
    const ry = rx * 0.3;
    const g = ctx.createRadialGradient(x, y, 2, x, y, rx);
    g.addColorStop(0, 'rgba(30,20,12,0.34)');
    g.addColorStop(0.6, 'rgba(30,20,12,0.16)');
    g.addColorStop(1, 'rgba(30,20,12,0)');
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ── 地毯 ────────────────────────────────
  private drawRug(room: RoomState, p: Palette, horizon: number): void {
    const ctx = this.ctx!;
    const cx = this.w * 0.34;
    const cy = horizon + (this.h - horizon) * 0.6;
    const rx = Math.min(210, this.w * 0.33);
    const ry = rx * 0.32;

    // 底
    ctx.fillStyle = 'rgba(198,138,116,0.52)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // 花纹外环
    ctx.strokeStyle = 'rgba(150,92,84,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.82, ry * 0.82, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(150,92,84,0.32)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.55, ry * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
    // 中心小点阵
    ctx.fillStyle = 'rgba(160,104,96,0.4)';
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rx * 0.3, cy + Math.sin(a) * ry * 0.3, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    void room;
    void p;
  }

  // ── 窗 ────────────────────────────────
  private drawWindow(room: RoomState, p: Palette, horizon: number): void {
    const ctx = this.ctx!;
    const w = Math.min(158, this.w * 0.21);
    const h = w * 1.3;
    const x = this.w * 0.67;
    const y = horizon - h - 92;

    // 窗台底座阴影
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    this.rr(ctx, x - 10, y + h + 9, w + 20, 8, 4);
    ctx.fill();

    // 窗外天空
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, p.sky);
    g.addColorStop(1, p.skyLow);
    ctx.fillStyle = g;
    this.rr(ctx, x, y, w, h, 9);
    ctx.fill();

    // 远景：起起伏伏的山丘 + 房子剪影，给窗外景深
    ctx.save();
    this.rr(ctx, x, y, w, h, 9);
    ctx.clip();
    ctx.fillStyle = 'rgba(90,120,110,0.25)';
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.72);
    ctx.quadraticCurveTo(x + w * 0.3, y + h * 0.6, x + w * 0.6, y + h * 0.72);
    ctx.quadraticCurveTo(x + w * 0.85, y + h * 0.64, x + w, y + h * 0.74);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(60,70,90,0.3)';
    ctx.fillRect(x + w * 0.2, y + h * 0.74, 24, 30);
    ctx.beginPath();
    ctx.moveTo(x + w * 0.18, y + h * 0.74);
    ctx.lineTo(x + w * 0.2 + 12, y + h * 0.68);
    ctx.lineTo(x + w * 0.2 + 24, y + h * 0.74);
    ctx.closePath();
    ctx.fill();

    // 太阳/月亮
    if (p.sky === PHASE_LOOK.night.sky) {
      ctx.fillStyle = 'rgba(255,250,220,0.92)';
      ctx.beginPath();
      ctx.arc(x + w * 0.72, y + h * 0.22, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.sky;
      ctx.beginPath();
      ctx.arc(x + w * 0.67, y + h * 0.18, 8, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255,244,200,0.85)';
      ctx.beginPath();
      ctx.arc(x + w * 0.74, y + h * 0.2, 12, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 雨雪粒子
    if (room.weather === 'rain' || room.weather === 'snow') {
      ctx.save();
      this.rr(ctx, x, y, w, h, 9);
      ctx.clip();
      for (let i = 0; i < 30; i++) {
        const seed = i * 137.5;
        const px = x + ((seed * 7) % w);
        const t = ((timeSecNow() * (room.weather === 'rain' ? 1.1 : 0.35) + i * 0.37) % 1);
        const py = y + t * h;
        if (room.weather === 'rain') {
          ctx.strokeStyle = 'rgba(220,235,255,0.55)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px - 2, py + 9);
          ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.beginPath();
          ctx.arc(px, py, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // 窗框（双线，更精致）
    ctx.strokeStyle = 'rgba(120,95,72,0.35)';
    ctx.lineWidth = 10;
    this.rr(ctx, x - 3, y - 3, w + 6, h + 6, 11);
    ctx.stroke();
    ctx.strokeStyle = '#fbf6ec';
    ctx.lineWidth = 8;
    this.rr(ctx, x, y, w, h, 9);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w / 2, y + h);
    ctx.moveTo(x, y + h / 2);
    ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();

    // 窗帘：拉开时两侧收拢，拉上时合拢
    ctx.fillStyle = '#f4ddca';
    const cw = w * 0.34;
    if (room.curtainOpen) {
      this.drawCurtain(ctx, x - cw * 0.55, y - 10, cw, h + 20);
      this.drawCurtain(ctx, x + w - cw * 0.45, y - 10, cw, h + 20);
    } else {
      this.drawCurtain(ctx, x - cw * 0.5, y - 10, w + cw, h + 20);
    }

    // 窗台
    ctx.fillStyle = '#f2ead9';
    this.rr(ctx, x - cw * 0.9, y + h + 2, w + cw * 1.8, 10, 5);
    ctx.fill();
    // 窗台上的小盆栽
    const px = x + 14;
    const py = y + h;
    ctx.fillStyle = '#c07a52';
    this.rr(ctx, px, py - 14, 16, 16, 3);
    ctx.fill();
    ctx.fillStyle = '#6f9e63';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.ellipse(px + 8 + i * 5, py - 20, 4, 7, i * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawCurtain(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, '#f7e4d4');
    g.addColorStop(0.5, '#efd3bf');
    g.addColorStop(1, '#f7e4d4');
    ctx.fillStyle = g;
    this.rr(ctx, x, y, w, h, 7);
    ctx.fill();
    // 褶皱
    ctx.strokeStyle = 'rgba(180,140,110,0.25)';
    ctx.lineWidth = 1.5;
    for (let i = 1; i < 4; i++) {
      const cxp = x + (w * i) / 4;
      ctx.beginPath();
      ctx.moveTo(cxp, y + 4);
      ctx.lineTo(cxp, y + h - 4);
      ctx.stroke();
    }
  }

  /** 墙上的挂钟，指针跟随真实时间 */
  private drawWallClock(p: Palette, horizon: number, clock: number): void {
    const ctx = this.ctx!;
    const cx = this.w * 0.17;
    const cy = horizon - 128;
    const r = Math.min(24, this.w * 0.055);

    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.arc(cx + 2, cy + 3, r, 0, Math.PI * 2);
    ctx.fill();
    // 表盘
    ctx.fillStyle = '#fbf6ec';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#b79a78';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // 刻度
    ctx.strokeStyle = 'rgba(120,95,72,0.7)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const r0 = i % 3 === 0 ? r * 0.66 : r * 0.78;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86);
      ctx.stroke();
    }
    // 指针
    const hh = ((clock % 12) / 12) * Math.PI * 2 - Math.PI / 2;
    const mm = ((clock % 1) * 12) * Math.PI * 2 - Math.PI / 2; // 0~1 小时 = 0~12 分刻度略简，按分钟走一圈
    const realMin = ((clock % 1) * 60 / 60) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = '#5a4634';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(hh) * r * 0.5, cy + Math.sin(hh) * r * 0.5);
    ctx.stroke();
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(realMin) * r * 0.74, cy + Math.sin(realMin) * r * 0.74);
    ctx.stroke();
    void mm;
    // 轴心
    ctx.fillStyle = p.baseboard;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── 家具 ───────────────────────────────
  private drawShelf(room: RoomState, p: Palette, horizon: number): void {
    const ctx = this.ctx!;
    const x = this.w * 0.04;
    const y = horizon - 104;
    const w = Math.min(124, this.w * 0.17);
    const h = 104;

    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    this.rr(ctx, x + 4, y + 5, w, h, 6);
    ctx.fill();
    // 柜体
    ctx.fillStyle = '#ad835b';
    this.rr(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.fillStyle = shade('#ad835b', -20);
    this.rr(ctx, x + 6, y + 6, w - 12, h - 12, 3);
    ctx.fill();

    // 书
    const bookColors = ['#c05f4e', '#4f7fa8', '#d6a24f', '#6a9a6a', '#8c6aa8', '#c98a5a'];
    for (let shelf = 0; shelf < 2; shelf++) {
      const sy = y + 22 + shelf * 44;
      let bx = x + 12;
      let i = 0;
      while (bx < x + w - 20) {
        const seed = (shelf * 7 + i * 13) % bookColors.length;
        const bw = 7 + (seed % 3) * 3;
        const bh = 22 + ((seed * 5) % 10);
        ctx.fillStyle = bookColors[seed];
        this.rr(ctx, bx, sy + (26 - bh), bw, bh, 1.5);
        ctx.fill();
        bx += bw + 1.5;
        i++;
      }
      ctx.fillStyle = shade('#ad835b', 12);
      ctx.fillRect(x + 4, sy + 26, w - 8, 4);
    }

    // 顶上小盆栽
    ctx.fillStyle = '#c07a52';
    this.rr(ctx, x + w * 0.6, y - 12, 14, 14, 3);
    ctx.fill();
    ctx.fillStyle = '#6f9e63';
    ctx.beginPath();
    ctx.ellipse(x + w * 0.6 + 7, y - 18, 8, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    void room;
    void p;
  }

  private drawBed(room: RoomState, p: Palette, horizon: number): void {
    const ctx = this.ctx!;
    const w = Math.min(240, this.w * 0.35);
    const h = 66;
    const x = this.w * 0.04;
    const y = horizon + 6;

    // 落地阴影
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h + 4, w * 0.52, 12, 0, 0, Math.PI * 2);
    ctx.fill();

    // 床架
    ctx.fillStyle = '#8f6847';
    this.rr(ctx, x, y, w, h, 10);
    ctx.fill();
    // 床垫
    ctx.fillStyle = '#f6efe4';
    this.rr(ctx, x + 5, y + 6, w - 10, h - 18, 7);
    ctx.fill();

    // 被子：整洁度影响褶皱
    const messy = (100 - room.tidiness) / 100;
    const bg = ctx.createLinearGradient(x, y + 30, x, y + h);
    bg.addColorStop(0, '#9dbdd2');
    bg.addColorStop(1, '#7fa4bd');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(x + 5, y + 32);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const px = x + 5 + (w - 10) * t;
      const py = y + 32 + Math.sin(t * 7 + 1) * (3 + messy * 12);
      ctx.lineTo(px, py);
    }
    ctx.lineTo(x + w - 5, y + h - 8);
    ctx.lineTo(x + 5, y + h - 8);
    ctx.closePath();
    ctx.fill();
    // 被子高光
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 10, y + 40);
    ctx.quadraticCurveTo(x + w / 2, y + 34, x + w - 10, y + 42);
    ctx.stroke();

    // 枕头
    ctx.fillStyle = '#fdf8f0';
    this.rr(ctx, x + 10, y + 11, w * 0.36, 22, 9);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180,160,140,0.3)';
    ctx.lineWidth = 1;
    this.rr(ctx, x + 10, y + 11, w * 0.36, 22, 9);
    ctx.stroke();
    void p;
  }

  private drawDesk(room: RoomState, p: Palette, horizon: number): void {
    const ctx = this.ctx!;
    const w = Math.min(156, this.w * 0.25);
    const h = 15;
    const x = this.w * 0.53;
    const y = horizon + 26;

    // 桌面阴影
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h + 16, w * 0.5, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    // 桌腿
    ctx.fillStyle = '#7f5a3c';
    ctx.fillRect(x + 9, y + h, 8, this.h - y - h - 10);
    ctx.fillRect(x + w - 17, y + h, 8, this.h - y - h - 10);
    // 桌面
    const dg = ctx.createLinearGradient(x, y, x, y + h);
    dg.addColorStop(0, '#c08a55');
    dg.addColorStop(1, '#a5713f');
    ctx.fillStyle = dg;
    this.rr(ctx, x, y, w, h, 5);
    ctx.fill();

    // 身上的书堆
    if (room.props.includes('book')) {
      const cover = ['#c05f4e', '#4f7fa8', '#d6a24f'];
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = cover[i];
        this.rr(ctx, x + 16, y - 8 - i * 7, 44 - i * 5, 6, 2);
        ctx.fill();
      }
    }

    // 台灯
    if (room.props.includes('lamp')) {
      ctx.fillStyle = '#5f6672';
      ctx.fillRect(x + w - 36, y - 24, 5, 24);
      const lg = ctx.createLinearGradient(x + w - 46, y - 46, x + w - 46, y - 24);
      lg.addColorStop(0, '#8e97a4');
      lg.addColorStop(1, '#6d7683');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(x + w - 50, y - 24);
      ctx.lineTo(x + w - 21, y - 24);
      ctx.lineTo(x + w - 27, y - 46);
      ctx.lineTo(x + w - 44, y - 46);
      ctx.closePath();
      ctx.fill();
    }

    // 桌面上的手机（也是"小手机"功能的伏笔）
    const px = x + w * 0.42;
    ctx.fillStyle = '#2b2f38';
    this.rr(ctx, px, y - 5, 18, 26, 4);
    ctx.fill();
    ctx.fillStyle = 'rgba(150,200,230,0.55)';
    this.rr(ctx, px + 2.5, y - 2.5, 13, 21, 2.5);
    ctx.fill();
    void p;
  }

  private drawLamp(
    room: RoomState,
    p: Palette,
    horizon: number,
    timeSec: number,
    lampOn: boolean,
  ): void {
    const ctx = this.ctx!;
    void room;
    // 灯具本体在 drawDesk 里画，这里补暖光光晕
    if (lampOn) {
      this.lampFlicker = 0.94 + Math.sin(timeSec * 7.3) * 0.03 + Math.sin(timeSec * 2.1) * 0.03;
      const cx = this.w * 0.53 + Math.min(156, this.w * 0.25) - 35;
      const cy = horizon + 26 - 46;
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 170);
      g.addColorStop(0, `rgba(255,214,150,${0.55 * this.lampFlicker})`);
      g.addColorStop(0.5, `rgba(255,196,120,${0.18 * this.lampFlicker})`);
      g.addColorStop(1, 'rgba(255,196,120,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, 170, 0, Math.PI * 2);
      ctx.fill();
    }
    void p;
  }

  private drawProps(room: RoomState, p: Palette, horizon: number): void {
    const ctx = this.ctx!;

    // 墙上两幅相框
    this.drawFrame(ctx, this.w * 0.33, horizon - 150, 40, 32, '#c9a97e');
    this.drawFrame(ctx, this.w * 0.4, horizon - 138, 30, 24, '#a8916f');

    // 落地绿植
    const px = this.w * 0.9;
    const py = horizon + (this.h - horizon) * 0.82;
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.beginPath();
    ctx.ellipse(px, py + 4, 20, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    // 花盆
    ctx.fillStyle = '#b06f4a';
    ctx.beginPath();
    ctx.moveTo(px - 15, py - 26);
    ctx.lineTo(px + 15, py - 26);
    ctx.lineTo(px + 11, py);
    ctx.lineTo(px - 11, py);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#9a5f3e';
    ctx.fillRect(px - 17, py - 30, 34, 7);
    // 叶片
    ctx.fillStyle = '#5f9157';
    const leaf = (ang: number, len: number) => {
      ctx.save();
      ctx.translate(px, py - 30);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.ellipse(0, -len / 2, 7, len / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    leaf(-0.9, 44);
    leaf(-0.3, 56);
    leaf(0.35, 50);
    leaf(0.9, 42);
    ctx.fillStyle = '#6fa063';
    leaf(0, 62);

    // 猫
    if (room.props.includes('cat')) {
      const cx = this.w * 0.24;
      const cy = horizon + (this.h - horizon) * 0.72;
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 8, 22, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e2c9a8';
      ctx.beginPath();
      ctx.ellipse(cx, cy, 21, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#e2c9a8';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + 19, cy);
      ctx.quadraticCurveTo(cx + 36, cy - 12, cx + 30, cy - 23);
      ctx.stroke();
      ctx.fillStyle = '#d9bd98';
      ctx.beginPath();
      ctx.moveTo(cx - 11, cy - 8);
      ctx.lineTo(cx - 14, cy - 19);
      ctx.lineTo(cx - 3, cy - 12);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#8a7a66';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(cx - 9, cy - 3, 3, 0.2, Math.PI - 0.2);
      ctx.stroke();
    }
    void p;
  }

  private drawFrame(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    tint: string,
  ): void {
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    this.rr(ctx, x + 2, y + 3, w, h, 3);
    ctx.fill();
    ctx.fillStyle = tint;
    this.rr(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.fillStyle = shade(tint, -26);
    this.rr(ctx, x + 4, y + 4, w - 8, h - 8, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.beginPath();
    ctx.arc(x + w * 0.36, y + h * 0.4, Math.min(w, h) * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── 光照与氛围 ─────────────────────────
  private drawLightOverlay(
    p: Palette,
    horizon: number,
    lampOn: boolean,
    timeSec: number,
  ): void {
    const ctx = this.ctx!;

    // 窗光斜投
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const sx = this.w * 0.72;
    const drift = Math.sin(timeSec * 0.08) * 12;
    ctx.fillStyle = p.light;
    ctx.globalAlpha = p.lightAlpha;
    ctx.beginPath();
    ctx.moveTo(sx - 74 + drift, 0);
    ctx.lineTo(sx + 84 + drift, 0);
    ctx.lineTo(sx + 200 + drift, horizon + 150);
    ctx.lineTo(sx - 44 + drift, horizon + 150);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 夜间压暗
    if (p.ambient < 1) {
      ctx.fillStyle = `rgba(24,28,50,${(1 - p.ambient) * 0.5})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    // 暗角
    const vig = ctx.createRadialGradient(
      this.w * 0.42,
      this.h * 0.5,
      this.h * 0.26,
      this.w * 0.42,
      this.h * 0.5,
      this.h * 0.96,
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(30,20,10,0.32)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, this.w, this.h);

    if (lampOn) {
      ctx.fillStyle = 'rgba(255,200,140,0.05)';
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }

  private rr(
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
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
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

function timeSecNow(): number {
  return performance.now() / 1000;
}
