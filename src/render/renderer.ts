import type { RigPose } from '../anim/rig';
import type { Activity, Appearance, Mood } from '../core/types';

/**
 * 角色渲染器接口。
 *
 * 引擎只认识这个接口。原型内置"程序化矢量渲染器"，
 * 将来换成 Live2D 时只需新增一个实现，引擎代码一行不改。
 */
export interface CharacterRenderer {
  readonly kind: string;
  /** 当前视口尺寸，切立绘时用来把新渲染器对齐到同一视口 */
  readonly viewWidth?: number;
  readonly viewHeight?: number;
  /** 异步加载模型（仅 Live2D 需要）。返回 false 表示素材缺失，调用方应回退。 */
  load?: () => Promise<boolean>;
  /** 加载状态回调（仅 Live2D） */
  onStatusChange?: (s: { loading: boolean; ready: boolean; error?: string }) => void;
  /** 同步活动动作（仅 Live2D 用得到，矢量版由 RigPose 自己驱动） */
  syncActivity?: (activity: Activity) => void;
  /** 播放一次性反应动作（仅 Live2D） */
  playReaction?: () => void;
  mount(canvas: HTMLCanvasElement): void;
  resize(w: number, h: number): void;
  draw(pose: RigPose, appearance: Appearance, mood: Mood, timeSec: number): void;
  /** 角色脚下在屏幕上的位置（CSS 像素），用于在小屋地面画接触阴影、让角色"站得住" */
  charGround?(): { x: number; y: number } | null;
  /** 角色各部位锚点（CSS 像素）+ 头宽，用于把配件叠到头/脸/脖/手上 */
  charAnchors?(): {
    head: { x: number; y: number };
    face: { x: number; y: number };
    neck: { x: number; y: number };
    hand: { x: number; y: number };
    /** 实测头部宽度（屏幕 px），配件尺寸/偏移都以它为基准 */
    headW: number;
    bodyH: number;
  } | null;
  /** 角色在画面中的碰撞盒（CSS 像素），用于触摸命中判定 */
  hitTest(x: number, y: number): BodyPart | null;
  dispose(): void;
}

export type BodyPart = 'head' | 'face' | 'hand' | 'torso' | 'leg' | 'none';