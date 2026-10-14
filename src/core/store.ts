import type {
  Activity,
  CharacterState,
  ChatThread,
  DayPhase,
  DiaryEntry,
  HerPlan,
  MemoryEntry,
  MomentEntry,
  PersonalityPreset,
  PhotoEntry,
  PlayerGender,
  RelationshipLog,
  RoomState,
  SaveData,
} from './types';
import { APPEARANCE_PRESETS, DEFAULT_NAMES, PERSONALITY_PRESETS } from './presets';
import { pronoun } from './gender';
import { DEFAULT_PROFILE_ID } from './profile';

const SAVE_KEY = 'hearth-boy.save.v1';
const SAVE_VERSION = 1;

function makeCharacter(preset: PersonalityPreset = 'gentle', name?: string): CharacterState {
  return {
    appearance: { ...APPEARANCE_PRESETS[preset] },
    personality: {
      preset,
      name: name || DEFAULT_NAMES[preset],
      // 默认性别；真正进游戏时会被 applyProfile 用档案里的性别覆盖
      gender: 'female',
      ...PERSONALITY_PRESETS[preset],
    },
    mood: 'calm',
    energy: 'okay',
    moodValue: 72,
    energyValue: 70,
    affinity: 12,
    activity: 'idle',
    phase: 'morning',
    likedGifts: ['book', 'tea'],
    interactionCount: 0,
    lastSavedAt: Date.now(),
  };
}

function makeRoom(): RoomState {
  return {
    lampOn: false,
    curtainOpen: true,
    tidiness: 88,
    weather: 'sunny',
    furniture: ['bed', 'desk', 'rug', 'shelf'],
    props: ['book', 'cat', 'lamp'],
  };
}

export function createDefaultSave(
  playerName = '你',
  playerGender: PlayerGender = 'female',
): SaveData {
  return {
    version: SAVE_VERSION,
    profileId: DEFAULT_PROFILE_ID,
    character: makeCharacter(),
    room: makeRoom(),
    memories: [],
    timeline: [],
    diary: [],
    clock: realHours(),
    timeOffset: 0,
    playerName,
    playerGender,
    coins: 300,
    ownedAccessories: [],
    equippedAccessories: [],
    herPlan: null,
    photos: [],
    moments: [],
    threads: [],
    myDiary: [],
    myPlan: null,
  };
}

/** 存档读写：localStorage，失败时降级为内存存档，不阻塞游戏。 */
export class Store {
  private data: SaveData;
  private memoryFallback: string | null = null;
  private listeners = new Set<(d: SaveData) => void>();

  constructor(playerName?: string) {
    this.data = this.load(playerName);
  }

  get state(): SaveData {
    return this.data;
  }

