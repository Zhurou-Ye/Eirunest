/**
 * 全局数据模型。
 * 原则：模型（LLM）永远不接触这里的类型，只通过 IntentSchema 里那几个白名单字段间接影响。
 */

/**
 * NPC agent 的状态（持久化）。
 * 定义放在这里而不是 npc.ts，是为了避免 types ⇄ npc 的类型循环。
 * 人设、剧透门控、台词校验那套逻辑在 npc.ts。
 */
export interface NpcState {
  id: string;
  /** 她对玩家/女主的信任 0~1 */
  trust: number;
  /** 她是否已经察觉女主违背遗训、联系了另一个世界的人 */
  knowsContact: boolean;
  /**
   * 她是否已经**偷偷**把两个世界打通了（这正是"视界重叠"那一刻的幕后原因）。
   * 她对谁都没说 —— 说出来这一幕就废了。
   */
  secretlyOpened: boolean;
  /** 玩家是否已经被告知"是她做的"。在她自己承认之前，禁词门一直关着。 */
  revealed: boolean;
}

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

/**
 * 人格倾向（traits）。
 *
 * 和 Personality 的区别是关键：
 * Personality 是「出生设定」——预设给什么就是什么，一辈子不变。
 * Traits 是「被经历改写的倾向」——同样的预设，遇到不同的事，会慢慢长成不同的人。
 *
 * 它才是"人格不是写死的、而是长期积累出来的"这一点的实现：
 * 互动 → 微调 traits → traits 反过来改变主动概率、害羞阈值、心情衰减、出门偏好，
 * 于是「明天的她」和「今天的她」不再是同一个数值。
 */
export interface Traits {
  /** 表达欲 0~1：越高越主动开口、越爱发状态与日记 */
  expressiveness: number;
  /** 黏人度 0~1：越高越在意有没有被回应，被冷落时心情掉得越快 */
  clinginess: number;
  /** 戒备心 0~1：越高越容易害羞、越难被身体接触拉近 */
  guardedness: number;
}

/** traits 的一次变动记录，用于「她为什么会变成这样」的回溯 */
export interface TraitPoint {
  /** 游戏内天数 */
  day: number;
  iso: string;
  expressiveness: number;
  clinginess: number;
  guardedness: number;
  /** 这次变动的原因（一句话） */
  reason: string;
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
  /** 会被经历改写的人格倾向（见 Traits 注释） */
  traits: Traits;
  mood: Mood;
  energy: Energy;
  /** 0~100 */
  moodValue: number;
  energyValue: number;
  /** 亲密度 0~AFFINITY_MAX（当前 1000，见 core/story.ts） */
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
  /** 生成的照片路径（相册里用真图；缺省时退化成配色卡片） */
  img?: string;
}

/** 微信状态：一个状态词 + 一句感受，24 小时后自动过期。 */
export interface WxStatus {
  emoji: string;
  /** 状态词，如「上课」 */
  word: string;
  /** 她自己写的一句感受 */
  text: string;
  at: number;
}

/** 在世界里认识的人（按地点结识，可以加进通讯录） */
export interface MetPerson {
  id: string;
  name: string;
  emoji: string;
  /** 一句话介绍 */
  note: string;
  /** 在哪认识的 */
  placeId: string;
  at: number;
  /** 是否已加进通讯录（玩家侧） */
  added: boolean;
  /** 玩家给 TA 设的备注名（接受好友申请时填写） */
  remark?: string;
  /**
   * 她那边是否"认识"了这个人（共同好友）。
   * 她的朋友圈里，这个人的评论会显示给我看；我的朋友圈里，同理。
   * 不认识的人评论，我们互相看不到。
   */
  mutual?: boolean;
}

