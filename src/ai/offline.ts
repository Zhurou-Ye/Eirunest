import type { IntentSchema, PersonalityPreset, SaveData } from '../core/types';
import { formatClock, memoriesFor } from '../core/store';

/**
 * 离线兜底回复。
 * 目标不是"像 AI"，而是没有网络时游戏依然有回应、能玩、能看动画。
 * 规则很简单：按当前状态 + 关键词匹配，产出一个合法的 IntentSchema。
 */

interface Rule {
  match: RegExp;
  reply: (save: SaveData) => string;
  emotion?: IntentSchema['emotion'];
  action?: IntentSchema['action'];
  memorable?: 0 | 1;
}

const RULES: Rule[] = [
  {
    match: /你好|在吗|在么|hi|hello|早上好|晚安/,
    reply: (s) =>
      s.character.phase === 'night'
        ? '……还没睡啊。'
        : `嗯，在的。${s.character.phase === 'morning' ? '刚醒没多久。' : '我一直都在这儿。'}`,
  },
  {
    match: /吃|饿|饭|外卖|做饭/,
    reply: () => '想吃什么？我去弄。',
    emotion: 'happy',
    action: 'cooking',
  },
  {
    match: /摸头|摸摸|摸摸头|抱抱|抱/,
    reply: (s) => `……突然这样，${s.character.affinity > 40 ? '不过我不太讨厌' : '会痒的'}。`,
    emotion: 'shy',
    action: 'idle',
  },
  {
    match: /喜欢你|爱你|好看|帅|可爱/,
    reply: (s) =>
      s.character.affinity > 50 ? '……你今天怎么了，一直说这种话。' : '别乱说啦。……不过谢谢。',
    emotion: 'shy',
    memorable: 1,
  },
  {
    match: /无聊|好闲|没意思|干嘛/,
    reply: () => '要不……你陪我打一局？',
    emotion: 'excited',
    action: 'playing_game',
  },
  {
    match: /累|困|睡|休息/,
    reply: () => '有点累了。让我靠一会儿。',
    emotion: 'sleepy',
    action: 'resting',
  },
  {
    match: /书|看|读/,
    reply: () => '这本还行。你要看吗？',
    emotion: 'calm',
    action: 'reading',
  },
  {
    match: /难过|不开心|心情|累死|烦/,
    reply: () => '……过来一点。',
    emotion: 'calm',
    action: 'idle',
    memorable: 1,
  },
  {
    match: /谢谢|感谢/,
    reply: () => '嗯。',
    emotion: 'shy',
  },
  {
    match: /早上|早安/,
    reply: () => '早。……你起得比我早。',
    emotion: 'sleepy',
    action: 'stretching',
  },
  {
    match: /晚安|睡了/,
    reply: () => '晚安。……灯我关。',
    emotion: 'calm',
    action: 'sleeping',
    memorable: 1,
  },
];

const IDLE_LINES = [
  '……嗯？',
  '你还在啊。',
  '刚刚走神了一会儿。',
  '外面天气还行。',
  '我在想晚上吃什么。',
  '你脚步声我听得出来。',
];

const SHY_LINES = ['……别看我。', '你、你干什么。', '耳朵热了。'];
const HAPPY_LINES = ['嘿嘿。', '今天心情不错。', '你在的话挺好。'];

export function offlineReply(save: SaveData, userText: string): IntentSchema {
  const c = save.character;

  for (const rule of RULES) {
    if (!rule.match.test(userText)) continue;

    // 害羞阈值生效：被夸或被碰时，亲密度低更容易脸红
    const baseEmotion = rule.emotion ?? 'calm';
    const shouldShy =
      (baseEmotion === 'shy' || /摸摸|喜欢|好看/.test(userText)) &&
      Math.random() < c.personality.shyThreshold + (1 - c.affinity / 100) * 0.4;

    return {
      line: rule.reply(save),
      emotion: shouldShy ? 'shy' : baseEmotion,
      action: rule.action ?? 'talking',
      intensity: 0.2 + Math.random() * 0.4,
      memorable: rule.memorable ?? 0,
    };
  }

  // 无规则命中：按状态挑一句
  const pool =
    c.mood === 'shy'
      ? SHY_LINES
      : c.mood === 'happy' || c.mood === 'excited'
        ? HAPPY_LINES
        : IDLE_LINES;

  const line = pool[Math.floor(Math.random() * pool.length)];

  return {
    line,
    emotion: c.mood === 'sleepy' ? 'sleepy' : c.mood === 'sulky' ? 'sulky' : 'calm',
    action: c.activity === 'idle' ? 'talking' : c.activity,
    intensity: 0.1 + Math.random() * 0.3,
    memorable: 0,
  };
}

/**
 * 角色主动搭话。
 *
 * 分三个优先级，越靠前越"像有心事"：
 *   1. 提起旧记忆（最像真人，也是陪伴感的核心）
 *   2. 跟着当前环境说（天气/时间）
 *   3. 通用废话（兜底）
 *
 * initiative 决定整体开口频率，性格越外向越高。
 */
