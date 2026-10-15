/**
 * 演化（evolution）——这个项目的「二阶变化」层。
 *
 * 之前所有变化都只有一个来源：按时钟重算，或数值单调上升。
 * 于是"明天的她"和"今天的她"永远是同一个人。这里补上缺的那一环：
 *
 *     经历 ──► traits（人格倾向）──► 以后的行为规则本身
 *
 * 关键在于最后一步是**改写规则**，不是改写数值：
 * 经历改变了主动概率、害羞阈值、心情衰减速度、出门偏好，
 * 所以同样一句"在干嘛"，一个被回应了很多次的她和被冷落了很多次的她，
 * 会做出不一样的选择。这就是"人格由机制长期积累"的最小实现。
 *
 * 本文件只依赖类型与世界数据，不碰 Store / UI，保证可单独测试。
 */

import type { PlanBlock, SaveData, Traits } from './types';
import { TRAIT_PRESETS } from './presets';
import { getPlace, personAt } from './world';

// ── 经历 ────────────────────────────────────────────────

/**
 * 一次"经历"的类型。
 * 全部由引擎判定（玩家做了什么、她做了什么、有没有被回应），
 * 模型无法伪造经历——它连这个枚举都碰不到。
 */
export type ExperienceKind =
  | 'chat_reply' // 她开口，你接了
  | 'chat_ignored' // 她主动找你，你没回
  | 'touch' // 身体接触
  | 'gift' // 收到礼物
  | 'activity' // 一起做了点什么
  | 'outgoing' // 她自己出门、见了人
  | 'lonely_hours'; // 你很久没来

/**
 * 每类经历对 traits 的推动量。
 *
 * 数值刻意都很小（千分之几）：人格应该是"攒"出来的，
 * 一次互动不该让一个人改性子；几百次互动才看得出方向。
 */
const EFFECTS: Record<ExperienceKind, Partial<Traits>> = {
  chat_reply: { expressiveness: 0.012, guardedness: -0.008, clinginess: -0.003 },
  chat_ignored: { clinginess: 0.02, expressiveness: -0.008, guardedness: 0.012 },
  touch: { guardedness: -0.016, clinginess: 0.008 },
  gift: { clinginess: 0.01, expressiveness: 0.008 },
  activity: { guardedness: -0.01, expressiveness: 0.01 },
  outgoing: { expressiveness: 0.01, clinginess: -0.008 },
  lonely_hours: { clinginess: 0.014, expressiveness: -0.006 },
};

/** 给 UI / 日志用的可读原因 */
const REASON: Record<ExperienceKind, string> = {
  chat_reply: '你认真回了她的话',
  chat_ignored: '她主动找你，没等到回音',
  touch: '被靠近了很多次',
  gift: '老是被送东西',
  activity: '一起做了不少事',
  outgoing: '自己出门见了人',
  lonely_hours: '你很久没来',
};

function clamp3(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v * 1000) / 1000));
}

/**
 * 取某个预设的起始 traits。
 * 一定返回一份**拷贝**并带兜底：查不到预设时退回 gentle，
 * 绝不能返回 undefined 或共享对象——前者会做出一个空 traits 把界面打崩，
 * 后者会让所有角色共享同一份数值（改一个人等于改所有人）。
 */
function presetTraits(preset: SaveData['character']['personality']['preset']): Traits {
  return { ...(TRAIT_PRESETS[preset] ?? TRAIT_PRESETS.gentle) };
}

/**
 * 取 traits；老存档没有就地补一份。
 */
function traitsOf(save: SaveData): Traits {
  if (!save.character.traits) {
    save.character.traits = presetTraits(save.character.personality.preset);
  }
  return save.character.traits;
}

/**
 * 把一次经历写进 traits。
 *
 * 有两处非线性，是故意的：
 * - 戒备心越高，身体接触越难降低它（防御强的人不容易被拉近）
 * - 越黏人，被冷落时黏人度涨得越快（越在意越容易更在意）
 * 没有这两条，traits 就只是线性漂移，那是"统计"不是"性格"。
 */
