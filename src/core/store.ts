import type {
  Activity,
  CharacterState,
  ChatThread,
  DayPhase,
  DiaryEntry,
  HerPlan,
  MemoryEntry,
  MetPerson,
  MomentEntry,
  NpcState,
  PersonalityPreset,
  PhotoEntry,
  PlayerGender,
  RelationshipLog,
  RoomState,
  SaveData,
  WxStatus,
} from './types';
import { APPEARANCE_PRESETS, DEFAULT_NAMES, PERSONALITY_PRESETS, TRAIT_PRESETS } from './presets';
import { pronoun } from './gender';
import { DEFAULT_PROFILE_ID } from './profile';
import { effectiveStats } from './evolution';
import { PHYSICAL_COST, dueMilestone, phaseFor, type Milestone } from './story';
import { defaultNpcState } from './npc';

const SAVE_KEY = 'hearth-boy.save.v1';
const SAVE_VERSION = 1;

function makeCharacter(preset: PersonalityPreset = 'gentle', name?: string): CharacterState {
  // 查表一律带兜底：预设编号一旦对不上，宁可退化成 gentle，
  // 也不要做出一个缺字段的角色（那种坏档很难查，只会在很远的地方炸）。
  const p = PERSONALITY_PRESETS[preset] ?? PERSONALITY_PRESETS.gentle;
  return {
    appearance: { ...(APPEARANCE_PRESETS[preset] ?? APPEARANCE_PRESETS.gentle) },
    personality: {
      preset,
      name: name || DEFAULT_NAMES[preset] || DEFAULT_NAMES.gentle,
      // 默认性别；真正进游戏时会被 applyProfile 用档案里的性别覆盖
      gender: 'female',
      ...p,
    },
    // traits 的起点。进游戏后会被经历推动，不再是常量。
    traits: { ...(TRAIT_PRESETS[preset] ?? TRAIT_PRESETS.gentle) },
    mood: 'calm',
    energy: 'okay',
    moodValue: 72,
    energyValue: 70,
    affinity: 0,
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
    myAvatar: '🧑',
    herAvatar: '🌸',
    myStatus: null,
    herStatus: null,
    metPeople: [],
    npcs: {},
    story: {
      phase: 0,
      confessionAt: null,
      giftFumbleAt: null,
      awakenedAt: null,
      physicalAt: null,
      hasPhysical: false,
    },
    perspective: {
      myLastUpdate: 0,
      herLastCheck: 0,
    },
    pendingMsgs: [],
    traitHistory: [],
    affinityScale: 2,
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
        merged.metPeople = merged.metPeople ?? [];
        merged.npcs = merged.npcs ?? {};
        merged.story = merged.story ?? { phase: 0, awakenedAt: null, physicalAt: null, hasPhysical: false, giftFumbleAt: null };
        merged.story.confessionAt = merged.story.confessionAt ?? null;
        // 老存档的关系数值是 0~100 那一套：放大到 0~1000 再交给后面的阶段判定，
        // 否则老玩家一进来就会看到进度几乎归零。只做一次（靠 affinityScale 打标）。
        if (merged.affinityScale !== 2) {
          merged.character.affinity = Math.round((merged.character.affinity ?? 0) * 10);
          merged.affinityScale = 2;
        }
        merged.perspective = merged.perspective ?? { myLastUpdate: 0, herLastCheck: 0 };
        merged.pendingMsgs = merged.pendingMsgs ?? [];
        merged.traitHistory = merged.traitHistory ?? [];
        // traits 是后加的字段：老存档没有就按预设补一份起点
        if (!merged.character.traits) {
          const preset = merged.character.personality?.preset ?? 'gentle';
          merged.character.traits = { ...TRAIT_PRESETS[preset] };
        }
        merged.moments = (merged.moments ?? []).map((m) => ({
          ...m,
          author: m.author ?? 'her',
          comments: (m.comments ?? []).map((cm) => ({ ...cm, isMutual: cm.isMutual ?? (cm.by === 'her' || cm.by === 'me') })),
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

  /**
   * 加减金币（不会低于 0）。
   *
   * 这里**不**推进剧情。里程碑的唯一消费点是 `game.ts` 主循环里的 `syncStory()`：
   * 如果在别处也调一次，它会先把时间戳写掉，而返回值被丢掉 ——
   * 那一幕就永远不会播了。主循环每帧都跑，晚一拍也能接住。
   */
  addCoins(n: number): void {
    this.data.coins = Math.max(0, this.data.coins + n);
  }

  /**
   * 取某个 NPC 的 agent 状态；没有就就地补一份默认值。
   * 用这个而不是直接读 `data.npcs[id]` —— 老存档里根本没有这个键。
   */
  npcState(id: string): NpcState {
    this.data.npcs = this.data.npcs ?? {};
    if (!this.data.npcs[id]) this.data.npcs[id] = defaultNpcState(id);
    return this.data.npcs[id];
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

  /** 给某条朋友圈加评论（自动判定 isMutual：her/me 互为共同好友；NPC 看 metPeople.mutual） */
  addMomentComment(momentId: string, by: 'her' | 'me' | 'npc', name: string, text: string): void {
    const m = this.data.moments.find((x) => x.id === momentId);
    if (!m || !text) return;
    let isMutual = false;
    if (by === 'her' || by === 'me') isMutual = true;
    else {
      // NPC：判断评论者是否是发朋友圈人的共同好友（默认非共同好友，除非 metPeople.mutual=true）
      const mp = this.data.metPeople.find((x) => x.name === name);
      isMutual = !!mp?.mutual;
    }
    m.comments.push({
      id: `cmt-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      by,
      name,
      text,
      at: this.data.clock,
      isMutual,
    });
    this.emit();
  }

  // ── 微信 ────────────────────────────────────────────
  /** 追加一条聊天消息；会话不存在就新建。unread=true 时未读 +1。
   *  image 有值时这条是图片消息（微信里图片就是一条留在记录里的消息）。 */
  addChatMsg(owner: 'her' | 'me', contactId: string, from: string, text: string, unread = false, image?: string): void {
    this.pushChatMsg(owner, contactId, from, text, unread, image);
    this.emit();
  }

  // ── 排期消息（让固定对话一条条送达，不耗 token）──────────
  /**
   * 排一批待送达的消息。每条自带 dueAt（墙钟 ms），到点才进会话。
   * 重复排同一批不会叠加：按 text 去重，避免切档/重启时重复。
   */
  scheduleMsgs(
    msgs: Array<{ owner: 'her' | 'me'; contactId: string; from: 'her' | 'me'; text: string; image?: string; dueAt: number }>,
  ): void {
    for (const m of msgs) {
      const dup = this.data.pendingMsgs.some(
        (p) => p.owner === m.owner && p.contactId === m.contactId && p.text === m.text && p.image === m.image,
      );
      if (dup) continue;
      this.data.pendingMsgs.push({
        id: `pend-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
        ...m,
      });
    }
    this.data.pendingMsgs.sort((a, b) => a.dueAt - b.dueAt);
    this.emit();
  }

  /**
   * 把所有到点的排期消息送进对应会话。返回送达条数。
   * 由主循环每个 tick 调用。
   */
  deliverDueMsgs(now = Date.now()): number {
    const q = this.data.pendingMsgs;
    if (!q.length) return 0;
    const due = q.filter((m) => m.dueAt <= now);
    if (!due.length) return 0;
    this.data.pendingMsgs = q.filter((m) => m.dueAt > now);
    for (const m of due) {
      this.pushChatMsg(m.owner, m.contactId, m.from, m.text, m.from === 'her', m.image);
    }
    this.emit();
    return due.length;
  }

  /** 她是否有快到的消息（用于"对方正在输入…"提示） */
  herTyping(now = Date.now()): boolean {
    return this.data.pendingMsgs.some(
      (m) => m.from === 'her' && m.dueAt > now && m.dueAt - now < 6000,
    );
  }

  /** 队列里还剩几条她的待发消息 */
  pendingHerCount(): number {
    return this.data.pendingMsgs.filter((m) => m.from === 'her').length;
  }

  /** 清空排期（切档/重开时用） */
  clearPendingMsgs(): void {
    if (!this.data.pendingMsgs.length) return;
    this.data.pendingMsgs = [];
    this.emit();
  }

  /** 追加一条聊天消息（内部用，不单独 emit，由调用方统一 emit） */
  private pushChatMsg(
    owner: 'her' | 'me',
    contactId: string,
    from: string,
    text: string,
    unread = false,
    image?: string,
  ): void {
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
      image,
      at: this.data.clock,
      iso: new Date().toISOString(),
    });
    if (th.msgs.length > 60) th.msgs.splice(0, th.msgs.length - 60);
    if (unread) th.unread += 1;
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

  // ── 微信：头像 / 状态 / 认识的人 ──────────
  /** 换头像。两部手机读同一个字段，所以会自动同步 */
  setAvatar(owner: 'her' | 'me', emoji: string): void {
    if (owner === 'me') this.data.myAvatar = emoji;
    else this.data.herAvatar = emoji;
    this.emit();
  }

  /** 发状态（24 小时有效） */
  setStatus(owner: 'her' | 'me', s: WxStatus | null): void {
    if (owner === 'me') this.data.myStatus = s;
    else this.data.herStatus = s;
    this.emit();
  }

  /** 在世界里认识一个人（同一个人只记一次） */
  meetPerson(p: Omit<MetPerson, 'at' | 'added'>): boolean {
    if (this.data.metPeople.some((x) => x.id === p.id)) return false;
    this.data.metPeople.push({ ...p, at: this.data.clock, added: false });
    this.emit();
    return true;
  }

  /** 把认识的人加进通讯录 */
  addContact(id: string): void {
    const p = this.data.metPeople.find((x) => x.id === id);
    if (!p) return;
    p.added = true;
    this.emit();
  }

  /** 给已添加的联系人设置备注名 */
  setContactRemark(id: string, remark: string): void {
    const p = this.data.metPeople.find((x) => x.id === id);
    if (!p) return;
    p.remark = remark.trim() || p.name;
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

  // ── 主线剧情：阶段解锁 ─────────────────────────────

  /**
   * 同步主线进度。**这是全项目唯一一处推进剧情的判定**，
   * 阈值全部来自 `core/story.ts`。
   *
   * 返回"刚刚够格、还没播过的那个里程碑"，调用方据此播那一幕；
   * 一次只返回一个，保证剧情按顺序播，不会因为一次加了太多关系进展而漏掉中间一幕。
   */
  syncStory(): Milestone | null {
    const s = this.data.story;
    const m = dueMilestone(this.data.character.affinity, this.data.coins, s);

    // phase 是派生值：只由关系进展决定，"实体买了没"看 hasPhysical
    const nextPhase = phaseFor(this.data.character.affinity);
    if (nextPhase > s.phase) s.phase = nextPhase;

    if (!m) return null;
    const at = Date.now();
    if (m === 'confess') s.confessionAt = at;
    else if (m === 'giftFumble') s.giftFumbleAt = at;
    else if (m === 'awaken') s.awakenedAt = at;
    else s.physicalAt = at;
    this.emit();
    return m;
  }

  /** 玩家花 PHYSICAL_COST 金币买下跨界实体。必须先够到"实体破壁"那一幕 */
  buyPhysical(): boolean {
    if (this.data.story.phase < 2) return false;
    if (this.data.story.hasPhysical) return false;
    if (this.data.coins < PHYSICAL_COST) return false;
    this.data.coins -= PHYSICAL_COST;
    this.data.story.hasPhysical = true;
    this.emit();
    return true;
  }

  // ── AI 有限视角：她"看见"你的内容 ─────────────────────
  //
  // 她不是全知。她只在以下时刻"看手机"：
  //   1. 玩家主动给她发消息（addChatMsg owner=me 时）
  //   2. 玩家在朋友圈给她评论时
  //   3. 玩家发状态（她的状态会在下一个 game tick 刷新时被发现）
  //   4. 每日 8:00 / 13:00 / 19:00 / 22:00 主动刷朋友圈
  //
  // 实现：每次玩家侧 addChatMsg/状态变更/朋友圈变更都更新 myLastUpdate；
  // 玩家点"她的手机"或者时间 tick 推进时 herCheckedPhone 推进 herLastCheck。
  // UI 判定小红点用 hasSheSeenMyUpdate。

  /** 玩家发了内容（聊天/状态/朋友圈），等她查 */
  touchMyUpdate(): void {
    this.data.perspective.myLastUpdate = this.data.clock;
    this.emit();
  }

  /** 模拟她查了一次手机（看见了你最新的内容） */
  herCheckedPhone(): void {
    this.data.perspective.herLastCheck = this.data.clock;
    this.emit();
  }

  /** 我最新内容是否已被她看见 */
  hasSheSeenMyUpdate(): boolean {
    const p = this.data.perspective;
    // 她从没查过 → 没看见
    if (p.herLastCheck === 0) return false;
    return p.herLastCheck >= p.myLastUpdate;
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

  /**
   * 离线期间的状态结算：按真实离开时长回复精力、轻微掉心情。
   * 时钟不在此累加（始终跟随真实时间）。
   *
   * 掉心情的速度不再是常数，而由 traits.clinginess 决定——
   * 黏人的角色没人理时掉得更多，"多久没见会影响她多少"本身是可变的。
   */
  applyOfflineDrift(): number {
    const hoursAway = (Date.now() - this.data.character.lastSavedAt) / 3_600_000;
    if (!Number.isFinite(hoursAway) || hoursAway < 0.5) return 0;
    const capped = Math.min(hoursAway, 12);
    const char = this.data.character;
    const { moodLossPerHour } = effectiveStats(this.data);
    char.energyValue = Math.max(10, Math.min(100, char.energyValue + capped * 1.6));
    char.moodValue = Math.max(5, Math.min(100, char.moodValue - capped * moodLossPerHour));
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

  /**
   * "开始新游戏" 钩子：保留玩家名/性别，把所有剧情进度 + 朋友圈 + 会话 + 朋友圈 + 好友
   * 全清空，然后注入初始的微信好友申请。
   * 这样开机就是干净的阶段 0。
   */
  startNewGame(preset?: PersonalityPreset, name?: string): void {
    this.reset(preset, name);
    // 注入初始好友申请：她（剧情里的"她"不是 metPerson，而是要给聊天接口用）
    // 这里我们加一个特殊的"申请中"标记；metPeople 里加她为申请来源。
    const cname = this.data.character.personality.name;
    this.data.metPeople.push({
      id: 'her-opening',
      name: cname,
      emoji: this.data.herAvatar,
      note: `我是${cname}`,
      placeId: 'home',
      at: 0,
      added: false,
      mutual: false,
    });
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