  subscribe(fn: (d: SaveData) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn(this.data));
  }

  private load(playerName?: string): SaveData {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SaveData;
        if (parsed.version === SAVE_VERSION) {
        // 兜底合并，防止旧存档缺字段
        const fallback = createDefaultSave(playerName);
        const merged: SaveData = {
          ...fallback,
          ...parsed,
          character: { ...fallback.character, ...parsed.character },
          room: { ...fallback.room, ...parsed.room },
        };
        // 老存档补齐后加的字段，避免渲染时读到 undefined
        merged.photos = merged.photos ?? [];
        merged.threads = merged.threads ?? [];
        merged.myDiary = merged.myDiary ?? [];
        merged.moments = (merged.moments ?? []).map((m) => ({
          ...m,
          author: m.author ?? 'her',
          comments: m.comments ?? [],
        }));
        return merged;
      }
      }
    } catch (err) {
      console.warn('[store] 存档读取失败，使用新档', err);
    }
    return createDefaultSave(playerName);
  }

  save(): void {
    this.data.character.lastSavedAt = Date.now();
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.data));
    } catch {
      this.memoryFallback = JSON.stringify(this.data);
      console.warn('[store] localStorage 不可用，本次进度仅存内存');
    }
    this.emit();
  }

  /** 修改状态并通知订阅者。改完不自动保存，由调用方决定时机。 */
  update(mutator: (d: SaveData) => void): void {
    mutator(this.data);
    this.emit();
  }

  /** 设置主控名字与性别 */
  setPlayer(name: string, gender: PlayerGender): void {
    this.data.playerName = name || '你';
    this.data.playerGender = gender;
    this.emit();
  }

  /** 若当前角色还没有属于自己的记忆，补一条"初遇"。换人后各自独立，不串记忆。 */
  ensureProfileIntro(): void {
    const pid = this.data.profileId;
    if (this.data.memories.some((m) => m.profileId === pid)) return;
    const t = pronoun(this.data.character.personality.gender);
    this.data.memories.push({
      id: `mem-intro-${pid}`,
      profileId: pid,
      at: this.data.clock,
      iso: new Date().toISOString(),
      kind: 'milestone',
      summary: `第一次把${t}叫到小屋，你们的故事从这里开始。`,
      weight: 3,
      tags: ['初遇', '小屋'],
    });
    this.emit();
  }

  /** 加减金币（不会低于 0） */
  addCoins(n: number): void {
    this.data.coins = Math.max(0, this.data.coins + n);
    this.emit();
  }

  addMemory(entry: Omit<MemoryEntry, 'id' | 'iso' | 'at' | 'profileId'>): void {
    this.data.memories.push({
      ...entry,
      id: `mem-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      profileId: this.data.profileId,
      iso: new Date().toISOString(),
      at: this.data.clock,
    });
    // 只保留最近 200 条，防止存档无限膨胀
    if (this.data.memories.length > 200) {
      this.data.memories.splice(0, this.data.memories.length - 200);
    }
    this.emit();
  }

  addDiary(entry: Omit<DiaryEntry, 'id' | 'iso' | 'profileId'>): void {
    this.data.diary.push({
      ...entry,
      id: `diary-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      profileId: this.data.profileId,
      iso: new Date().toISOString(),
    });
    // 只保留最近 120 篇，防止存档膨胀
    if (this.data.diary.length > 120) {
      this.data.diary.splice(0, this.data.diary.length - 120);
    }
    this.emit();
  }

  /** 覆盖今天的日程（跨天时由 game 重建） */
  setHerPlan(plan: HerPlan): void {
    this.data.herPlan = plan;
    this.emit();
  }

  /** 存一张她拍的照片 */
  addPhoto(entry: Omit<PhotoEntry, 'id' | 'iso' | 'profileId'>): void {
    this.data.photos.push({
      ...entry,
      id: `photo-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      profileId: this.data.profileId,
      iso: new Date().toISOString(),
    });
    if (this.data.photos.length > 120) this.data.photos.splice(0, this.data.photos.length - 120);
    this.emit();
  }

  /** 发一条朋友圈。返回新建的那条，便于接着加评论 */
  addMoment(
    entry: Omit<MomentEntry, 'id' | 'iso' | 'profileId' | 'likes' | 'likedByMe' | 'comments'> & { likes?: number },
  ): MomentEntry {
    const created: MomentEntry = {
      comments: [],
      ...entry,
      likes: entry.likes ?? Math.floor(Math.random() * 4),
      likedByMe: false,
      id: `moment-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      profileId: this.data.profileId,
      iso: new Date().toISOString(),
    };
    this.data.moments.push(created);
    if (this.data.moments.length > 80) this.data.moments.splice(0, this.data.moments.length - 80);
    this.emit();
    return created;
  }

  /** 给某条朋友圈加评论 */
  addMomentComment(momentId: string, by: 'her' | 'me' | 'npc', name: string, text: string): void {
    const m = this.data.moments.find((x) => x.id === momentId);
    if (!m || !text) return;
    m.comments.push({
      id: `cmt-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      by,
      name,
      text,
      at: this.data.clock,
    });
    this.emit();
  }

  // ── 微信 ────────────────────────────────────────────
  /** 追加一条聊天消息；会话不存在就新建。unread=true 时未读 +1 */
  addChatMsg(owner: 'her' | 'me', contactId: string, from: string, text: string, unread = false): void {
    let th = this.data.threads.find(
      (t) => t.owner === owner && t.contactId === contactId && t.profileId === this.data.profileId,
    );
    if (!th) {
      th = {
        id: `th-${owner}-${contactId}-${this.data.profileId}`,
        profileId: this.data.profileId,
        owner,
        contactId,
        msgs: [],
        unread: 0,
      };
      this.data.threads.push(th);
    }
    th.msgs.push({
      id: `msg-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      from,
      text,
      at: this.data.clock,
      iso: new Date().toISOString(),
    });
    if (th.msgs.length > 60) th.msgs.splice(0, th.msgs.length - 60);
    if (unread) th.unread += 1;
    this.emit();
  }

  /** 打开某个会话 → 清未读 */
  markThreadRead(owner: 'her' | 'me', contactId: string): void {
    const th = this.data.threads.find(
      (t) => t.owner === owner && t.contactId === contactId && t.profileId === this.data.profileId,
    );
    if (!th || th.unread === 0) return;
    th.unread = 0;
    this.emit();
  }

  /** 我的日记 */
  addMyDiary(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.data.myDiary.push({
      id: `mydiary-${Date.now()}`,
      day: Math.floor(this.data.clock / 24),
      iso: new Date().toISOString(),
      text: t,
    });
    if (this.data.myDiary.length > 120) this.data.myDiary.splice(0, this.data.myDiary.length - 120);
    this.emit();
  }

  /** 我的日程 */
  setMyPlan(blocks: HerPlan['blocks']): void {
    this.data.myPlan = { day: Math.floor(this.data.clock / 24), profileId: 'me', blocks };
    this.emit();
  }

  /** 给某条朋友圈点赞/取消 */
  toggleMomentLike(id: string): void {
    const m = this.data.moments.find((x) => x.id === id);
    if (!m) return;
    m.likedByMe = !m.likedByMe;
    m.likes += m.likedByMe ? 1 : -1;
    this.emit();
  }

  pushTimeline(note: string): void {    const day = Math.floor(this.data.clock / 24);
    const last = this.data.timeline[this.data.timeline.length - 1];
    if (last && last.day === day) {
      last.affinity = this.data.character.affinity;
      last.mood = this.data.character.moodValue;
      last.note = note;
    } else {
      this.data.timeline.push({
        day,
        affinity: this.data.character.affinity,
        mood: this.data.character.moodValue,
        note,
      });
    }
    if (this.data.timeline.length > 120) this.data.timeline.shift();
    this.emit();
  }

  /** 离线期间的状态结算：按真实离开时长回复精力、轻微掉心情。时钟不在此累加（始终跟随真实时间）。 */
  applyOfflineDrift(): number {
    const hoursAway = (Date.now() - this.data.character.lastSavedAt) / 3_600_000;
    if (!Number.isFinite(hoursAway) || hoursAway < 0.5) return 0;
    const capped = Math.min(hoursAway, 12);
    const char = this.data.character;
    char.energyValue = Math.max(10, Math.min(100, char.energyValue + capped * 1.6));
    char.moodValue = Math.max(5, Math.min(100, char.moodValue - capped * 0.7));
    this.emit();
    return capped;
  }

  reset(preset?: PersonalityPreset, name?: string): void {
    this.data = createDefaultSave(this.data.playerName);
    if (preset) {
      this.data.character = makeCharacter(preset, name);
    }
    this.save();
  }

  get hasMemoryFallback(): boolean {
    return this.memoryFallback !== null;
  }
}

