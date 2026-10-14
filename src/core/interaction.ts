import type { SaveData } from '../core/types';
import { pronoun } from './gender';

/**
 * 互动规则表。
 * 每条规则对应：碰到哪里 → 角色做什么动作 + 心情怎么变 + 说什么。
 * 台词分「有网络时用模型的」和「离线时的」两路，
 * 这里只负责离线台词和情绪反馈，AI 链路走 ai/ 模块。
 * 文案里的第三人称一律用 pronoun() 生成，避免"他/她"写死。
 */

export type TouchKind = 'head' | 'face' | 'hand' | 'torso' | 'leg';

export interface TouchResult {
  line: string;
  emotion: 'happy' | 'calm' | 'shy' | 'excited';
  affinityDelta: number;
  moodDelta: number;
  weight: number;
  summary: string;
  /** 是否写进长期记忆 */
  memorable: boolean;
}

const TOUCH_TABLE: Record<
  TouchKind,
  {
    lines: string[];
    emotion: TouchResult['emotion'];
    aff: number;
    mood: number;
    summary: (t: string) => string;
  }
> = {
  head: {
    lines: ['……你摸我头了。', '头发会乱的。', '嗯……还挺舒服。', '别一直摸啦。'],
    emotion: 'shy',
    aff: 1.2,
    mood: 4,
    summary: (t) => `你伸手摸了摸${t}的头。`,
  },
  face: {
    lines: ['！……干嘛突然凑这么近。', '别捏。', '……看什么。', '脸会红啊。'],
    emotion: 'shy',
    aff: 1.5,
    mood: 5,
    summary: (t) => `你凑近了${t}的脸。`,
  },
  hand: {
    lines: ['手凉。', '要牵就牵啊。', '……握住了。'],
    emotion: 'happy',
    aff: 1.6,
    mood: 6,
    summary: () => '你们握了握手。',
  },
  torso: {
    lines: ['喂！', '……痒。', '别闹。', '在呢。'],
    emotion: 'shy',
    aff: 1,
    mood: 4,
    summary: (t) => `你戳了戳${t}的肚子。`,
  },
  leg: {
    lines: ['诶——别碰腿。', '……', '干嘛？'],
    emotion: 'excited',
    aff: 0.8,
    mood: 3,
    summary: (t) => `你碰了${t}的腿，${t}缩了一下。`,
  },
};

export function resolveTouch(kind: TouchKind, save: SaveData): TouchResult {
  const row = TOUCH_TABLE[kind];
  const line = row.lines[Math.floor(Math.random() * row.lines.length)];
  const t = pronoun(save.character.personality.gender);

  // 亲密度越低，同样举动的加成越低；高亲密度时触碰上限收敛，防止数值爆炸
  const affScale = 0.5 + (save.character.affinity / 100) * 0.7;
  const decay = save.character.affinity > 90 ? 0.35 : 1;

  return {
    line,
    emotion: row.emotion,
    affinityDelta: Math.round(row.aff * affScale * decay * 10) / 10,
    moodDelta: Math.round(row.mood * (1 - save.character.energyValue / 220) * 10) / 10,
    weight: 2,
    summary: row.summary(t),
    memorable: save.character.interactionCount % 10 === 0,
  };
}

// ── 礼物 ──────────────────────────────────────────

export interface Gift {
  id: string;
  label: string;
  icon: string;
  /** 基础好感与心情加成 */
  affinity: number;
  mood: number;
  /** 契合度高的礼物额外加成 */
  bonusLine?: string;
}

export const GIFTS: Gift[] = [
  { id: 'book', label: '一本旧书', icon: '书', affinity: 2.5, mood: 8 },
  { id: 'tea', label: '一杯热茶', icon: '茶', affinity: 2.2, mood: 10, bonusLine: '……还是温的。' },
  { id: 'cake', label: '小蛋糕', icon: '糕', affinity: 2.8, mood: 14, bonusLine: '甜的。' },
  { id: 'scarf', label: '织好的围巾', icon: '巾', affinity: 3.5, mood: 12, bonusLine: '……你织的？' },
  { id: 'game', label: '新游戏卡带', icon: '卡', affinity: 2.4, mood: 9 },
];