/** 有限视角追踪：她只有"查手机"才能看到玩家新发的东西。 */
export interface PerspectiveTracker {
  /** 玩家最新一次"发内容"（状态/朋友圈/聊天）时的游戏小时数 */
  myLastUpdate: number;
  /** 她上一次"主动查手机"的时刻。myLastUpdate <= herLastCheck 时视为她已看见。 */
  herLastCheck: number;
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
  /** 配图：直接给图片路径（她过去的朋友圈历史用这个） */
  img?: string;
  /** 配图说明（alt） */
  caption?: string;
  /** 旧的口径：按地点取内置插画 */
  placeId?: string;
  /** 朋友的点赞数（TA 自己算的） */
  likes: number;
  /** 你有没有点过赞 */
  likedByMe: boolean;
  /** 当前视角可见的共同好友点赞者；不在此名单里的总点赞数不展示。 */
  visibleLikeNames?: string[];
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
  /** 跟发朋友圈的人是否共同好友。共同好友 = 你的评论她能看见，她的评论你能看见；
   *  非共同好友（陌生 NPC）的评论只对作者自己显示。 */
  isMutual?: boolean;
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
  /**
   * 图片消息：有值时这条渲染成图片缩略图。
   * 和真人微信一样，图片是**留在聊天记录里的一条消息**——往上翻还在，点开可放大。
   * text 可以留空，也可以当图片下面的一行说明。
   */
  image?: string;
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

/**
 * 排期中的消息：还没"送达"的微信消息。
 *
 * 用途：开场白那种固定对话，不该一次性全塞进会话里让玩家一秒看完。
 * 而是排好队，每隔几秒送一条进来，像真人一个字一个字打完发出来。
 * 也因此它不耗 token——内容是写死的，只是控制节奏。
 */
export interface PendingMsg {
  id: string;
  /** 消息落在哪部手机的会话里 */
  owner: 'her' | 'me';
  contactId: string;
  /** 'sys' = 微信系统灰字（如「你已添加了…」），送达后也是居中灰字，不算谁说的话 */
  from: 'her' | 'me' | 'sys';
  text: string;
  /** 图片消息：送达后进会话，成为一条可翻回、可点开的图片消息 */
  image?: string;
  /** 送达时刻（墙钟 ms）。到点了才进会话。 */
  dueAt: number;
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

// ── 主线剧情（阶段解锁）────────────────────────────────

/**
 * 故事阶段。开始只有我的手机，TA 只是手机那头的朋友。
 * 关系进展到达 350 → 解锁"看见那边的世界"（立绘常驻、能看她的相册/朋友圈）。
 * 关系进展 700 且金币够 → 女巫的跨界实体可以买了（能触摸）。
 *
 * 阈值全部在 `core/story.ts`，不要在别处再写一套。
 */
export type StoryPhase = 0 | 1 | 2;

/** 阶段解锁的判定与提示。每个里程碑一次性写入时间戳，UI 用来播那一幕。 */
export interface StoryProgress {
  phase: StoryPhase;
  /** 坦白童年遗物真相的那一幕（关系进展 50） */
  confessionAt: number | null;
  /** "寄件失败、发现不在一个世界"那一幕（关系进展 150） */
  giftFumbleAt: number | null;
  /** "能看见她那边的世界"那一刻（关系进展 350） */
  awakenedAt: number | null;
  /** 女巫的跨界实体可以买的那一刻（关系进展 700 + 金币达标） */
  physicalAt: number | null;
  /** 是否已购入"实体"。true 之前触摸按钮禁用。 */
  hasPhysical: boolean;
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
  /** 我的微信头像（两部手机同步显示） */
  myAvatar: string;
  /** 她的微信头像（两部手机同步显示） */
  herAvatar: string;
  /** 我的微信状态 */
  myStatus: WxStatus | null;
  /** 她的微信状态（她偶尔发，24 小时过期） */
  herStatus: WxStatus | null;
  /** 在世界里认识的人 */
  metPeople: MetPerson[];
  /** NPC agent 的状态（按 npc id 存）。缺席的用 defaultNpcState 就地补。 */
  npcs: Record<string, NpcState>;
  /** 主线剧情进度（阶段解锁、提示时间） */
  story: StoryProgress;
  /** 有限视角追踪：她是不是已经看到我新发的内容 */
  perspective: PerspectiveTracker;
  /** 排期中、还没送达的微信消息（开场白按节奏一条条发） */
  pendingMsgs: PendingMsg[];
  /** 人格倾向的变动史：让她"为什么变成现在这样"可回溯 */
  traitHistory: TraitPoint[];
  /**
   * 每个会话的偏好：置顶 / 消息免打扰。key = 联系人 id。
   * 不放在 ChatThread 上——还没聊过的联系人没有 thread，也可能想先置顶/免打扰。
   */
  chatPrefs?: Record<string, { pinned?: boolean; muted?: boolean }>;
  /** 这个档注册/开局那一刻的真实时间（ms）。朋友圈历史日期从它往前推。 */
  registeredAt?: number;
  /**
   * 关系数值的口径版本。
   * 老存档是 0~100 的一套，读到没有这个字段的存档要把它放大到 0~1000，
   * 否则老玩家一进来进度就几乎归零。
   */
  affinityScale?: number;
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
  /**
   * 她对**这次互动**的真实感受，直接决定关系涨跌（不再是固定 +1.5）。
   * 范围 -3 ~ 6：被冒犯、被打扰可以为负；只有真正打动她的时候才给高分。
   * 引擎会再 clamp 一遍 —— 模型说了不算。
   */
  affinityDelta: number;
  /** 是否记住这件事（0/1） */
  memorable: 0 | 1;
  /**
   * 她选择**这次不回复**（0/1）。用于"对方只是道别/随口应一声，确实没什么好接的"——
   * 真人不会每句都回。skip=1 时 line 会被忽略，引擎不发这条消息。
   */
  skip?: 0 | 1;
}

export interface DialogueTurn {
  role: 'user' | 'boy';
  text: string;
  iso: string;
  intent?: IntentSchema;
}
