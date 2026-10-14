/**
 * 世界 / 大地图。
 *
 * 设计参考《爱相随》《左眼计划》《小忍计划》这类二次元日常养成：
 * 角色有**自己的作息**——上学/上班，会离开小屋去地图上的其他地方；
 * 人不在家时，你只能通过手机联系 TA。地图地点按二次元日常取景命名。
 */

import type { Contact, PersonalityPreset, PlanBlock } from './types';

export type PlaceKind =
  | 'home'
  | 'school'
  | 'office'
  | 'cafe'
  | 'store'
  | 'park'
  | 'station'
  | 'arcade'
  | 'bookstore'
  | 'walk';

export interface Place {
  id: string;
  name: string;
  emoji: string;
  desc: string;
  kind: PlaceKind;
  /** 在小地图上的归一化坐标（0~1） */
  mx: number;
  my: number;
}

export const PLACES: Place[] = [
  { id: 'home', name: '小屋', emoji: '🏠', desc: '你们一起住的地方。', kind: 'home', mx: 0.2, my: 0.72 },
  { id: 'school', name: '学校', emoji: '🏫', desc: '上课、社团、午休的地方。', kind: 'school', mx: 0.7, my: 0.24 },
  { id: 'office', name: '公司', emoji: '🏢', desc: '上班的地方，一坐一整天。', kind: 'office', mx: 0.78, my: 0.4 },
  { id: 'cafe', name: '街角咖啡店', emoji: '☕', desc: '安静，适合发呆和等人。', kind: 'cafe', mx: 0.44, my: 0.5 },
  { id: 'store', name: '便利店', emoji: '🏪', desc: '进门就是"欢迎光临"，可以打工。', kind: 'store', mx: 0.26, my: 0.44 },
  { id: 'park', name: '河滨公园', emoji: '🌳', desc: '傍晚散步、看夕阳的地方。', kind: 'park', mx: 0.62, my: 0.7 },
  { id: 'station', name: '车站', emoji: '🚉', desc: '早高峰人挤人，通勤必经。', kind: 'station', mx: 0.5, my: 0.14 },
  { id: 'arcade', name: '游戏厅', emoji: '🎮', desc: '灯很亮，抓娃娃机永远差一点点。', kind: 'arcade', mx: 0.84, my: 0.66 },
  { id: 'bookstore', name: '旧书店', emoji: '📚', desc: '有股纸的味道，能待一整个下午。', kind: 'bookstore', mx: 0.36, my: 0.28 },
];

export function getPlace(id: string): Place {
  return PLACES.find((p) => p.id === id) ?? PLACES[0];
}

/** 生活类型：学生 / 上班族。决定作息走学校还是公司。 */
export type LifeType = 'student' | 'worker';

/**
 * 她此刻在哪。以真实时间为轴（工作日按上学/上班作息）。
 * 返回 place id；'home' 表示在家（可当面互动），其余表示出门了（只能用手机）。
 */
export function herPlaceAt(life: LifeType, hour: number, weekday: number): string {
  const h = hour % 24;
  const weekend = weekday === 0 || weekday === 6;

  // 深夜/凌晨：在家睡觉
  if (h >= 23 || h < 6) return 'home';

  if (life === 'student') {
    if (weekend) {
      if (h < 9) return 'home';
      if (h < 12) return 'park';
      if (h < 15) return 'cafe';
      if (h < 18) return 'arcade';
      return 'home';
    }
    if (h < 7.5) return 'home'; // 起床洗漱
    if (h < 8) return 'station'; // 上学路上
    if (h < 12) return 'school';
    if (h < 13) return 'cafe'; // 午休
    if (h < 16.5) return 'school';
    if (h < 18) return 'bookstore'; // 放学后
    return 'home'; // 回家
  }

  // worker
  if (weekend) {
    if (h < 10) return 'home';
    if (h < 13) return 'cafe';
    if (h < 17) return 'park';
    if (h < 20) return 'store';
    return 'home';
  }
  if (h < 8) return 'home';
  if (h < 9) return 'station'; // 通勤
  if (h < 12.5) return 'office';
  if (h < 13.5) return 'cafe'; // 午休
  if (h < 18) return 'office';
  if (h < 19) return 'store'; // 下班顺路
  return 'home';
}

/** 她在外时，对"她在做什么"的一句话描述（用于地图/手机头部） */
export function placeActivityLine(placeId: string, life: LifeType): string {
  const map: Record<string, { student: string; worker: string }> = {
    school: { student: '在上课', worker: '在外面' },
    office: { student: '在外面', worker: '在上班' },
    cafe: { student: '在咖啡店歇脚', worker: '在咖啡店坐一会儿' },
    store: { student: '在便利店', worker: '在便利店买东西' },
    park: { student: '在公园', worker: '在公园走走' },
    station: { student: '在路上', worker: '在通勤路上' },
    arcade: { student: '在游戏厅', worker: '在游戏厅' },
    bookstore: { student: '在旧书店', worker: '在旧书店' },
    home: { student: '在家', worker: '在家' },
    walk: { student: '在外面', worker: '在外面' },
  };
  return map[placeId]?.[life] ?? '在外面';
}