export function resolveGift(gift: Gift, save: SaveData): TouchResult {
  const liked = save.character.likedGifts.includes(gift.id);
  const mult = liked ? 1.6 : 1;
  const t = pronoun(save.character.personality.gender);
  return {
    line: liked && gift.bonusLine ? gift.bonusLine : `……${gift.label}。谢谢。`,
    emotion: 'happy',
    affinityDelta: Math.round(gift.affinity * mult * 10) / 10,
    moodDelta: Math.round(gift.mood * mult * 10) / 10,
    weight: 3,
    summary: `你送了${t}${gift.label}。`,
    memorable: gift.affinity >= 3,
  };
}

// ── 共同活动 ─────────────────────────────────────────

export interface ActivityDef {
  id: 'read' | 'game' | 'cook' | 'rest' | 'walk';
  label: string;
  icon: string;
  /** 对应角色活动状态 */
  activity: SaveData['character']['activity'];
  affinity: number;
  mood: number;
  line: string;
  summary: string;
}

export const ACTIVITIES: ActivityDef[] = [
  {
    id: 'read',
    label: '一起看书',
    icon: '读',
    activity: 'reading',
    affinity: 1.8,
    mood: 8,
    line: '……往左一点，我看不清。',
    summary: '你们肩并肩看了一会儿书。',
  },
  {
    id: 'game',
    label: '一起打游戏',
    icon: '玩',
    activity: 'playing_game',
    affinity: 2.2,
    mood: 12,
    line: '这把不算，我手滑。',
    summary: '你们一起打了一局游戏。',
  },
  {
    id: 'cook',
    label: '一起做饭',
    icon: '厨',
    activity: 'cooking',
    affinity: 2.4,
    mood: 10,
    line: '你来切菜，我来煮。',
    summary: '你们一起做了顿饭。',
  },
  {
    id: 'rest',
    label: '靠一会儿',
    icon: '靠',
    activity: 'resting',
    affinity: 3.2,
    mood: 9,
    line: '……别动，就这样待一会儿。',
    summary: '你们安静地靠在一起待了一会儿。',
  },
  {
    id: 'walk',
    label: '出门散步',
    icon: '走',
    activity: 'stretching',
    affinity: 2,
    mood: 11,
    line: '外面挺舒服的。',
    summary: '你们一起出门散了步。',
  },
];

export function resolveActivity(def: ActivityDef, _save: SaveData): TouchResult {
  return {
    line: def.line,
    emotion: 'happy',
    affinityDelta: def.affinity,
    moodDelta: def.mood,
    weight: 3,
    summary: def.summary,
    memorable: def.affinity >= 3,
  };
}

/** 互动后的通用反馈：亲密度越高，同样互动收益递减 */
export function applyGain(
  save: SaveData,
  affinityDelta: number,
  moodDelta: number,
): void {
  const c = save.character;
  const softCap = 1 - Math.max(0, c.affinity - 70) / 60;
  c.affinity = clampNum(c.affinity + affinityDelta * (0.5 + softCap * 0.8), 0, 100);
  c.moodValue = clampNum(c.moodValue + moodDelta, 0, 100);
  c.energyValue = clampNum(c.energyValue - moodDelta * 0.25, 0, 100);
  c.interactionCount += 1;

  // 心情值映射到情绪标签
  if (c.moodValue > 82) c.mood = c.affinity > 55 ? 'excited' : 'happy';
  else if (c.moodValue < 32) c.mood = 'sulky';
  else if (c.energyValue < 28) c.mood = 'sleepy';
  else if (c.mood === 'shy' && c.moodValue > 45) c.mood = 'calm';
}

export function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v * 10) / 10));
}