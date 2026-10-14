import type { Activity, Mood } from '../core/types';

/**
 * 角色参数化模型。
 *
 * 这一层是"骨骼姿态"的抽象描述：引擎只改这些数值，
 * 渲染器（程序化绘制 / Live2D）负责把它们画出来。
 * 因此换成 Live2D 时，这一整层代码可以原样保留。
 */

export interface RigPose {
  /** 身体整体 Y 位移（呼吸、蹲下） */
  bodyOffsetY: number;
  /** 躯干倾斜角（度） */
  torsoTilt: number;
  /** 头部俯仰（度，正为低头） */
  headPitch: number;
  /** 头部偏转（度） */
  headYaw: number;
  /** 手臂角度：0 垂下，正为抬起 */
  armL: number;
  armR: number;
  /** 肘部弯曲 0~1 */
  elbowL: number;
  elbowR: number;
  /** 腿角度 */
  legL: number;
  legR: number;
  /** 眨眼 0(闭)~1(睁) */
  eyeOpen: number;
  /** 眉毛高度 0~1，1 为挑眉 */
  browRaise: number;
  /** 眉毛角度，正为担心 / 负为生气 */
  browAngle: number;
  /** 瞳孔偏移 -1~1（视线） */
  gazeX: number;
  gazeY: number;
  /** 嘴张开 0~1（说话口型） */
  mouthOpen: number;
  /** 嘴宽 0~1（微笑到抿嘴） */
  mouthSmile: number;
  /** 腮红强度 0~1 */
  blush: number;
  /** 缩放 1 基准 */
  scale: number;
  /** 呼吸相位偏移 */
  breathPhase: number;
}

export const NEUTRAL_POSE: RigPose = {
  bodyOffsetY: 0,
  torsoTilt: 0,
  headPitch: 0,
  headYaw: 0,
  armL: 4,
  armR: -4,
  elbowL: 0.1,
  elbowR: 0.1,
  legL: 0,
  legR: 0,
  eyeOpen: 1,
  browRaise: 0.3,
  browAngle: 0,
  gazeX: 0,
  gazeY: 0,
  mouthOpen: 0,
  mouthSmile: 0.4,
  blush: 0,
  scale: 1,
  breathPhase: 0,
};

/** 表情 → 面部参数偏移量 */
export function moodFace(mood: Mood): Partial<RigPose> {
  switch (mood) {
    case 'happy':
      return { mouthSmile: 0.9, browRaise: 0.45, eyeOpen: 0.85 };
    case 'calm':
      return { mouthSmile: 0.45, browRaise: 0.3, eyeOpen: 1 };
    case 'shy':
      return { mouthSmile: 0.3, browRaise: 0.1, eyeOpen: 0.7, blush: 0.75, headPitch: 4 };
    case 'sleepy':
      return { mouthSmile: 0.2, browRaise: 0.05, eyeOpen: 0.35, headPitch: 7 };
    case 'sulky':
      return { mouthSmile: -0.35, browAngle: -12, browRaise: 0.05, eyeOpen: 0.9, headPitch: 2 };
    case 'excited':
      return { mouthSmile: 1, browRaise: 0.7, eyeOpen: 1.15, mouthOpen: 0.12 };
  }
}

/** 活动 → 身体姿态 */
export function activityPose(activity: Activity): Partial<RigPose> {
  switch (activity) {
    case 'idle':
      return { armL: 5, armR: -5 };
    case 'reading':
      return {
        armL: 62,
        armR: 40,
        elbowL: 0.75,
        elbowR: 0.8,
        headPitch: 12,
        torsoTilt: 4,
      };
    case 'resting':
      return {
        armL: 8,
        armR: -8,
        torsoTilt: 3,
        headPitch: 3,
        legL: 6,
        legR: -6,
        scale: 0.985,
      };
    case 'playing_game':
      return {
        armL: 55,
        armR: 48,
        elbowL: 0.7,
        elbowR: 0.72,
        headPitch: 8,
        torsoTilt: -3,
      };
    case 'stretching':
      return {
        armL: 155,
        armR: -150,
        elbowL: 0.05,
        elbowR: 0.05,
        torsoTilt: -4,
        headPitch: -9,
      };
    case 'cooking':
      return {
        armL: 48,
        armR: 44,
        elbowL: 0.6,
        elbowR: 0.65,
        headPitch: 4,
      };
    case 'sleeping':
      return {
        armL: 10,
        armR: -10,
        headPitch: 14,
        eyeOpen: 0,
        mouthSmile: 0.1,
        torsoTilt: 7,
        bodyOffsetY: 8,
        scale: 0.99,
      };
    case 'talking':
      return {
        armL: 22,
        armR: -14,
        elbowL: 0.45,
        elbowR: 0.3,
        headPitch: -2,
        browRaise: 0.4,
      };
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPose(from: RigPose, to: RigPose, t: number): RigPose {
  const out = {} as RigPose;
  (Object.keys(from) as (keyof RigPose)[]).forEach((k) => {
    out[k] = lerp(from[k], to[k], t);
  });
  return out;
}

/** 缓动函数：让动作有加速度变化，不生硬 */
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

/** 呼吸：正弦波驱动身体起伏与肩部变化 */
export function breath(t: number): number {
  return Math.sin(t * 1.6) * 0.5 + 0.5;
}