// ── 时间与作息 ─────────────────────────────────────────

/** 真实本地时间，单位=小时（含小数分钟）。游戏时钟始终锚定真实时间。 */
export function realHours(): number {
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}

export function clockToPhase(hour: number): DayPhase {
  const h = hour % 24;
  if (h < 5) return 'night';
  if (h < 11) return 'morning';
  if (h < 17) return 'noon';
  if (h < 22) return 'evening';
  return 'night';
}

/** 根据作息阶段推荐活动。角色会自己换动作，不需要玩家指挥。 */
export function phaseDefaultActivity(phase: DayPhase, energy: number): Activity {
  if (phase === 'night') return energy < 40 ? 'sleeping' : 'resting';
  if (phase === 'morning') return 'stretching';
  if (phase === 'noon') return energy < 45 ? 'resting' : 'playing_game';
  return 'reading';
}

/**
 * 按"人设 + 真实时间点"给出该在做什么。这是"作息不僵硬"的核心：
 * 不是固定时刻切换，而是以时间段为基线、按性格微调，且精力不足时统一让位给休息/睡眠。
 * 让 18:25 这种真实时间天然对应"做饭/吃饭"，而不是永远发呆。
 */
export function dailyActivity(
  hour: number,
  preset: PersonalityPreset,
  energy: number,
): Activity {
  const h = hour % 24;

  // 精力见底：任何性格都先顾身体
  if (energy < 22) return 'sleeping';
  if (energy < 38 && (h >= 22 || h < 7)) return 'sleeping';
  if (energy < 35) return 'resting';

  // 睡觉时段
  if (h >= 23 || h < 6) return 'sleeping';
  // 起床洗漱
  if (h < 8) return 'stretching';
  // 早饭
  if (h < 9) return 'cooking';
  // 午饭
  if (h >= 12 && h < 13) return 'cooking';
  // 晚饭
  if (h >= 18 && h < 19) return 'cooking';
  // 午后小憩
  if (h >= 13 && h < 14) return 'resting';
  // 睡前放松
  if (h >= 22) return 'resting';

  // 白天主业：按性格分
  // 活泼型(Haru/sunny) 闲不住爱打游戏；文静型(Mao/gentle) 爱看书；
  // 傲娇型(Natori/cool) 嘴上嫌弃但也会看书或发呆。
  if (preset === 'sunny') {
    if (h >= 14 && h < 18) return Math.random() < 0.5 ? 'playing_game' : 'reading';
    return 'playing_game';
  }
  if (preset === 'gentle') {
    if (h >= 9 && h < 12) return 'reading';
    if (h >= 14 && h < 18) return 'reading';
    return 'idle';
  }
  // cool / clingy 等：偏安静
  if (h >= 9 && h < 12) return Math.random() < 0.6 ? 'reading' : 'idle';
  if (h >= 14 && h < 18) return 'reading';
  return 'idle';
}