export function applyExperience(save: SaveData, kind: ExperienceKind, at = save.clock): boolean {
  const t = traitsOf(save);
  const eff = EFFECTS[kind];
  const before = { ...t };

  let scale = 1;
  if (kind === 'touch') scale = 1 - t.guardedness * 0.8;
  if (kind === 'chat_ignored') scale = 0.6 + t.clinginess * 0.9;
  scale = clamp3(scale, 0.1, 1.6);

  t.expressiveness = clamp3(t.expressiveness + (eff.expressiveness ?? 0) * scale, 0.05, 0.95);
  t.clinginess = clamp3(t.clinginess + (eff.clinginess ?? 0) * scale, 0.05, 0.95);
  t.guardedness = clamp3(t.guardedness + (eff.guardedness ?? 0) * scale, 0.05, 0.95);
  save.character.traits = t;

  const moved =
    Math.abs(t.expressiveness - before.expressiveness) +
    Math.abs(t.clinginess - before.clinginess) +
    Math.abs(t.guardedness - before.guardedness);

  if (moved < 0.004) return false; // 几乎没动，不留痕
  recordTraitPoint(save, REASON[kind], at);
  return true;
}

/** 记一个回溯点：她为什么会变成现在这样 */
export function recordTraitPoint(save: SaveData, reason: string, at = save.clock): void {
  const t = traitsOf(save);
  const day = Math.floor(at / 24);
  const last = save.traitHistory[save.traitHistory.length - 1];
  // 同一天、同一个原因只留一条，避免刷屏
  if (last && last.day === day && last.reason === reason) {
    last.expressiveness = t.expressiveness;
    last.clinginess = t.clinginess;
    last.guardedness = t.guardedness;
    return;
  }
  save.traitHistory.push({
    day,
    iso: new Date().toISOString(),
    expressiveness: t.expressiveness,
    clinginess: t.clinginess,
    guardedness: t.guardedness,
    reason,
  });
  if (save.traitHistory.length > 200) save.traitHistory.splice(0, save.traitHistory.length - 200);
}

// ── traits 反过来驱动行为 ────────────────────────────────

export interface EffectiveStats {
  expressiveness: number;
  clinginess: number;
  guardedness: number;
  /** 主动找你搭话的概率（替换原来写死的 personality.initiative） */
  initiative: number;
  /** 害羞阈值（越低越容易害羞；戒备心越高这里越小） */
  shyThreshold: number;
  /** 日程里"今天想出门"的概率倍率 */
  outgoingBias: number;
  /** 你不在的每小时，心情掉多少 */
  moodLossPerHour: number;
}

/**
 * 把 traits 折算成"此刻生效的行为参数"。
 *
 * 原来的 initiative / shyThreshold 直接读 Personality 里的常量，
 * 现在它们变成由 traits 推出的派生值 —— 这就是"规则本身被经历改写"的落点。
 */
export function effectiveStats(save: SaveData): EffectiveStats {
  const base = save.character.personality;
  const t = traitsOf(save);
  return {
    expressiveness: t.expressiveness,
    clinginess: t.clinginess,
    guardedness: t.guardedness,
    initiative: clamp3(base.initiative * (0.45 + t.expressiveness * 1.1), 0.05, 0.95),
    shyThreshold: clamp3(base.shyThreshold * (1.25 - t.guardedness * 0.75), 0.08, 0.95),
    outgoingBias: clamp3(0.75 + (t.expressiveness - t.guardedness) * 0.6, 0.4, 1.4),
    moodLossPerHour: clamp3(0.3 + t.clinginess, 0.25, 1.35),
  };
}

/** traits 的可读描述，给状态面板用 */
export function describeTraits(save: SaveData): { key: string; label: string; value: number }[] {
  const t = traitsOf(save);
  // 存档可能来自旧版本或被手改过，非数值一律用中性值兜底，
  // 不让一个坏字段把整个面板打崩。
  const num = (v: number | undefined, fb: number) => (Number.isFinite(v) ? (v as number) : fb);
  return [
    { key: 'exp', label: '表达欲', value: num(t.expressiveness, 0.5) },
    { key: 'cli', label: '黏人度', value: num(t.clinginess, 0.5) },
    { key: 'gua', label: '戒备心', value: num(t.guardedness, 0.5) },
  ];
}