/** 可以打工的地点 */
export const WORK_SPOTS = ['store', 'cafe'] as const;

// ── 她自己的兼职（不是玩家的）──────────────────────────
/**
 * TA 的固定工作。定了就必须去——这正是"她若有便利店店员的工作，那就一定要去"。
 * days 是"每周哪几天"，0=周日。
 */
export interface HerJob {
  name: string;
  emoji: string;
  placeId: string;
  days: number[];
  /** 上班开始/结束（小时，实数） */
  start: number;
  end: number;
}

export interface JobDef {
  id: string;
  placeId: string;
  name: string;
  emoji: string;
  /** 单次时长（真实秒） */
  seconds: number;
  /** 单次报酬（金币） */
  pay: number;
  /** 营业时间 [开始, 结束)（小时）。非营业时间不能打工 */
  open: [number, number];
  /** 只在哪些天营业（0=周日）。缺省=每天 */
  days?: number[];
  desc: string;
}

export const JOBS: JobDef[] = [
  {
    id: 'convenience',
    placeId: 'store',
    name: '便利店店员',
    emoji: '🏪',
    seconds: 12,
    pay: 40,
    open: [7, 23],
    desc: '理货、收银，站一会儿就到点。',
  },
  {
    id: 'barista',
    placeId: 'cafe',
    name: '咖啡店帮工',
    emoji: '☕',
    seconds: 15,
    pay: 55,
    open: [8, 21],
    desc: '拉花、擦桌子，能闻到咖啡味。',
  },
];

