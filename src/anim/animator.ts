import type { Activity, Mood } from '../core/types';
import {
  NEUTRAL_POSE,
  activityPose,
  breath,
  easeInOut,
  lerpPose,
  moodFace,
  type RigPose,
} from './rig';

/**
 * 动画状态机。
 * 职责：把"当前该做什么"翻译成每帧的 RigPose。
 * 它不知道 Live2D 的存在，也不知道 Canvas 的存在。
 */

export interface AnimInputs {
  activity: Activity;
  mood: Mood;
  /** 视线目标（归一化 -1~1，来自触摸位置或玩家头部方向） */
  gazeTargetX: number;
  gazeTargetY: number;
  /** 是否正在说话 */
  speaking: boolean;
  /** 说话强度 0~1，驱动口型幅度 */
  speechEnergy: number;
  /** 一次性动作触发时间戳（ms），如摸头、被打断 */
  reactionStartedAt: number;
  reactionKind: ReactionKind;
  /** 眨眼节奏偏移，避免所有角色同步 */
  blinkSeed: number;
}

export type ReactionKind = 'none' | 'patted' | 'surprised' | 'shy' | 'gift';

const REACTION_DURATION = 1400;

export class Animator {
  private pose: RigPose = { ...NEUTRAL_POSE };
  private blinkTimer = 0;
  private nextBlinkAt = 2400;
  private blinkPhase = -1;
  private idleGazeTimer = 0;
  private idleGaze: { x: number; y: number } = { x: 0, y: 0 };

  /** 每帧调用 */
  update(dt: number, time: number, inputs: AnimInputs): RigPose {
    // ── 1. 眨眼 ──────────────────────────────
    this.updateBlink(dt, inputs);

    // ── 2. 视线：追踪玩家，超时后游移 ────────
    let gazeX = inputs.gazeTargetX;
    let gazeY = inputs.gazeTargetY;
    this.idleGazeTimer += dt;
    if (this.idleGazeTimer > 2600) {
      this.idleGazeTimer = 0;
      this.idleGaze = {
        x: (Math.random() - 0.5) * 1.2,
        y: (Math.random() - 0.5) * 0.5,
      };
    }
    const tracking = Math.abs(inputs.gazeTargetX) + Math.abs(inputs.gazeTargetY) > 0.05;
    const targetX = tracking ? gazeX : this.idleGaze.x;
    const targetY = tracking ? gazeY : this.idleGaze.y;

    // ── 3. 目标姿态合成 ──────────────────────
    const face = moodFace(inputs.mood);
    const act = activityPose(inputs.activity);

    // 说话时嘴部由 speechEnergy 驱动，覆盖静态微笑
    let mouthOpen = 0;
    if (inputs.speaking) {
      mouthOpen = (0.25 + Math.abs(Math.sin(time * 11)) * 0.75) * inputs.speechEnergy;
    }
    // 嘴部张合时微笑稍微收敛，避免笑与说话打架
    const smile = (face.mouthSmile ?? 0.4) * (1 - mouthOpen * 0.45);

    const target: RigPose = {
      ...NEUTRAL_POSE,
      ...act,
      ...face,
      armL: face.armL ?? act.armL ?? 0,
      armR: face.armR ?? act.armR ?? 0,
      eyeOpen: face.eyeOpen ?? 1,
      mouthOpen,
      mouthSmile: smile,
      gazeX: Math.max(-1, Math.min(1, targetX)),
      gazeY: Math.max(-1, Math.min(1, targetY)),
      breathPhase: time * 1.6,
    };

    // 视线追踪比姿态切换更慢，像脖子转动有惯性
    const poseT = 1 - Math.pow(0.002, dt); // 约 600ms 到位

    // ── 4. 呼吸叠加 ──────────────────────────
    const b = breath(time);
    target.bodyOffsetY = (target.bodyOffsetY ?? 0) - b * 2.2;
    target.scale = (target.scale ?? 1) * (1 + b * 0.004);

    // ── 5. 一次性反应动作叠加 ────────────────
    this.applyReaction(target, inputs, time);

    // ── 6. 平滑逼近 ──────────────────────────
    this.pose = lerpPose(this.pose, target, poseT);

    return this.pose;
  }

  private updateBlink(dt: number, inputs: AnimInputs): void {
    this.blinkTimer += dt;
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt;
      // 完整一次眨眼约 160ms：闭 70ms + 开 90ms
      if (this.blinkPhase > 160) {
        this.blinkPhase = -1;
        this.nextBlinkAt = 2000 + Math.random() * 3600;
      }
      return;
    }
    if (this.blinkTimer > this.nextBlinkAt) {
      this.blinkTimer = 0;
      this.blinkPhase = 0;
    }
    void inputs;
  }

  /** 眨眼时 eyeOpen 被压到接近 0；这里只算权重，由 update 合并进 pose */
  get blinkValue(): number {
    if (this.blinkPhase < 0) return 1;
    const p = this.blinkPhase;
    if (p < 70) return 1 - p / 70;
    return (p - 70) / 90;
  }

  private applyReaction(target: RigPose, inputs: AnimInputs, time: number): void {
    if (inputs.reactionKind === 'none') return;
    const elapsed = performance.now() - inputs.reactionStartedAt;
    if (elapsed > REACTION_DURATION || elapsed < 0) return;

    const p = elapsed / REACTION_DURATION;
    // 前半段抬手，后半段回落
    const curve = p < 0.35 ? easeInOut(p / 0.35) : 1 - easeInOut((p - 0.35) / 0.65);

    switch (inputs.reactionKind) {
      case 'patted':
        // 摸头：身体轻微下沉 + 眯眼 + 头往手上蹭
        target.bodyOffsetY = (target.bodyOffsetY ?? 0) + curve * 6;
        target.headPitch = (target.headPitch ?? 0) + curve * 9;
        target.eyeOpen = (target.eyeOpen ?? 1) * (1 - curve * 0.55);
        target.mouthSmile = (target.mouthSmile ?? 0) + curve * 0.45;
        target.armL = (target.armL ?? 0) - curve * 14;
        break;
      case 'surprised':
        target.browRaise = (target.browRaise ?? 0) + curve * 0.8;
        target.eyeOpen = 1.15;
        target.headPitch = (target.headPitch ?? 0) - curve * 8;
        target.armL = (target.armL ?? 0) + curve * 40;
        target.armR = (target.armR ?? 0) - curve * 30;
        target.scale = (target.scale ?? 1) * (1 + curve * 0.03);
        break;
      case 'shy':
        target.blush = (target.blush ?? 0) + curve * 0.9;
        target.headYaw = (target.headYaw ?? 0) + Math.sin(time * 9) * curve * 8;
        target.headPitch = (target.headPitch ?? 0) + curve * 6;
        target.gazeX = (target.gazeX ?? 0) - curve * 0.6;
        target.armL = (target.armL ?? 0) + curve * 18;
        target.elbowL = (target.elbowL ?? 0) + curve * 0.4;
        break;
      case 'gift':
        target.armL = (target.armL ?? 0) + curve * 55;
        target.armR = (target.armR ?? 0) + curve * 48;
        target.elbowL = (target.elbowL ?? 0) + curve * 0.3;
        target.eyeOpen = 1.1;
        target.mouthSmile = (target.mouthSmile ?? 0) + curve * 0.7;
        target.headPitch = (target.headPitch ?? 0) - curve * 6;
        break;
    }
  }

  get current(): RigPose {
    return this.pose;
  }
}