export function idleGossip(save: SaveData): string | null {
  const c = save.character;
  if (c.phase === 'night' && c.energyValue < 40) return null;
  if (Math.random() > c.personality.initiative * 0.06) return null;

  // 1. 提起旧事：挑一条有点分量的记忆，故意说得像刚想起来
  const recallPool = memoriesFor(save).filter((m) => m.weight >= 3 && m.kind !== 'dialogue');
  if (recallPool.length > 0 && Math.random() < 0.42) {
    const m = recallPool[Math.floor(Math.random() * recallPool.length)];
    const recall = RECALL_LINES[Math.floor(Math.random() * RECALL_LINES.length)];
    return `${recall}${m.summary.replace(/[。.]$/, '')}。`;
  }

  // 2. 环境相关
  const byWeather: Record<string, string[]> = {
    sunny: ['今天外面挺亮的。', '这个光线我还挺喜欢。'],
    cloudy: ['天阴了。要下雨吗。'],
    rain: ['下雨了。听着挺好。', '你带伞了吗。'],
    snow: ['……下雪了。'],
  };

  const byPhase: Record<string, string[]> = {
    morning: ['刚醒。', '你起得比我早。'],
    noon: ['中午了。有点困。'],
    evening: ['天快黑了。', '要不要开灯。'],
    night: ['还不睡吗。', '这么晚还不困。'],
  };

  // 精力低的时候说的是累，不是天气
  if (c.energyValue < 30) {
    return TIRED_LINES[Math.floor(Math.random() * TIRED_LINES.length)];
  }

  const pools = [byWeather[save.room.weather] ?? [], byPhase[c.phase] ?? []];
  const usable = pools.filter((p) => p.length > 0);
  if (usable.length === 0) return null;
  const chosen = usable[Math.floor(Math.random() * usable.length)];
  return chosen[Math.floor(Math.random() * chosen.length)];
}

/** 提起旧记忆的开场白。故意不说完，像人"突然想起来" */
const RECALL_LINES = [
  '突然想起来，',
  '哎，你还记得吗，',
  '对了，之前',
  '我本来想说……',
];

const TIRED_LINES = [
  '有点累了。',
  '让我靠一会儿。',
  '今天话都说不动了。',
  '……想睡了。',
];

// ── 主动"看时间"──────────────────────────────────────────
// 作息不僵硬的关键：她不是到点机械切换动作，而是偶尔瞄一眼钟、顺口一句。
// 台词以"真实时间段"为基线，再按性格补一句口吻，避免千篇一律。

type TimeBucket =
  | 'deepnight'
  | 'dawn'
  | 'morning'
  | 'lunch'
  | 'afternoon'
  | 'dusk'
  | 'evening'
  | 'late';

function timeBucket(h: number): TimeBucket {
  if (h < 5) return 'deepnight';
  if (h < 8) return 'dawn';
  if (h < 11) return 'morning';
  if (h < 13) return 'lunch';
  if (h < 17) return 'afternoon';
  if (h < 19) return 'dusk';
  if (h < 22) return 'evening';
  return 'late';
}

const BUCKET_TALK: Record<TimeBucket, string[]> = {
  deepnight: ['这么晚了你怎么还没睡。', '夜里了……早点休息。'],
  dawn: ['天亮了，该起了。', '早上的光挺好的。'],
  morning: ['上午了，该干点正事了。', '早上的时间过得好快。'],
  lunch: ['到饭点了，该吃午饭了。', '中午了……你吃了吗。'],
  afternoon: ['下午了，有点犯困。', '这个点最容易走神。'],
  dusk: ['天快黑了，该准备晚饭了。', '傍晚了。'],
  evening: ['晚上了，外面安静下来了。', '这个点最适合待着。'],
  late: ['这么晚了……该准备睡了。', '你还不困吗。'],
};

const PERSONA_TAIL: Record<PersonalityPreset, string[]> = {
  sunny: ['你也没吃吧？', '……我是不是有点啰嗦。', '要不要一起？'],
  gentle: ['……你要一起吗。', '嗯，就这样。', ''],
  cool: ['……别管我。', '我没催你。', ''],
  clingy: ['你别走开。', '……在吗。', ''],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function timeGlance(save: SaveData): string {
  const clock = formatClock(save.clock);
  const bucket = timeBucket(save.clock % 24);
  const base = pick(BUCKET_TALK[bucket]);
  // 有时只是看了看钟，没有下文——像真人一样不刻意
  if (Math.random() < 0.3) return `……${clock} 了。`;
  const tail = pick(PERSONA_TAIL[save.character.personality.preset] ?? ['']);
  return tail ? `${clock}，${base}${tail}` : `${clock}，${base}`;
}

// ── 日记兜底 ────────────────────────────────────────────
const DIARY_BY_MOOD: Record<string, string[]> = {
  happy: ['今天你逗我笑了，我偷偷记下来。', '你今天的样子挺好，我没好意思说。'],
  excited: ['今天你一直在，我心跳得有点快。', '今天太开心了，忍不住写下来。'],
  calm: ['你今天就那样待着，我也觉得挺好。', '今天没什么事，你在就够了。'],
  shy: ['你今天说的话……我不写了。', '耳朵有点热，都怪你。'],
  sleepy: ['你还没睡，我等你一会儿。', '今天好困，写完这句就睡。'],
  sulky: ['你今天有点过分，我不理你了。', '哼，今天的事我记着呢。'],
};

/** 离线时的日记：按当前情绪挑一句第一人称感受。 */
export function offlineDiary(save: SaveData): string {
  const pool = DIARY_BY_MOOD[save.character.mood] ?? DIARY_BY_MOOD.calm;
  return pick(pool);
}