export function formatClock(hour: number): string {
  const h = Math.floor(hour % 24);
  const m = Math.floor((hour % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export type { RelationshipLog };

// ── 按角色过滤（换人后各自独立）──────────────────────────

/** 某角色自己积累的记忆（默认当前角色） */
export function memoriesFor(save: SaveData, profileId: string = save.profileId): MemoryEntry[] {
  return save.memories.filter((m) => m.profileId === profileId);
}

/** 某角色的日记（默认当前角色） */
export function diaryFor(save: SaveData, profileId: string = save.profileId): DiaryEntry[] {
  return save.diary.filter((d) => d.profileId === profileId);
}

/** 某角色的相册（默认当前角色） */
export function photosFor(save: SaveData, profileId: string = save.profileId): PhotoEntry[] {
  return save.photos.filter((p) => p.profileId === profileId);
}

/** 某角色的朋友圈（默认当前角色） */
export function momentsFor(save: SaveData, profileId: string = save.profileId): MomentEntry[] {
  return save.moments.filter((m) => m.profileId === profileId);
}

/** 某台手机的会话列表（默认当前角色） */
export function threadsFor(
  save: SaveData,
  owner: 'her' | 'me',
  profileId: string = save.profileId,
): ChatThread[] {
  return save.threads.filter((t) => t.owner === owner && t.profileId === profileId);
}

/** 某个会话 */
export function threadFor(
  save: SaveData,
  owner: 'her' | 'me',
  contactId: string,
  profileId: string = save.profileId,
): ChatThread | undefined {
  return save.threads.find(
    (t) => t.owner === owner && t.contactId === contactId && t.profileId === profileId,
  );
}