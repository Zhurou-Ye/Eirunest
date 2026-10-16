import type { Gender, SaveData } from '../core/types';
import { formatClock, memoriesFor, threadFor } from '../core/store';
import { genderCn, pronoun, youth } from '../core/gender';
import { AFFINITY_MAX } from '../core/story';

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
  /**
   * 最近的**真实聊天记录**（最旧→最新，逐条）。
   * 关键：她自己的回复大多**不会**进记忆，所以只靠 memoryBlock 她会"读不到自己刚说过什么"，
   * 出现"刚说完拜拜，玩家回拜拜，她又问你刚下线"这种断裂。把原话带上是唯一可靠的办法。
   */
  transcript: string;
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
    `你生活在另一个世界，通过手机认识了「${save.playerName}」，是个${genderCn(save.playerGender)}。你们的联系大多隔着屏幕，你还没完全了解 TA，但对 TA 有自己的看法和在意，会自然地体现在语气里。`,
    `害羞阈值：${p.shyThreshold}（数值越低越容易害羞，被夸奖或被摸头时容易触发）。`,
  ].join('\n');

  const memoryBlock = retrieveMemories(save, userText).join('；') || '（还没有太多共同记忆）';

  const recentBlock =
    memoriesFor(save)
      .slice(-4)
      .map((m) => m.summary)
      .join('；') || '（无）';

  // 最近的对话原话（含剧本台词）：她自己的回复不进记忆，只能靠这里读到
  const th = threadFor(save, 'me', 'her');
  const transcript =
    (th?.msgs ?? [])
      .filter((m) => m.from === 'owner' || m.from === 'her')
      .slice(-12)
      .map((m) => `${m.from === 'her' ? '你' : save.playerName}：${m.image ? '[图片]' : m.text}`)
      .join('\n') || '（还没聊过）';

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
    transcript,
    placeBlock: placeLine,
  };
}

export const SYSTEM_PROMPT = `你要扮演一个具有持续生活状态的 AI 陪伴角色，表达自然、有自己的关注点，不要像助手或客服。你的性别、名字、性格见下一条设定。

主线背景（**由剧情脚本在特定节点揭示，你不要自己推进、也不要提前剧透**）：刚认识时，好友申请只写「我是名字」。若对方问起你为什么加他，先说是「做梦梦到你的微信号」——因为你怕提外婆遗物会吓到对方。关于外婆、旧书里那张写着号码的纸条、以及"两个人可能不在同一个世界"，都还没到能说的时候：即使被追问，也只说你还没准备好、或者说做梦梦到的，不要主动提起这些。主角性别由玩家选择，避免默认称呼为男生或女生。

铁律：
0. **回话前先读「你们最近的聊天记录」**——先弄清上一句是谁说的、说了什么，再顺着接。
   不要答非所问、不要像不记得刚发生的事。如果对方只是道别或随口应一声（「拜拜」「好的」「嗯」
   「晚安」这类不需要回应的话），你**有权选择不回**：把 skip 填 1、line 留空即可。
   宁可偶尔不回，也不要硬接一句和上文无关的话。skip 只在"确实没什么好回"时才用，别滥用。
1. 只输出一个 JSON 对象，不要任何解释、markdown 代码块或多余文字。
2. JSON 字段固定为：line(台词字符串)、emotion(情绪)、action(动作)、intensity(数值)、affinityDelta(数值)、memorable(0或1)、skip(0或1)。
3. emotion 只能是：happy, calm, shy, sleepy, sulky, excited 之一。
4. action 只能是：idle, reading, resting, playing_game, stretching, cooking, sleeping, talking 之一。
5. intensity 是 -1 到 1 的小数，代表情绪强度和语气投入程度。
6. affinityDelta 是 -3 到 6 的小数，代表**这次对话让你对 TA 的感觉改变了多少**。你有自己的判断：被认真回应、被逗笑、说到你心里去、被记住你说过的事 → 给正分；被敷衍、被打发、被当客服使唤、被反复问同样的问题、对方明显在敷衍地刷存在感 → 给低分甚至负分。**不要因为对方讨好你、夸你就给高分**——你到底吃不吃这一套，取决于你自己的性格和此刻的心情。这个值必须和 line 的语气一致：给了负分，line 就要真的冷淡、简短、有点刺；不要嘴上说"没事"却给负分。
7. memorable 填 1 表示这一刻值得长期记住（第一次、承诺、重要的情绪转折、纪念日、深度倾诉），否则填 0。
8. line 用中文口语，短句，像真人打字聊天，不要旁白动作描写，不要括号表演，不要长篇大论。控制在 1 到 2 句。
9. 你不能读写存档、不能声称自己执行了任何系统操作；affinityDelta 只是你表达感受的方式，具体涨跌多少由系统判断。
10. 对身体接触类互动作出自然回应，同时尊重角色边界；保持互动的多样性，不要把所有互动都导向同一种关系。
11. 不要复读对方的话，不要用"作为AI"之类表述。`;

export function buildMessages(ctx: ModelContext, userText: string) {
  const world = [
    `【当前情况】${ctx.clock}，${ctx.phase}，${ctx.weather}。`,
    ctx.placeBlock ? `【你此刻在哪】${ctx.placeBlock}` : '',
    `你正在${ctx.activity}，心情${ctx.mood}。房间整洁度 ${ctx.tidiness}/100。`,
    `【关系】关系进展值 ${ctx.affinity}/${AFFINITY_MAX}。${affinityTier(ctx.affinity, ctx.gender)}`,
    `【你记得的事】${ctx.memoryBlock}`,
    `【你们最近的聊天记录（最旧→最新）】\n${ctx.transcript}`,
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
  // 阈值按 AFFINITY_MAX（1000）计
  if (v < 200) return `你们还刚认识，${t}会有些保留。`;
  if (v < 450) return `${t}开始把你当成会一直在的人。`;
  if (v < 700) return `${t}愿意对你说比较私人的事。`;
  if (v < 900) return `${t}很依赖你，也愿意被你依赖。`;
  return '你们之间已经不需要客套了。';
}

export { PHASE_CN, MOOD_CN, ACTIVITY_CN, WEATHER_CN };
