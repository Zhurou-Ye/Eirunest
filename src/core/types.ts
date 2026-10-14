/**
 * 全局数据模型。
 * 原则：模型（LLM）永远不接触这里的类型，只通过 IntentSchema 里那几个白名单字段间接影响。
 */

// ── 角色 ──────────────────────────────────────────────

export type PersonalityPreset = 'gentle' | 'cool' | 'sunny' | 'clingy';

export interface Appearance {
  hairColor: string;
  hairStyle: 'short' | 'messy' | 'ponytail';
  eyeColor: string;
  skinTone: string;
  outfit: 'sweater' | 'hoodie' | 'shirt';
  height: number; // 0.9 ~ 1.1 影响绘制缩放
}

export interface Personality {
  preset: PersonalityPreset;
  name: string;
  /** 角色性别。措辞（他/她、少年/少女）全部据此生成 */
  gender: Gender;
  /** 口语化自称，如 "我" / "在下" */
  firstPerson: string;
  /** 称呼玩家的方式 */
  playerAddress: string;
  /** 基础语调关键词，进 prompt */
  tone: string[];
  /** 害羞阈值，越低越容易害羞 */
  shyThreshold: number;
  /** 主动性 0~1，无玩家输入时主动搭话的概率 */
  initiative: number;
  /** 语速（字/秒），影响口型与打字机速度 */
  speechRate: number;
}

export type Mood = 'happy' | 'calm' | 'shy' | 'sleepy' | 'sulky' | 'excited';

/** 性别。角色和主控都用它，措辞（他/她、少年/少女）一律据此生成 */
export type Gender = 'male' | 'female';

/** 主控（玩家）性别，影响角色对玩家的称呼与语气 */
export type PlayerGender = Gender;

export type Energy = 'fresh' | 'okay' | 'tired' | 'exhausted';

export interface CharacterState {
  appearance: Appearance;
  personality: Personality;
  mood: Mood;
  energy: Energy;
  /** 0~100 */
  moodValue: number;
  energyValue: number;
  /** 亲密度 0~100 */
  affinity: number;
  /** 当前所在活动 */
  activity: Activity;
  /** 当前作息阶段 */
  phase: DayPhase;
  /** 喜欢的礼物类型 */
  likedGifts: string[];
  /** 累计互动次数 */
  interactionCount: number;
  /** 上次保存时间戳 */
  lastSavedAt: number;
}

// ── 房间 / 环境 ────────────────────────────────────────

export type DayPhase = 'morning' | 'noon' | 'evening' | 'night';

export type Weather = 'sunny' | 'cloudy' | 'rain' | 'snow';

export interface RoomState {
  lampOn: boolean;
  curtainOpen: boolean;
  /** 桌面/床铺的整洁度 0~100，杂乱会轻微影响心情 */
  tidiness: number;
  weather: Weather;
  /** 已放置的家具 id */
  furniture: string[];
  /** 已解锁的交互道具 */
  props: string[];
}

// ── 记忆 ──────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  /** 归属角色（换人后各自独立，不串记忆） */
  profileId: string;
  /** 游戏内时间戳（小时数累计） */
  at: number;
  /** 真实时间 ISO */
  iso: string;
  kind: 'dialogue' | 'gift' | 'touch' | 'event' | 'milestone';
  summary: string;
  /** 重要度 1~5，影响是否进入长期记忆与亲密度 */
  weight: number;
  /** 关联的情绪标签，供 prompt 检索 */
  tags: string[];
}

export interface RelationshipLog {
  day: number;
  affinity: number;
  mood: number;
  note: string;
}

// ── 日程 / 手机 ────────────────────────────────────────

/**
 * 日程块：某个时段 TA 在哪、在做什么。
 * commit = 必须去（上课 / 上班 / 打工），want = TA 自己想去，rest = 在家休息。
 */
export interface PlanBlock {
  start: number;
  end: number;
  placeId: string;
  kind: 'commit' | 'want' | 'rest';
  label: string;
}

/** 某一天的完整日程。每天由 TA"自己决定"，跨天重建。 */
export interface HerPlan {
  day: number;
  profileId: string;
  blocks: PlanBlock[];
}

/** 相册：TA 出门时随手拍下的照片。 */
export interface PhotoEntry {
  id: string;
  profileId: string;
  iso: string;
  /** 游戏内时间戳（小时） */
  at: number;
  placeId: string;
  caption: string;
  mood: Mood;
}