/**
 * 和"刚认识时的她"比，她往哪个方向长了一点。
 * 这是面板上最能说明"她变了"的一句话。
 */
export function evolutionLine(save: SaveData): string {
  const start = TRAIT_PRESETS[save.character.personality.preset];
  const t = traitsOf(save);
  const d = {
    exp: t.expressiveness - start.expressiveness,
    cli: t.clinginess - start.clinginess,
    gua: t.guardedness - start.guardedness,
  };
  const parts: string[] = [];
  if (d.exp > 0.04) parts.push('比以前更愿意主动开口');
  if (d.exp < -0.04) parts.push('比以前更少主动说话');
  if (d.cli > 0.04) parts.push('比以前更在意你有没有回应');
  if (d.cli < -0.04) parts.push('没有以前那么黏人了');
  if (d.gua > 0.04) parts.push('比刚认识时更收着一点');
  if (d.gua < -0.04) parts.push('比刚认识时放松了很多');
  if (!parts.length) return '她还是刚认识时的样子，变化还看不出来。';
  return `${parts.join('、')}。`;
}

// ── 离线期间：世界自己走了一段 ──────────────────────────

/** 离线期间"发生过"的一件事（由日程 + traits 推出来，回来时补记） */
export interface OfflineEvent {
  /** 游戏内小时，用来写 photo.at */
  at: number;
  placeId: string;
  caption: string;
  /** 朋友圈文案 */
  text: string;
  /** 如果她在那里遇到了人 */
  person: { id: string; name: string; emoji: string; note: string; placeId: string; greet?: string } | null;
}

/**
 * 你不在的时候，她按自己的日程走了这一段路。
 *
 * 这是修掉"她一直在等你"那句谎话的地方：
 * 之前离线只结算精力，回来后看到的日程是"按时课表重新算出来的"，不是发生过的事。
 * 现在把她错过的时段按日程重放一遍，把去过的地点变成真实留下的照片与朋友圈，
 * 于是"世界在你不在时也推进过"是可查的，而不是一句设定。
 */
export function planOfflineEvents(save: SaveData, hoursAway: number): OfflineEvent[] {
  const blocks: PlanBlock[] = save.herPlan?.blocks ?? [];
  if (!blocks.length || hoursAway < 1) return [];

  const end = save.clock;
  const start = Math.max(0, end - Math.min(hoursAway, 12));
  const events: OfflineEvent[] = [];
  const seen = new Set<string>();

  // 按"日程块"和缺席窗口求交集，而不是逐整点采样：
  // 她 20:30 才去的公园，不该因为整点没踩到就被当成"没去过"。
  for (const b of blocks.slice().sort((x, y) => x.start - y.start)) {
    if (events.length >= 4) break;
    if (b.placeId === 'home' || b.kind === 'rest') continue;
    const s = Math.max(b.start, start);
    const e = Math.min(b.end, end);
    if (e - s < 0.5) continue; // 只是擦边经过，不算"去过"
    if (seen.has(b.placeId)) continue;
    seen.add(b.placeId);

    const p = getPlace(b.placeId);
    const person = personAt(b.placeId);
    events.push({
      at: Math.round(((s + e) / 2) * 100) / 100,
      placeId: b.placeId,
      caption: b.label || `在${p.name}`,
      text: b.label ? `今天${b.label}。` : `在${p.name}。`,
      person: person
        ? {
            id: person.id,
            name: person.name,
            emoji: person.emoji,
            note: person.note,
            placeId: person.placeId,
            greet: person.greet,
          }
        : null,
    });
  }
  return events;
}

/** 把离线事件折进 traits（她一个人待着 / 出门见人，都会留下痕迹） */
export function foldOfflineIntoTraits(save: SaveData, events: OfflineEvent[], hoursAway: number): void {
  for (const _e of events) applyExperience(save, 'outgoing', save.clock);
  if (hoursAway >= 3) applyExperience(save, 'lonely_hours', save.clock);
}
