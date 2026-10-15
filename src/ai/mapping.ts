import {
  ACTIONS,
  EMOTIONS,
  type Activity,
  type IntentSchema,
  type ModelAction,
  type ModelEmotion,
  type Mood,
} from '../core/types';
import { AFFINITY_DELTA_MAX, AFFINITY_DELTA_MIN, AFFINITY_MAX } from '../core/story';

/**
 * 模型输出的唯一出口。
 * 任何不在白名单里的值都会在这里被丢弃并降级，绝不透传进引擎。
 */

const ACTION_SET = new Set<string>(ACTIONS);
const EMOTION_SET = new Set<string>(EMOTIONS);

export interface SafeIntent {
  intent: IntentSchema;
  /** 哪些字段被修正过，用于 debug 面板 */
  repaired: string[];
  /** 解析是否失败走了兜底 */
  fallback: boolean;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 从可能夹杂 markdown 的文本里抠出 JSON。 */
export function extractJson(raw: string): unknown | null {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试 */
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* 继续尝试 */
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function sanitizeIntent(
  raw: unknown,
  fallbackLine: string,
  fallbackEmotion: ModelEmotion,
  fallbackAction: ModelAction,
): SafeIntent {
  const repaired: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;

  // line：必须是字符串，且长度有上限（防注入长文本撑爆 UI）
  let line = typeof o.line === 'string' ? o.line.trim() : '';
  if (!line) {
    line = fallbackLine;
    repaired.push('line');
  }
  if (line.length > 120) {
    line = line.slice(0, 120);
    repaired.push('line.length');
  }
  // 去掉模型偶尔带出的旁白括号描写
  line = line.replace(/[（(][^）)]{0,20}[）)]/g, '').trim() || fallbackLine;

  // emotion：白名单
  let emotion = o.emotion as string;
  if (!EMOTION_SET.has(emotion)) {
    emotion = fallbackEmotion;
    repaired.push('emotion');
  }

  // action：白名单
  let action = o.action as string;
  if (!ACTION_SET.has(action)) {
    action = fallbackAction;
    repaired.push('action');
  }

  // intensity：数值 + clamp
  let intensity = Number(o.intensity);
  if (!Number.isFinite(intensity)) {
    intensity = 0.3;
    repaired.push('intensity');
  }
  intensity = clamp(intensity, -1, 1);

  // affinityDelta：她对这次互动的真实感受。
  // 缺失（老模型没吐这个字段）时给一个**温和的小正值**——
  // 不能默认 0，那会让所有对话都变成"聊了等于没聊"。
  let affinityDelta = Number(o.affinityDelta);
  if (!Number.isFinite(affinityDelta)) {
    affinityDelta = 0.6;
    repaired.push('affinityDelta');
  }
  affinityDelta = clamp(affinityDelta, AFFINITY_DELTA_MIN, AFFINITY_DELTA_MAX);

  // memorable：只认 0/1
  let memorable: 0 | 1 = o.memorable === 1 || o.memorable === '1' ? 1 : 0;

  return {
    intent: {
      line,
      emotion: emotion as ModelEmotion,
      action: action as ModelAction,
      intensity: Math.round(intensity * 100) / 100,
      affinityDelta: Math.round(affinityDelta * 10) / 10,
      memorable,
    },
    repaired,
    fallback: raw === null || raw === undefined,
  };
}

/** 模型给的 action 是"她接下来想做什么"，但睡觉要受作息约束。 */
export function reconcileAction(action: ModelAction, hour: number, energy: number): Activity {
  if (action === 'sleeping' && (hour % 24 > 6 && hour % 24 < 22)) {
    return energy < 35 ? 'resting' : 'idle';
  }
  return action;
}

/**
 * 关系进展与强度共同决定是否害羞。
 *
 * shyThreshold 的语义是「关系进展为 0 时，多强的正面刺激会让她脸红」。
 * 强度 1.0 + 关系进展 0 → shyPressure = 1，超过任何阈值 ⇒ 一定害羞；
 * 关系进展升高时压力下降，到 90% 以上不再被外力触发害羞，只由模型显式决定。
 *
 * 注意分母是 AFFINITY_MAX（1000）而不是 100 —— 关系数值换过口径，
 * 这里如果还按 100 算，p 会瞬间饱和成 1，外力就再也不会让她害羞了。
 */
export function resolveMood(
  emotion: ModelEmotion,
  intensity: number,
  affection: number,
  shyThreshold: number,
): Mood {
  if (emotion === 'shy') return 'shy';
  const p = Math.max(0, Math.min(1, affection / AFFINITY_MAX));
  // 压力随强度线性增长，随关系进展二次衰减：刚认识时极易脸红
  const shyPressure = Math.max(0, intensity) * (1 - p) * (1 - p * 0.6);
  if (shyPressure > shyThreshold && affection < AFFINITY_MAX * 0.8) return 'shy';
  return emotion as Mood;
}