/** 朋友圈动态。 */
export interface MomentEntry {
  id: string;
  profileId: string;
  /** 谁发的：她 / 我 */
  author: 'her' | 'me';
  iso: string;
  at: number;
  text: string;
  placeId?: string;
  /** 朋友的点赞数（TA 自己算的） */
  likes: number;
  /** 你有没有点过赞 */
  likedByMe: boolean;
  kind: 'outing' | 'diary' | 'gift' | 'event' | 'mine';
  /** 评论区 */
  comments: MomentComment[];
}

export interface MomentComment {
  id: string;
  by: 'her' | 'me' | 'npc';
  name: string;
  text: string;
  at: number;
}

/** 微信联系人 */
export interface Contact {
  id: string;
  name: string;
  emoji: string;
  /** 备注/签名 */
  note: string;
}

/** 微信聊天记录里的一条消息 */
export interface ChatMsg {
  id: string;
  /** 发送者：联系人 id（'me' = 手机主人自己） */
  from: string;
  text: string;
  at: number;
  iso: string;
}

/** 一个会话（她 / 我和某个联系人） */
export interface ChatThread {
  id: string;
  /** 归属角色（她换人后各自独立） */
  profileId: string;
  /** 手机主人：her = 她的手机，me = 我的手机 */
  owner: 'her' | 'me';
  /** 对话方 id */
  contactId: string;
  msgs: ChatMsg[];
  /** 未读条数 */
  unread: number;
}

/** 我自己写的日记（我的手机里手写） */
export interface MyDiaryEntry {
  id: string;
  day: number;
  iso: string;
  text: string;
}

/** 日记：她/他每天（如果此刻想写）留下的第一人称感受。 */
export interface DiaryEntry {
  id: string;
  /** 归属角色 */
  profileId: string;
  /** 游戏内天数（floor(clock/24)） */
  day: number;
  iso: string;
  /** 日记正文，第一人称、口语，1~2 句 */
  text: string;
  /** 写这篇时的情绪 */
  mood: Mood;
}

// ── 存档 ──────────────────────────────────────────────

export interface SaveData {
  version: number;
  /** 当前使用的立绘档案 id */
  profileId: string;
  character: CharacterState;
  room: RoomState;
  memories: MemoryEntry[];
  timeline: RelationshipLog[];
  /** 她的日记（按天记录，最新的在前面） */
  diary: DiaryEntry[];
  /** 当前显示时间（小时，实数；整数部分=时，小数部分=分）。初始化为真实本地时间并持续同步 */
  clock: number;
  /** 玩家手动偏移（小时），用于"时间 +N"预览；真实时间始终在此基础上叠加 */
  timeOffset: number;
  playerName: string;
  /** 主控性别 */
  playerGender: PlayerGender;
  /** 金币：商城里买东西用 */
  coins: number;
  /** 已购买的配件 id */
  ownedAccessories: string[];
  /** 当前戴着的配件 id（每个部位最多一件） */
  equippedAccessories: string[];
  /** TA 今天的日程（跨天重建） */
  herPlan: HerPlan | null;
  /** TA 的相册 */
  photos: PhotoEntry[];
  /** TA 的朋友圈（含我发的） */
  moments: MomentEntry[];
  /** 微信会话（她的 + 我的） */
  threads: ChatThread[];
  /** 我的日记（我的手机里写） */
  myDiary: MyDiaryEntry[];
  /** 我的日程（我的手机里排） */
  myPlan: HerPlan | null;
}

// ── 活动（引擎侧的白名单动作）────────────────────────────

export type Activity =
  | 'idle'
  | 'reading'
  | 'resting'
  | 'playing_game'
  | 'stretching'
  | 'cooking'
  | 'sleeping'
  | 'talking';

// ── 大模型唯一允许输出的结构 ─────────────────────────────

export const EMOTIONS = ['happy', 'calm', 'shy', 'sleepy', 'sulky', 'excited'] as const;
export const ACTIONS = [
  'idle',
  'reading',
  'resting',
  'playing_game',
  'stretching',
  'cooking',
  'sleeping',
  'talking',
] as const;

export type ModelEmotion = (typeof EMOTIONS)[number];
export type ModelAction = (typeof ACTIONS)[number];

/** 模型返回的意图对象。所有字段都经过白名单校验。 */
export interface IntentSchema {
  line: string;
  emotion: ModelEmotion;
  action: ModelAction;
  /** -1 ~ 1，影响语气与表情强度 */
  intensity: number;
  /** 是否记住这件事（0/1） */
  memorable: 0 | 1;
}

export interface DialogueTurn {
  role: 'user' | 'boy';
  text: string;
  iso: string;
  intent?: IntentSchema;
}