export function hm(x: number): string {
  const h = Math.floor(x % 24);
  const m = Math.round((x % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 这份工现在能不能打（营业时间 + 营业日） */
export function isJobOpen(job: JobDef, hour: number, weekday: number): boolean {
  if (job.days && !job.days.includes(weekday)) return false;
  const h = hour % 24;
  return h >= job.open[0] && h < job.open[1];
}

export function jobHoursText(job: JobDef): string {
  const days = job.days ? `周${job.days.map((d) => '日一二三四五六'[d]).join('')} ` : '';
  return `${days}${hm(job.open[0])}–${hm(job.open[1])}`;
}

// ── 她每天的日程 ───────────────────────────────────────

/** 小种子随机：同一天同一个角色，结果稳定（"她今天就是这么决定的"） */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 空闲时 TA 会想去哪（按性格给不同偏好） */
const WANT_POOL: Record<PersonalityPreset, { placeId: string; label: string }[]> = {
  sunny: [
    { placeId: 'arcade', label: '去游戏厅疯一会儿' },
    { placeId: 'park', label: '去河滨公园走走' },
    { placeId: 'cafe', label: '去咖啡店吃点甜的' },
    { placeId: 'bookstore', label: '去旧书店翻翻' },
  ],
  gentle: [
    { placeId: 'bookstore', label: '去旧书店待着' },
    { placeId: 'cafe', label: '去咖啡店安静坐会儿' },
    { placeId: 'park', label: '去公园散步' },
  ],
  cool: [
    { placeId: 'bookstore', label: '去旧书店' },
    { placeId: 'station', label: '去车站附近逛逛' },
    { placeId: 'cafe', label: '去咖啡店' },
  ],
  clingy: [
    { placeId: 'cafe', label: '去咖啡店' },
    { placeId: 'park', label: '去公园' },
    { placeId: 'store', label: '去便利店买点东西' },
  ],
};

/**
 * 给某一天生成 TA 的日程。
 * 组成 = 固定作息（课 / 班）+ TA 的兼职（必须去）+ 空档里"自己想去"的地方。
 * 没有玩家指挥，这是她自己过的一天。
 */
export function buildHerPlan(opts: {
  profileId: string;
  life: LifeType;
  job?: HerJob;
  personality: PersonalityPreset;
  weekday: number;
  day: number;
  energy: number;
}): PlanBlock[] {
  const { profileId, life, job, personality, weekday, day, energy } = opts;
  const rnd = rngFrom(hashStr(`${profileId}#${day}`));
  const weekend = weekday === 0 || weekday === 6;
  const blocks: PlanBlock[] = [];
  const push = (start: number, end: number, placeId: string, kind: PlanBlock['kind'], label: string) => {
    if (end - start < 0.2) return;
    blocks.push({ start, end, placeId, kind, label });
  };

  const sleepEnd = weekend ? 8.5 : 7;
  push(0, sleepEnd, 'home', 'rest', '在家睡觉');

  // 必须去的：上学 / 上班
  if (life === 'student' && !weekend) {
    push(8, 12, 'school', 'commit', '在学校上课');
    push(13, 16.5, 'school', 'commit', '在学校上课');
  } else if (life === 'worker' && !weekend) {
    push(9, 12.5, 'office', 'commit', '在公司上班');
    push(13.5, 18, 'office', 'commit', '在公司上班');
  }
  // 她的兼职：定了就一定去
  if (job && job.days.includes(weekday)) {
    push(job.start, job.end, job.placeId, 'commit', `在${getPlace(job.placeId).name}做${job.name}`);
  }

  const nightStart = 22.5;
  push(nightStart, 24, 'home', 'rest', '在家准备睡了');

  // 空档：她自己决定要不要出门
  const ordered = blocks.slice().sort((a, b) => a.start - b.start);
  const gaps: { s: number; e: number }[] = [];
  let cursor = sleepEnd;
  for (const b of ordered) {
    if (b.start > cursor + 0.2) gaps.push({ s: cursor, e: Math.min(b.start, nightStart) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < nightStart - 0.2) gaps.push({ s: cursor, e: nightStart });

  const pool = WANT_POOL[personality] ?? WANT_POOL.gentle;
  let chance = weekend ? 0.78 : 0.42;
  chance *= 0.7 + (energy / 100) * 0.6; // 有精神才想出门
  if (personality === 'clingy') chance *= 0.7;

  for (const g of gaps) {
    const len = g.e - g.s;
    if (len < 1.5) {
      push(g.s, g.e, 'home', 'rest', '在家待着');
      continue;
    }
    if (rnd() < chance) {
      const dur = Math.min(len, 1.5 + rnd() * 1.6);
      const ws = g.s + rnd() * (len - dur);
      const we = ws + dur;
      if (ws > g.s + 0.2) push(g.s, ws, 'home', 'rest', '在家待着');
      const w = pool[Math.floor(rnd() * pool.length)];
      push(ws, we, w.placeId, 'want', w.label);
      if (we < g.e - 0.2) push(we, g.e, 'home', 'rest', '在家待着');
    } else {
      push(g.s, g.e, 'home', 'rest', '在家待着');
    }
  }

  return blocks.sort((a, b) => a.start - b.start);
}

/** 某时刻落在日程的哪一块 */
export function planAt(blocks: PlanBlock[], hour: number): PlanBlock | null {
  const h = hour % 24;
  for (const b of blocks) if (h >= b.start && h < b.end) return b;
  return blocks.length ? blocks[0] : null;
}

/** 一句话念出她今天的安排（只念"要去的地方"，睡觉待着不算） */
export function describePlan(blocks: PlanBlock[]): string {
  const parts = blocks.filter((b) => b.kind !== 'rest').map((b) => `${hm(b.start)} ${b.label}`);
  return parts.join('，') || '今天没什么安排，就在家待着。';
}

// ── 微信 / 通讯录 ──────────────────────────────────────

/** 她的通讯录：你 + 家人 + 同学/同事 */
export function herContacts(life: LifeType, playerName: string): Contact[] {
  const list: Contact[] = [
    { id: 'me', name: playerName || '你', emoji: '🧡', note: '一起住的人' },
    { id: 'mom', name: '妈妈', emoji: '👩', note: '家人' },
  ];
  if (life === 'student') {
    list.push({ id: 'friend', name: '小夏', emoji: '🌸', note: '同班，话很多' });
    list.push({ id: 'club', name: '社团群', emoji: '🎈', note: '6 人' });
  } else {
    list.push({ id: 'colleague', name: '阿哲', emoji: '🧢', note: '同部门同事' });
    list.push({ id: 'boss', name: '组长', emoji: '📋', note: '工作' });
  }
  return list;
}

/** 我的通讯录 */
export function myContacts(herName: string): Contact[] {
  return [
    { id: 'her', name: herName, emoji: '🌙', note: '住在一起' },
    { id: 'mom', name: '妈妈', emoji: '👩', note: '家人' },
    { id: 'buddy', name: '老周', emoji: '🎧', note: '认识很多年' },
  ];
}

/** 她出门时，可能顺手给谁发条消息（她的手机里会看到） */
export function herOutingMessage(
  placeId: string,
  life: LifeType,
  personality: PersonalityPreset,
): { contactId: string; text: string } | null {
  const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
  const friendId = life === 'student' ? 'friend' : 'colleague';
  switch (placeId) {
    case 'school':
      return { contactId: friendId, text: pick(['今天第一节课好困啊', '你在教室吗，帮我占个位', '下课一起去买瓶水？']) };
    case 'office':
      return { contactId: friendId, text: pick(['这个会开得也太久了', '表格我改完发你了', '中午一起吃饭？']) };
    case 'store':
      return { contactId: friendId, text: pick(['我今天晚班，先不一起走了', '店里关东煮打折，要不要带一份', '站了一天，腿快废了']) };
    case 'cafe':
      return { contactId: friendId, text: pick(['这家的拿铁还行', '我在咖啡店坐会儿，晚点回']) };
    case 'park':
      return { contactId: friendId, text: pick(['今天风挺舒服的', '在河边走了两圈']) };
    case 'arcade':
      return { contactId: friendId, text: pick(['抓娃娃又差一点点', '这游戏厅音效好大声']) };
    case 'bookstore':
      return { contactId: friendId, text: pick(['旧书店翻到一本好东西', '在这儿待了一下午']) };
    case 'station':
      return { contactId: friendId, text: pick(['车又晚点了', '人好多，挤死我了']) };
    default:
      if (personality === 'clingy') return { contactId: 'mom', text: pick(['妈，我今天不出门了', '吃过了，别担心']) };
      return null;
  }
}
