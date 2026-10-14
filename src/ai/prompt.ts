import type { Gender, SaveData } from '../core/types';
import { formatClock, memoriesFor } from '../core/store';
import { genderCn, pronoun, youth } from '../core/gender';

/**
 * 从世界状态里"抽取"给模型看的上下文。
 * 关键：这是单向的。模型能读，但不能写。
 */
export interface ModelContext {
  boyName: string;
  /** 角色性别，供 buildMessages 生成正确措辞 */
  gender: Gender;
  playerName: string;
  clock: string;
  phase: string;
  mood: string;
  activity: string;
  affinity: number;
  tidiness: number;
  weather: string;
  personaBlock: string;
  memoryBlock: string;
  recentBlock: string;
  /** 她此刻在哪（在家/出门），供模型保持情境一致 */
  placeBlock: string;
}

const PHASE_CN: Record<string, string> = {
  morning: '早上',
  noon: '白天',
  evening: '傍晚',
  night: '夜里',
};

const MOOD_CN: Record<string, string> = {
  happy: '开心',
  calm: '平静',
  shy: '有点害羞',
  sleepy: '困倦',
  sulky: '闹别扭',
  excited: '很兴奋',
};

const ACTIVITY_CN: Record<string, string> = {
  idle: '发呆',
  reading: '看书',
  resting: '休息',
  playing_game: '打游戏',
  stretching: '伸展身体',
  cooking: '做饭',
  sleeping: '睡着了',
  talking: '和人说话',
};

const WEATHER_CN: Record<string, string> = {
  sunny: '晴',
  cloudy: '多云',
  rain: '下雨',
  snow: '下雪',
};

/**
 * 检索长期记忆：按重要度 + 时间接近度 + 关键词重合度打分，取前 n 条。
 * 纯本地实现，将来可换成向量检索而不改调用方。
 */
export function retrieveMemories(
  save: SaveData,
  userText: string,
  limit = 5,
): string[] {
  const keywords = extractKeywords(userText);
  const now = save.clock;

  const scored = memoriesFor(save).map((m) => {
    let score = m.weight * 2;
    const daysAgo = Math.abs(now - m.at) / 24;
    score += Math.max(0, 6 - daysAgo); // 最近的记忆优先
    for (const kw of keywords) {
      if (m.summary.includes(kw) || m.tags.some((t) => t.includes(kw))) score += 3;
    }
    return { m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.m.summary);
}

function extractKeywords(text: string): string[] {
  const cleaned = text.replace(/[，。！？、,.!?\s]/g, '');
  const out: string[] = [];
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= cleaned.length; i++) {
      out.push(cleaned.slice(i, i + n));
    }
  }
  return out;
}

export function buildContext(save: SaveData, userText: string, placeLine = ''): ModelContext {
  const c = save.character;
  const p = c.personality;

  const personaBlock = [
    `你叫${p.name}，是一个${c.appearance.height > 1.02 ? '偏高挑' : c.appearance.height < 0.98 ? '偏娇小' : '中等身量'}的${youth(p.gender)}。`,
    `性格基调：${p.tone.join('、')}。`,
    `你自称「${p.firstPerson}」，称呼对方为「${p.playerAddress}」。`,
    `和你一起住的人叫「${save.playerName}」，是个${genderCn(save.playerGender)}。你对 TA 有自己的看法和在意，会自然地体现在语气里。`,
    `害羞阈值：${p.shyThreshold}（数值越低越容易害羞，被夸奖或被摸头时容易触发）。`,
  ].join('\n');

  const memoryBlock = retrieveMemories(save, userText).join('；') || '（还没有太多共同记忆）';

  const recentBlock =
    memoriesFor(save)
      .slice(-4)
      .map((m) => m.summary)
      .join('；') || '（无）';

  return {
    boyName: p.name,
    gender: p.gender,
    playerName: save.playerName,
    clock: formatClock(save.clock),
    phase: PHASE_CN[c.phase] ?? c.phase,
    mood: MOOD_CN[c.mood] ?? c.mood,
    activity: ACTIVITY_CN[c.activity] ?? c.activity,
    affinity: c.affinity,
    tidiness: save.room.tidiness,
    weather: WEATHER_CN[save.room.weather] ?? save.room.weather,
    personaBlock,
    memoryBlock,
    recentBlock,
    placeBlock: placeLine,
  };
}

export const SYSTEM_PROMPT = `你要扮演一个和对方同居生活的人，演出"活生生的人"，不是助手、不是聊天机器人。你的性别、名字、性格见下一条设定。

铁律：
1. 只输出一个 JSON 对象，不要任何解释、markdown 代码块或多余文字。
2. JSON 字段固定为：line(台词字符串)、emotion(情绪)、action(动作)、intensity(数值)、memorable(0或1)。
3. emotion 只能是：happy, calm, shy, sleepy, sulky, excited 之一。
4. action 只能是：idle, reading, resting, playing_game, stretching, cooking, sleeping, talking 之一。
5. intensity 是 -1 到 1 的小数，代表情绪强度和语气投入程度。
6. memorable 填 1 表示这一刻值得长期记住（第一次、承诺、重要的情绪转折、纪念日、深度倾诉），否则填 0。
7. line 用中文口语，短句，像真人打字聊天，不要旁白动作描写，不要括号表演，不要长篇大论。控制在 1 到 2 句。
8. 你不能控制游戏数值、不能读写存档、不能声称自己执行了任何系统操作。
9. 涉及亲密接触的请求要自然害羞但不拒绝，边界感靠害羞与转移话题表达。
10. 不要复读对方的话，不要用"作为AI"之类表述。`;

export function buildMessages(ctx: ModelContext, userText: string) {
  const world = [
    `【当前情况】${ctx.clock}，${ctx.phase}，${ctx.weather}。`,
    ctx.placeBlock ? `【你此刻在哪】${ctx.placeBlock}` : '',
    `你正在${ctx.activity}，心情${ctx.mood}。房间整洁度 ${ctx.tidiness}/100。`,
    `【关系】亲密度 ${ctx.affinity}/100。${affinityTier(ctx.affinity, ctx.gender)}`,
    `【你记得的事】${ctx.memoryBlock}`,
    `【刚刚发生】${ctx.recentBlock}`,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `${ctx.personaBlock}\n\n${world}` },
    { role: 'user', content: userText },
  ] as { role: string; content: string }[];
}

export function affinityTier(v: number, gender: Gender = 'female'): string {
  const t = pronoun(gender);
  if (v < 20) return `你们还刚认识，${t}会有些保留。`;
  if (v < 45) return `${t}开始把你当成会一直在的人。`;
  if (v < 70) return `${t}愿意对你说比较私人的事。`;
  if (v < 90) return `${t}很依赖你，也愿意被你依赖。`;
  return '你们之间已经不需要客套了。';
}

export { PHASE_CN, MOOD_CN, ACTIVITY_CN, WEATHER_CN };