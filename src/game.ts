import { Animator, type AnimInputs, type ReactionKind } from './anim/animator';
import { Store, clockToPhase, formatClock, dailyActivity, realHours } from './core/store';
import {
  ACTIVITIES,
  GIFTS,
  applyGain,
  clampNum,
  resolveActivity,
  resolveGift,
  resolveTouch,
  type TouchKind,
} from './core/interaction';
import { RoomRenderer } from './render/room';
import { Live2DCharacterRenderer } from './render/live2d';
import type { CharacterRenderer } from './render/renderer';
import { getAccessory, SLOT_ANCHOR } from './core/shop';
import { pronoun } from './core/gender';
import {
  ALBUM_IMG,
  JOBS,
  PLACE_STATUS,
  buildHerPlan,
  describePlan,
  getPlace,
  herOutingMessage,
  isJobOpen,
  jobHoursText,
  personAt,
  planAt,
  placeActivityLine,
  type JobDef,
} from './core/world';
import type { DayPhase, PlanBlock, PlayerGender, SaveData } from './core/types';
import {
  applyExperience,
  effectiveStats,
  foldOfflineIntoTraits,
  planOfflineEvents,
} from './core/evolution';
import { AFFINITY_MAX } from './core/story';
import { WITCH_ID, situationFor, type NpcSituation } from './core/npc';
import { applyProfile, getProfile, DEFAULT_PROFILE_ID, PROFILES } from './core/profile';
import type { CharacterProfile } from './core/profile';
import {
  buildOpeningScript,
  scheduleNode,
  friendVerifiedSys,
  GREETING_DIVIDER,
  type OpeningScript,
  type OpeningNode,
} from './core/opening';
import { loadConfig, requestDiary, requestMomentComment, requestNpcLine, requestReply, saveConfig, cloudConfigured, type LlmConfig } from './ai/client';
import { reconcileAction, resolveMood } from './ai/mapping';
import { idleGossip, timeGlance } from './ai/offline';
import { mountUI, type UI } from './ui/hud';
import { voice } from './audio/voice';

/**
 * 游戏主类：把引擎各模块接在一起，并跑主循环。
 * 这是唯一持有"当前正在发生什么"的权威。
 */
export class Game {
  private store: Store;
  private room = new RoomRenderer();
  private boy: CharacterRenderer;
  private animator = new Animator();

  private roomCanvas!: HTMLCanvasElement;
  private boyCanvas!: HTMLCanvasElement;
  private ui!: UI;
  private profile: CharacterProfile;

  private lastTime = 0;
  private running = false;
  private timeSec = 0;

  // 说话状态：驱动口型
  private speaking = false;
  private speechEndsAt = 0;
  private typingBuffer: { text: string; idx: number; done: (() => void) | null } | null = null;

  // 视线目标（归一化）
  private gaze = { x: 0, y: 0 };
  private gazeTarget = { x: 0, y: 0 };

  // 一次性反应
  private reaction: { kind: ReactionKind; startedAt: number } = { kind: 'none', startedAt: 0 };

  private config: LlmConfig = loadConfig();
  private pendingReply = false;
  private activityLockUntil = 0;
  private lastGossipAt = 0;
  /** 下次主动"看时间开口"的时间点 */
  private nextTimeGlanceAt = 0;
  /** 日记：上次写过日记的"天"（floor(clock/24)），一天最多一篇 */
  private lastDiaryDay = -1;
  /** 上次写日记的游戏时刻（小时），用于冷却 */
  private lastDiaryClock: number | null = null;
  /** 下次评估"要不要写日记"的时间点 */
  private nextDiaryCheckAt = 0;
  private diaryPending = false;
  /** AI 视角：她下次会主动"刷手机"的真实时间戳（real seconds）。0 = 还没决定。 */
  private _nextCheckRealAt = 0;
  /** AI 视角：她下次主动发消息给玩家的真实时间戳。0 = 还没决定。 */
  private _nextProactiveMsgAt = 0;
  /** 上次发完"她主动发我消息"的红点状态，避免重复。 */
  private _lastProactiveClock = -1;
  /**
   * 她最后一次"主动找你"的真实时刻；0 = 没有悬着的主动消息。
   * 用来判断这次主动有没有被回应 —— 被冷落会写进 traits（黏人度↑、戒备心↑）。
   */
  private _pendingProactiveAt = 0;
  /** 玩家最近一次回她话的真实时刻 */
  private lastPlayerReplyAt = 0;
  /** 开局分支剧本（当前性格的那棵剧本树；刷新后用聊天记录重建进度） */
  private openingScript: OpeningScript | null = null;
  /** 玩家跳过剧本直接打字聊 → 放弃剩余台词，交给模型 */
  private openingAbandoned = false;
  /** 已经播过的内心话，避免同一条反复刷 */
  private lastNeixinKey = '';
  /**
   * 世界是否已"连上"（阶段 ≥ 1）：决定她的立绘与她的日常是否可见。
   * 初值必须是 null 而不是 false —— 否则开局就是 false，跟阶段 0 的 false 判等，
   * 第一帧不会去改可见性，她就会直接站在你的房间里（可阶段 0 她还隔着两个世界）。
   */
  private _worldLinked: boolean | null = null;
  /**
   * 写日记的"情绪契机"：只有发生了值得记的事（心情大幅波动、重要互动、被记住的对话）
   * 才会累积信号；没有契机就不写——所以不是"每天一篇"，而是"有情绪波动/有事才写"。
   * strength：1=小事，2=值得记的事。
   */
  private diarySignal: { strength: number; note: string } | null = null;

  /** 她此刻所在地点 id（'home' 表示在家、可当面互动；其余=出门了，只能用手机） */
  private herPlaceId = 'home';
  /** 她今天的日程（与存档同步，跨天重建） */
  private herPlanBlocks: PlanBlock[] = [];
  /** 正在进行的打工 */
  private working: { job: JobDef; startedAt: number } | null = null;

  /** 立绘切换状态：异步加载期间界面要能反馈 */
  private switchingProfile = false;
  /** 作息台词去重：记录上次触发到了第几天 */
  private routineDay = -1;
  private lastRoutineAt = 0;

  constructor(root: HTMLElement) {
    this.store = new Store();
    const drift = this.store.applyOfflineDrift();

    // 顺序很重要：先 mountUI 把 DOM 建出来，才能拿到画布引用。
    // 之前反过来导致 room-canvas 取到 null。
    this.ui = mountUI(root, {
      onSend: (text) => void this.sendToModel(text),
      openingInputLocked: () => this.openingInputLocked(),
      onTouch: (part) => void this.handleTouch(part),
      onGift: (id) => void this.handleGift(id),
      onActivity: (id) => void this.handleActivity(id),
      onToggleLamp: () => this.toggleLamp(),
      onToggleCurtain: () => this.toggleCurtain(),
      onToggleTidy: () => this.toggleTidy(),
      onSetTime: (hhmm) => this.setTime(hhmm),
      onSyncTime: () => this.syncTime(),
      onConfigChange: (cfg) => {
        this.config = cfg;
        saveConfig(cfg);
        voice.setEnabled(true);
        this.ui.setModelStatus(this.statusText(), false);
      },
      onRename: (name) => {
        this.store.update((d) => {
          d.playerName = name || '你';
        });
        this.ui.setBubbleHint(`记住了，你叫${d_name(name)}。`);
      },
      onSwitchProfile: (id) => void this.switchProfile(id),
      onStartGame: (id, name, gender) => void this.startGame(id, name, gender),
      onBuyAccessory: (id) => this.buyAccessory(id),
      onEquipAccessory: (id) => this.equipAccessory(id),
      onStartJob: (id) => this.startJob(id),
      onLikeMoment: (id) => this.store.toggleMomentLike(id),
      onCommentMoment: (id, text) => this.store.addMomentComment(id, 'me', this.store.state.playerName, text),
      onPostMoment: (text) => void this.postMoment(text),
      onWriteMyDiary: (text) => this.writeMyDiary(text),
      onSaveMyPlan: (blocks) => this.saveMyPlan(blocks),
      onReadThread: (owner, contactId) => this.store.markThreadRead(owner, contactId),
      onChatPref: (contactId, patch) => this.store.setChatPref(contactId, patch),
      onSetAvatar: (owner, emoji) => this.store.setAvatar(owner, emoji),
      onSetStatus: (owner, s) => {
        this.store.setStatus(owner, s);
        if (owner === 'me') this.store.touchMyUpdate();
      },
      onAddContact: (id, remark) => {
        const p = this.store.state.metPeople.find((x) => x.id === id);
        if (!p) return;
        const wasOpening = id === 'her-opening';
        this.store.addContact(id);
        if (remark) this.store.setContactRemark(id, remark);
        const displayName = remark || p.name;
        this.ui.addLog(`你把「${displayName}」加进了通讯录。`);
        // 如果是开局的好友申请：先落微信那条系统提示，再播分支剧本第一层
        if (wasOpening) {
          this.openingAbandoned = false;
          this.openingScript = this.buildOpening();
          const node = this.openingScript.root;
          // 「开局头」三条 —— **一进聊天就都在**（真微信打开就是已经在了，延迟冒出来很怪）：
          //   ① 她申请好友时写的那句话（申请语 / 打招呼内容，她是申请方）
          //   ② 灰字「你已添加了X，现在可以开始聊天了」
          //   ③ 灰字「以上是打招呼的内容」
          // 只有她**新发**的招呼（「你好呀」…）才是过一会儿才来的 —— 那才是对话的开头。
          const applyLine = p.note || `我是${p.name}`;
          this.store.addChatMsg('me', 'her', 'her', applyLine, false);
          this.store.addChatMsg('me', 'her', 'sys', friendVerifiedSys(displayName), false);
          this.store.addChatMsg('me', 'her', 'sys', GREETING_DIVIDER, false);
          // 她"新发"的第一句先停一拍再送达
          this.store.scheduleMsgs(scheduleNode(node, Date.now() + 2600));
          // 注意：开场内心戏（root.neixin）已在 startGame 里播过了，这里不再重播，
          // 否则通过好友后会把"奇奇怪怪……"那三句再放一遍。
          this.ui.addLog('她好像发了几条消息过来……');
        }
      },
      onOpeningPick: (label) => this.pickOpeningChoice(label),
      onShoot: (placeId) => this.shoot(placeId),
      onBuyPhysical: () => {
        const ok = this.store.buyPhysical();
        if (ok) this.ui.addLog(`${this.charPronoun()}来了。`);
        else this.ui.addLog('还差一点点……');
        return ok;
      },
    });

    // DOM 就绪后再取画布
    this.roomCanvas = root.querySelector('#room-canvas') as HTMLCanvasElement;
    this.boyCanvas = root.querySelector('#boy-canvas') as HTMLCanvasElement;
    this.room.mount(this.roomCanvas);

    this.profile = getProfile(this.store.state.profileId ?? DEFAULT_PROFILE_ID);
    applyProfile(this.profile, this.store.state);
    this.boy = this.createRenderer(this.profile);
    this.boy.mount(this.canvasFor(this.profile));

    this.bindInput();
    this.ui.setModelStatus(this.statusText(), false);
    this.ui.setConfig(this.config);

    // 离线期间：数值已经结算过了，这里把"你不在时她去过哪、留下过什么"补记回来
    if (drift > 0.5) this.replayOfflineWorld(drift);
    this.ui.setPlayerName(this.store.state.playerName);

    this.ui.greet(this.store.state);

    // 首次"主动看时间"安排在开局两分钟后，避免一进来就念时间
    this.nextTimeGlanceAt = performance.now() + 120_000;
    // 首次"要不要写日记"的评估安排在开局十几秒后
    this.nextDiaryCheckAt = performance.now() + 15_000;

    // Live2D 模型放在 ui 就绪之后再加载，否则加载状态无处可显示
    if (this.boy.load) {
      this.boy.onStatusChange = (s) => this.ui.setLive2DStatus(s);
      void this.boy.load().then((ok) => {
        if (!ok) {
          this.handleRendererFailure();
        }
      });
    }

    this.store.save();
  }

  /** 当前大模型通道的可读描述，用于设置面板状态 */
  private statusText(): string {
    if (cloudConfigured()) return '云端大模型 · 在线';
    if (this.config.apiKey) return `${this.config.model} · 本地`;
    return '离线回复';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.loop);
  }

  // ── 立绘切换 ────────────────────────────

  /**
   * 每个渲染器要配不同的 canvas。
   * 关键：Live2D 走 WebGL，一个 canvas 一旦被取过 2D 上下文，
   * 就再也拿不到 WebGL 上下文了 —— 必须用独立的 WebGL canvas。
   */
  private canvasFor(profile: CharacterProfile): HTMLCanvasElement {
    if (profile.renderer.kind === 'live2d') {
      const el = document.getElementById('live2d-canvas') as HTMLCanvasElement;
      el.hidden = false;
      this.boyCanvas.hidden = true;
      return el;
    }
    const el = document.getElementById('live2d-canvas') as HTMLCanvasElement | null;
    if (el) el.hidden = true;
    this.boyCanvas.hidden = false;
    return this.boyCanvas;
  }

  private createRenderer(profile: CharacterProfile): CharacterRenderer {
    // 现在只有 Live2D 一种渲染路径。矢量渲染器留作兜底，
    // 万一模型加载失败，回退到它至少不会白屏。
    return new Live2DCharacterRenderer(profile);
  }

  /**
   * 切换立绘。
   *
   * 换立绘 = 换人：外观、性格、礼物喜好整套一起换。
   * 亲密度、记忆、房间状态保留 —— 那些是你和"她"共同攒下来的，
   * 换一张脸不该把过去清零。
   */
  async switchProfile(id: string): Promise<void> {
    if (this.switchingProfile) return;
    const next = PROFILES.find((p) => p.id === id);
    if (!next || next.id === this.profile.id) return;

    this.switchingProfile = true;
    this.ui.setProfileSwitching(true, next.name);

    try {
      // 先加载新渲染器，成功再销毁旧的，避免中间出现空画面
      const renderer = this.createRenderer(next);
      renderer.mount(this.canvasFor(next));
      renderer.resize(this.boy.viewWidth || window.innerWidth, this.boy.viewHeight || window.innerHeight);

      if (renderer.load) {
        renderer.onStatusChange = (s) => this.ui.setLive2DStatus(s);
        const ok = await renderer.load();
        if (!ok) {
          renderer.dispose();
          this.ui.setProfileSwitching(false);
          this.ui.addLog(`${next.name} 的 Live2D 模型没加载成功，保持原立绘。`);
          return;
        }
      }

      this.boy.dispose();
      this.boy = renderer;
      this.profile = next;

      this.store.update((d) => {
        applyProfile(next, d);
      });

      // 换人之后重新打声招呼，让新性格立刻被感知到
      this.ui.setBubbleHint(`${next.name}：${next.tagline}`);
      this.ui.addLog(`换成了 ${next.name}。${pronoun(next.gender)}有自己的记忆，从这里开始。`);
      // 剧本语气跟着人走（刷新后 tickOpening 也会懒重建，这里主动换）
      this.openingScript = this.buildOpening();
      // 新角色如果还没有属于自己的记忆，补一条初遇；否则沿用 TA 自己攒下的记忆（不串别人）
      this.store.ensureProfileIntro();
      this.store.pushTimeline(`立绘切换为 ${next.name}`);
      this.store.save();
      this.ui.setProfileId(next.id);
    } finally {
      this.switchingProfile = false;
      this.ui.setProfileSwitching(false);
    }
  }

  /** 开局：记下主控的名字/性别，再选定人设。 */
  private async startGame(
    id: string,
    playerName: string,
    playerGender: PlayerGender,
  ): Promise<void> {
    const profile = getProfile(id);
    // 完全清档 → 阶段 0 → 注入初始好友申请。
    //
    // 这里必须传「性格预设」，不能传立绘档案 id —— 两者是两套编号：
    // 档案 id 是 haru / mao / natori，性格预设是 sunny / gentle / cool / clingy。
    // 之前把 id 直接 cast 成 PersonalityPreset 传进来，导致 personality 里
    // tone / shyThreshold / initiative / speechRate 全是 undefined（查表查不到）。
    this.store.startNewGame(profile.personality.preset, profile.name);
    this.store.setPlayer(playerName, playerGender);
    // 重置开局相关的运行时状态（排期队列、剧本进度）
    this.openingScript = this.buildOpening();
    this.openingAbandoned = false;
    this.lastNeixinKey = '';
    this.store.clearPendingMsgs();
    // 新档开局：清掉构造函数里"离线补记"遗留在通知面板里的旧记录
    // （startNewGame 只清数据、不清通知 DOM，不清理会出现"你离开了约X小时"的幽灵提示）
    this.ui.clearNotifications();
    this.ui.setPlayerName(this.store.state.playerName);
    await this.switchProfile(id);
    // 同一档案时 switchProfile 会早退（不会跑到 applyProfile），
    // 所以这里无条件把档案（性格 / 外观 / 喜欢的礼物）落到存档上兜底。
    this.store.update((d) => {
      applyProfile(profile, d);
    });
    this.store.ensureProfileIntro();
    this.store.save();
    // 心声：玩家看到好友申请时的内心戏（心理弹幕，不是她说的）
    
    // 玩家开机看到的提示
    this.ui.addLog('你的微信收到了一条好友申请……');
    // 开场内心戏：玩家看到好友申请时心里的嘀咕（big 大字，点屏幕任意处推进）。
    // 手机开局就显示在下方——上面是内心、下面是手机，玩家能直接"看到"好友申请，不再云里雾里；
    // 但在内心戏点完之前，整屏遮罩拦截点击（连点手机也只推进剧情，跟手机不存在一样），
    // 只有三句点完，通讯录标签才解锁。
    const rootNode = this.openingScript.root;
    if (rootNode.neixin) {
      this.lastNeixinKey = Array.isArray(rootNode.neixin)
        ? rootNode.neixin.join('|')
        : rootNode.neixin;
      this.ui.setNeixin(rootNode.neixin, true, true);
    }
    // 开局即把手机摆在下方（通讯录标签此时因门控禁用、但红点"1"亮着），等心里话点完再解锁
    this.ui.openNewGameContacts();
  }

  // ── 商城 / 配件 ─────────────────────────
  /** 已装备配件对应的 <img> 元素 */
  private accEls = new Map<string, HTMLImageElement>();

  private buyAccessory(id: string): void {
    const acc = getAccessory(id);
    if (!acc) return;
    const s = this.store.state;
    if (s.ownedAccessories.includes(id)) return;
    if (s.coins < acc.price) {
      this.ui.addLog('金币不够，先攒一攒。');
      return;
    }
    this.store.update((d) => {
      d.coins -= acc.price;
      d.ownedAccessories.push(id);
    });
    this.store.save();
    this.ui.addLog(`买下了「${acc.name}」。`);
  }

  /** 戴上/取下配件：同一部位同时只能戴一件。 */
  private equipAccessory(id: string): void {
    const acc = getAccessory(id);
    if (!acc) return;
    if (!this.store.state.ownedAccessories.includes(id)) return;
    this.store.update((d) => {
      if (d.equippedAccessories.includes(id)) {
        d.equippedAccessories = d.equippedAccessories.filter((x) => x !== id);
      } else {
        // 先摘掉同部位的其他件
        d.equippedAccessories = d.equippedAccessories.filter(
          (x) => getAccessory(x)?.slot !== acc.slot,
        );
        d.equippedAccessories.push(id);
      }
    });
    this.store.save();
    this.syncAccessories();
  }

  /**
   * 把装备中的配件按部位锚点叠到角色身上。
   * 配件是独立的 DOM 图片层（在 Live2D 画布之上），每帧跟随锚点位置。
   */
  private syncAccessories(): void {
    const layer = document.getElementById('acc-layer');
    if (!layer) return;
    const equipped = this.store.state.equippedAccessories;

    // 移除已取下的
    for (const [id, el] of this.accEls) {
      if (!equipped.includes(id)) {
        el.remove();
        this.accEls.delete(id);
      }
    }
    if (equipped.length === 0) return;

    const anchors = this.boy.charAnchors?.() ?? null;
    if (!anchors) return;

    for (const id of equipped) {
      const acc = getAccessory(id);
      if (!acc) continue;
      let el = this.accEls.get(id);
      if (!el) {
        el = document.createElement('img');
        el.src = acc.asset;
        el.alt = acc.name;
        el.style.position = 'absolute';
        el.draggable = false;
        layer.appendChild(el);
        this.accEls.set(id, el);
      }
      const a = anchors[SLOT_ANCHOR[acc.slot]];
      // 尺寸与偏移都以"实测头宽"为单位，各模型按头自动缩放
      const unit = anchors.headW;
      el.style.width = `${acc.width * unit}px`;
      el.style.left = `${a.x + acc.offsetX * unit}px`;
      el.style.top = `${a.y + acc.offsetY * unit}px`;
    }
  }

  // ── 她的日常：在家 / 出门 ──────────────────
  /**
   * 按"她今天的日程"推她此刻在哪。
   * 日程 = 固定课/班 + 她自己的兼职（定了必须去）+ 空档里她自己想去的地方，
   * 每天重建一次（同一天稳定），所以她是"按自己的安排过日子"，不是被玩家指挥。
   */
  /**
   * 你不在的时候，她按自己的日程走了一段路。
   *
   * 这里不是结算数值，而是**补记发生过的事**：
   * 把错过的时段按日程重放，把去过的地点变成真的留下的照片、朋友圈与记忆，
   * 再让这一趟回头改写她的 traits。
   * 于是"世界在你不在时也在推进"是可查的，而不是一句设定；
   * 玩家回来看到的不是"她一直在等你"，而是她这几天留下的痕迹。
   */
  private replayOfflineWorld(hoursAway: number): void {
    const save = this.store.state;
    const name = save.character.personality.name;
    const t = pronoun(save.character.personality.gender);
    const events = planOfflineEvents(save, hoursAway);

    for (const e of events) {
      const p = getPlace(e.placeId);
      this.store.addPhoto({
        at: e.at,
        placeId: e.placeId,
        caption: e.caption,
        mood: save.character.mood,
        img: ALBUM_IMG[e.placeId],
      });
      const moment = this.store.addMoment({
        at: e.at,
        placeId: e.placeId,
        kind: 'outing',
        author: 'her',
        text: e.text,
      });
      // 她这一趟如果遇到了人，那这个人也就此进了她的世界
      if (e.person && this.store.meetPerson(e.person)) {
        this.store.addChatMsg('her', e.person.id, e.person.id, e.person.greet ?? '又见面啦，今天也来？');
        this.store.addMomentComment(moment.id, 'npc', e.person.name, '下次一起呀');
      }
      this.store.addMemory({
        kind: 'event',
        summary: `你不在的时候，${t}${e.caption}，还留了张照片。`,
        weight: 2,
        tags: ['离线', p.name],
      });
    }

    // 这一段时间也回头改写她：出去见了人会更外向，你很久没来会更在意有没有回应
    this.store.update((d) => foldOfflineIntoTraits(d, events, hoursAway));

    if (events.length) {
      const places = [...new Set(events.map((e) => getPlace(e.placeId).name))].join('、');
      this.ui.addLog(
        `你离开了约 ${hoursAway.toFixed(1)} 小时。这段时间${name}没闲着：去了${places}，还留了几张照片。`,
      );
    } else {
      this.ui.addLog(`你离开了约 ${hoursAway.toFixed(1)} 小时。这段时间${name}基本待在家里。`);
    }
    this.store.save();
  }

  private tickPresence(save: import('./core/types').SaveData): void {
    const weekday = new Date().getDay();
    const day = Math.floor(save.clock / 24);

    // 世界是否已"连上"：阶段 0 时玩家只看得到手机，看不见她那边发生的事，
    // 也看不见她的身影（立绘）。觉醒（阶段 1）之后才慢慢展开。
    const worldLinked = (save.story?.phase ?? 0) >= 1;

    // 换天 / 换人 → 重新决定今天的安排
    if (!save.herPlan || save.herPlan.day !== day || save.herPlan.profileId !== this.profile.id) {
      const blocks = buildHerPlan({
        profileId: this.profile.id,
        life: this.profile.life,
        job: this.profile.job,
        personality: save.character.personality.preset,
        weekday,
        day,
        energy: save.character.energyValue,
        // 她今天想不想出门，也由 traits 决定（经历了什么，改变了偏好本身）
        outgoingBias: effectiveStats(save).outgoingBias,
      });
      this.herPlanBlocks = blocks;
      this.store.setHerPlan({ day, profileId: this.profile.id, blocks });
      this.ensureChats();
      // 她的日程只有"能看见她的世界"之后才报给你——阶段 0 是隔屏联系，
      // 她的行踪只能从她手机里的日程 app 看（她的手机也还没解锁）。
      if (worldLinked) {
        const t = pronoun(this.profile.gender);
        this.ui.addLog(`${t}今天决定：${describePlan(blocks)}`);
      }
    } else {
      this.herPlanBlocks = save.herPlan.blocks;
    }

    const block = planAt(this.herPlanBlocks, save.clock % 24);
    const place = block?.placeId ?? 'home';
    const line = block && block.kind !== 'rest' ? block.label : '';

    if (worldLinked !== this._worldLinked) {
      this._worldLinked = worldLinked;
      this.setCharacterVisible(worldLinked && this.herPlaceId === 'home');
    }

    if (place !== this.herPlaceId) {
      this.herPlaceId = place;
      const t = pronoun(this.profile.gender);
      const p = getPlace(place);
      this.setCharacterVisible(worldLinked && place === 'home');
      // 她自己出了门。出门见人是一次"经历"：表达欲↑、黏人度↓。
      // 玩家看不见她这一趟，但这一趟确实改变了她之后的行为倾向。
      if (place !== 'home') {
        this.store.update((d) => {
          applyExperience(d, 'outgoing');
        });
      }
      if (place !== 'home' && worldLinked) {
        this.ui.addLog(`${t}出门了，去${p.name}了。`);

        // 在这个地方认识一个人——不是编好的固定 NPC，是"去了才会遇到"
        const person = personAt(place);
        if (person && this.store.meetPerson(person)) {
          this.ui.addLog(`${t}在${p.name}认识了「${person.name}」。`);
          this.store.addChatMsg('her', person.id, person.id, person.greet ?? '又见面啦，今天也来？');
        }

        // 她在外会随手拍张照、发条朋友圈——回来你能在手机里翻到。
        // 同一段行程只记一次，避免时间来回调时刷屏。
        const last = this.store.state.moments.filter((m) => m.profileId === this.profile.id).slice(-1)[0];
        const dup = last && last.placeId === place && Math.abs(this.store.state.clock - last.at) < 2;
        if (!dup) {
          this.store.addPhoto({
            at: save.clock,
            placeId: place,
            caption: line || `在${p.name}`,
            mood: save.character.mood,
            img: ALBUM_IMG[place],
          });
          const moment = this.store.addMoment({
            at: save.clock,
            placeId: place,
            kind: 'outing',
            author: 'her',
            text: line ? `今天${line}。` : `在${p.name}。`,
          });
          // 认识的人会在下面回一句，让朋友圈像真有人在用
          if (person) {
            const say = ['注意身体', '哈哈哈', '下次带上我', '好羡慕', '收到～', '我也想去'][
              Math.floor(Math.random() * 6)
            ];
            this.store.addMomentComment(moment.id, 'npc', person.name, say);
          }
          // 她偶尔发个微信状态：想法就发，不一定时时刻刻都有
          const st = PLACE_STATUS[place];
          if (st && Math.random() < 0.5) {
            const [emoji, word, text] = st[Math.floor(Math.random() * st.length)];
            this.store.setStatus('her', { emoji, word, text, at: save.clock });
          }
          // 她顺手给认识的人发了条消息（她的手机里看得到）
          const out = herOutingMessage(place);
          if (out) this.store.addChatMsg('her', out.contactId, 'owner', out.text, true);
        }
      } else if (place === 'home' && worldLinked) {
        this.ui.addLog(`${t}回来了。`);
      }
      this.store.save();
    }

    const p = getPlace(this.herPlaceId);
    this.ui.setPresence(
      worldLinked
        ? {
            away: this.herPlaceId !== 'home',
            placeId: this.herPlaceId,
            placeName: p.name,
            emoji: p.emoji,
            line:
              this.herPlaceId === 'home'
                ? '在家'
                : line || placeActivityLine(this.herPlaceId, this.profile.life),
            working: this.working !== null,
          }
        : {
            // 阶段 0：你还看不见她那边，只有手机那头的声音
            away: true,
            placeId: this.herPlaceId,
            placeName: '那一边',
            emoji: '📱',
            line: '只有手机那头的声音',
            working: false,
          },
    );
  }

  /** 她不在家时把角色（含配件）藏起来 */
  private setCharacterVisible(v: boolean): void {
    for (const id of ['live2d-canvas', 'acc-layer']) {
      const el = document.getElementById(id);
      if (el) el.style.visibility = v ? '' : 'hidden';
    }
  }

  /**
   * 她是否"不在眼前"：出门了，或者世界还没连上（阶段 0）。
   * 两种情况下她都不会当面开口——说的话只会落到微信里。
   * 这正是阶段 0 的关键：你只有手机那头的那个人。
   */
  get isAway(): boolean {
    return this.herPlaceId !== 'home' || !this._worldLinked;
  }

  // ── 打工赚钱 ─────────────────────────────
  /** 开始一份打工；到时间后结算金币。只在营业时间能开。 */
  startJob(jobId: string): void {
    if (this.working) return;
    const job = JOBS.find((j) => j.id === jobId);
    if (!job) return;
    const open = isJobOpen(job, this.store.state.clock % 24, new Date().getDay());
    if (!open) {
      this.ui.addLog(`${job.name}现在没开门（营业时间 ${jobHoursText(job)}）。`);
      return;
    }
    this.working = { job, startedAt: performance.now() };
    this.ui.addLog(`开始打工：${job.name}（约 ${job.seconds} 秒）。`);
    this.store.save();
  }

  private tickJob(now: number): void {
    if (!this.working) return;
    const { job, startedAt } = this.working;
    if (now - startedAt < job.seconds * 1000) return;
    this.working = null;
    this.store.addCoins(job.pay);
    this.store.save();
    this.ui.addLog(`打工结束，赚到 ${job.pay} 金币。`);
    // 在女巫工坊打工 = 人就在工坊里，女巫会开口
    if (job.placeId === 'witch-workshop') void this.witchSpeaks();
  }

  // ── 微信 / 我的手机 ─────────────────────
  /** 给已经认识的人铺一点聊天记录，让"她的手机"像真在用 */
  private ensureChats(): void {
    const save = this.store.state;
    for (const person of save.metPeople) {
      // 开局的好友申请道具不是真联系人，否则她的手机里会出现"她和自己聊天"
      if (person.id === 'her-opening') continue;
      const has = save.threads.some(
        (t) => t.owner === 'her' && t.contactId === person.id && t.profileId === this.profile.id,
      );
      if (has) continue;
      this.store.addChatMsg(
        'her',
        person.id,
        person.id,
        `在${getPlace(person.placeId).name}见过你，还记得吗？`,
      );
      this.store.addChatMsg('her', person.id, 'owner', '记得呀。');
    }

    // 女巫是她本来就认识的人（外婆的老朋友），先铺两句，
    // 别让这段关系看起来是空的 —— 同时这里就把女巫"不剧透"的态度立住了。
    const witchThread = save.threads.some(
      (t) => t.owner === 'her' && t.contactId === WITCH_ID && t.profileId === this.profile.id,
    );
    if (!witchThread) {
      this.store.addChatMsg('her', WITCH_ID, 'owner', '阿姨，我外婆……以前是不是常来你这儿？');
      this.store.addChatMsg('her', WITCH_ID, WITCH_ID, '来啊！一来就往那把椅子上瘫，一坐一下午，赶都赶不走。');
      // 年龄梗：她其实是外婆的同辈，按辈分该叫婆婆 —— 但这是她的逆鳞，也是全篇最稳的笑点
      this.store.addChatMsg('her', WITCH_ID, 'owner', '……那按辈分，我是不是该叫您婆婆？');
      this.store.addChatMsg('her', WITCH_ID, WITCH_ID, '叫阿姨。谁再叫婆婆，我把谁扔出去。');
      // 笑完立刻收一个短句：笑点和泪点用同一份素材
      this.store.addChatMsg('her', WITCH_ID, WITCH_ID, '……啧。行了，别提这些。你要的东西我还在弄，催也没用。');
    }
  }

  /**
   * 女巫开口。
   *
   * 台词由 agent 生成，但两道门都在 `requestNpcLine` 里：
   * 上下文白名单（她此刻被允许知道什么）+ 输出黑名单（命中禁词就整句丢弃换兜底）。
   * 所以哪怕模型今天不听话，也漏不出剧透。
   * 打工时玩家就在工坊里，所以这句话是**对玩家说的**，进日志与记忆，不塞进她的手机。
   */
  private async witchSpeaks(): Promise<void> {
    const npc = this.store.npcState(WITCH_ID);
    const situation = situationFor(this.store.state, npc);
    const scene: Record<NpcSituation, string> = {
      idle: '玩家在女巫工坊打完工，正站在柜台前。你跟这个不太熟的人说一句——你自来熟、话多、爱使唤人，别端着。',
      hint: '玩家在女巫工坊打完工。你知道她们在查外婆的事，但你答应过不说。你**不是**沉默寡言型：打个哈哈岔开、或者把人轰去干活，总之是不动声色地拒绝。',
      afterOpen: '玩家在女巫工坊打完工。你刚背着她们把通道打开了，她们还不知道。你不擅长撒谎，所以干脆岔开话题、催人去干活。',
      device: '玩家在女巫工坊打完工。跨界设备已经做出来了，但材料还得攒。你嘴上凶，其实在催自己。',
    };
    try {
      const r = await requestNpcLine(this.store.state, WITCH_ID, situation, scene[situation]);
      if (!r.text) return;
      this.ui.addLog(`女巫阿姨头也不抬：「${r.text}」`, true);
      this.store.addMemory({
        kind: 'event',
        summary: `在工坊打工时，女巫阿姨说：「${r.text}」`,
        weight: 2,
        tags: ['女巫', '工坊'],
      });
      this.store.save();
    } catch (err) {
      console.warn('[npc] 女巫台词失败', err);
    }
  }

  /** 我发一条朋友圈 → 她来评论 */
  private async postMoment(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    const m = this.store.addMoment({ at: this.store.state.clock, kind: 'mine', author: 'me', text: clean });
    this.store.touchMyUpdate(); // 玩家发了内容，等她查
    this.ui.addLog('你发了条朋友圈。');
    const t = pronoun(this.profile.gender);
    try {
      const r = await requestMomentComment(this.store.state, clean);
      this.store.addMomentComment(m.id, 'her', this.store.state.character.personality.name, r.text);
      this.store.addChatMsg('me', 'her', 'her', `（朋友圈）${r.text}`);
      this.ui.addLog(`${t}在你朋友圈回了一句。`);
    } catch (err) {
      console.warn('[moment] 评论失败', err);
    }
  }

  /** 相机：在当前地点拍一张，存进相册 */
  private shoot(placeId: string): void {
    const p = getPlace(placeId);
    this.store.addPhoto({
      at: this.store.state.clock,
      placeId,
      caption: `我拍的 · ${p.name}`,
      mood: this.store.state.character.mood,
      img: ALBUM_IMG[placeId],
    });
    this.store.save();
    this.ui.addLog(`你拍了一张${p.name}，存进了相册。`);
  }

  private writeMyDiary(text: string): void {    this.store.addMyDiary(text);
    this.ui.addLog('你写了今天的日记。');
  }

  private saveMyPlan(blocks: import('./core/types').PlanBlock[]): void {
    this.store.setMyPlan(blocks);
    this.ui.addLog('日程已保存。');
  }

  /**
   * Live2D 模型加载失败时的处理。
   *
   * 注意：不再"回退到矢量立绘"——那套渲染器已经删掉了（600 行死代码，
   * 且人物观感差）。现在的做法是保持房间与全部玩法可用，
   * 只在日志里说明原因，让用户知道该检查模型文件或 Cubism 版本。
   */
  private handleRendererFailure(): void {
    this.ui.setLive2DStatus({ loading: false, ready: false, error: '模型文件或 Cubism 版本不匹配' });
    this.ui.addLog('Live2D 模型没加载成功：请检查 public/character 的 moc3 版本是否 ≤ 4。', true);
    this.store.save();
  }

  // ── 主循环 ──────────────────────────────
  private loop = (now: number): void => {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.timeSec += dt;

    this.tickClock(dt);
    this.tickTyping(dt);

    // 说话计时：到时间就闭嘴，否则口型会一直开
    if (this.speaking && this.timeSec >= this.speechEndsAt) {
      this.speaking = false;
    }

    const save = this.store.state;

    // 房间（传入角色脚底坐标画接触阴影，传入时钟驱动墙上挂钟）
    const ground = this.boy.charGround?.() ?? null;
    this.room.draw(
      save.room,
      save.character.phase,
      this.timeSec,
      save.room.lampOn,
      ground?.x ?? null,
      ground?.y ?? null,
      save.clock,
    );
    // 角色层跟随昼夜色调，和房间融合
    this.applyPhaseTint(save.character.phase, save.room.lampOn);
    // 配件跟随角色锚点
    this.syncAccessories();

    // 视线平滑追随
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * Math.min(1, dt * 6);
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * Math.min(1, dt * 6);

    // 眨眼：Animator 内部维护节奏，这里把结果压进 eyeOpen
    const inputs: AnimInputs = {
      activity: save.character.activity,
      mood: save.character.mood,
      gazeTargetX: this.gaze.x,
      gazeTargetY: this.gaze.y,
      speaking: this.speaking,
      speechEnergy: this.speaking ? 1 : 0,
      reactionStartedAt: this.reaction.startedAt,
      reactionKind: this.reaction.kind,
      blinkSeed: 0,
    };

    const pose = this.animator.update(dt, this.timeSec, inputs);
    const blinking = this.animator.blinkValue;
    pose.eyeOpen *= blinking;

    this.boy.draw(pose, save.character.appearance, save.character.mood, this.timeSec);

    // Live2D 渲染器额外同步活动动作；矢量渲染器由 RigPose 自己驱动
    this.boy.syncActivity?.(save.character.activity);

    // 她此刻在哪（在家 / 出门了）
    this.tickPresence(save);
    // 打工结算
    this.tickJob(now);

    // 阶段 0 时她那边的事（当面搭话、作息台词、日记）对玩家是看不见的：
    // 世界还没连上，你只有手机。所以这些自主行为要等 _worldLinked 才跑。
    const home = this.herPlaceId === 'home' && this._worldLinked;
    // 无操作时的主动搭话（只有她在旁边时才会当面开口）
    if (home) this.maybeGossip(now);
    // 作息台词：到点自己说要去睡 / 早上打招呼
    if (home) this.tickRoutine();
    // 偶尔主动看一眼时间，顺口说一句（作息不僵硬的关键）
    if (home) this.tickTimeGlance(now);
    // 傍晚/夜里她可能随手写一笔日记
    if (this._worldLinked) this.tickDiary(now);

    // UI 数值
    this.ui.tick(save);

    // 定期存档
    if (now % 1 < dt) this.store.save();

    // 主线推进：**全项目唯一一处**（阈值与判定见 core/story.ts / store.syncStory）
    const unlocked = this.store.syncStory();
    if (unlocked === 'confess') {
      void this.playConfessionStory();
    } else if (unlocked === 'giftFumble') {
      void this.playGiftFumbleStory();
    } else if (unlocked === 'awaken') {
      // 幕后原因：女巫一个人偷偷把通道打开了（她不让任何人知道）
      this.secretlyOpenByWitch();
      // 所以这一幕只给个可爱的中二解释，**不点破** —— 那层真相留到后面才揭。
      this.ui.showStoryMonologue(
        '……等一下。\n我好像，看见你那边了。\n没有任何征兆，就是突然看见的。\n难道说，这就是「想见你」的力量吗？',
        '视界重叠',
      );
    } else if (unlocked === 'physical') {
      this.ui.showStoryMonologue(
        '女巫阿姨说，转换器终于做出来了。\n她不肯告诉我原理，只说让我自己去亲眼找答案。\n我有点紧张……但我想见你。',
        '实体破壁',
      );
    }

    // AI 有限视角：每游戏小时，按概率决定她刷不刷手机。
    // - 已读但没主动找 → 红点消失 + 不再打扰
    // - 决定找 → 等 5~30 分钟（real seconds 折算成游戏分钟）发条微信
    // - 不找 → 红点持续，玩家下次发内容还会再考虑
    this.tickAIPerspective(save, now);

    // 排期消息送达：开场白那种固定对话，到点了才一条条进会话（不耗 token）
    this.tickPendingMsgs();

    // 开局剧本推进：台词送达 → 弹快捷回复 / 播 OS
    this.tickOpening();

    // 阶段 0 的沉默催促：她道别后等不到回信，隔一阵子主动问一句
    this.tickOpeningNudge(now);

    requestAnimationFrame(this.loop);
  };

  /** 把到点的排期消息送进会话（开场白等固定对话用） */
  private tickPendingMsgs(): void {
    const n = this.store.deliverDueMsgs();
    if (n > 0) {
      const name = this.store.state.character.personality.name;
      this.ui.addLog(`${name}发来消息。`);
    }
  }

  /**
   * 关系进展到 50 —— 她坦白：外婆的遗物，以及当初加你的真实动机。
   * 这一幕走过之后，"其实我是做梦梦到的"那个谎就正式揭过去了。
   */
  private async playConfessionStory(): Promise<void> {
    const you = this.store.state.playerName;
    this.ui.openPanel('myphone');
    this.phonesMeOpenChat();
    this.ui.addLog(`${this.charPronoun()}好像有话要跟你说。`, true);
    await this.scriptMessages([
      `那个……${you}，其实我骗了你。`,
      '我不是做梦梦到你的微信号的。',
      '我外婆不久前过世了。她生前总是偷偷一个人掉眼泪，却从来不肯告诉我为什么。',
      '整理她遗物的时候，我翻到一本旧书，里面夹着一张纸条，写着你这个号码……还有一句很严厉的警告，让我别去找。',
      '可是我想知道，外婆究竟为什么难过了一辈子。',
      '我太想查明真相了，才鼓起勇气按下了添加。对不起，一开始没敢跟你说实话。',
    ], 1400);

    const choice = await this.ui.showStoryChoice(`${this.charPronoun()}向你坦白了。`, [
      '原来是为了找外婆的答案啊……别担心，我陪你一起找。',
      '外婆当年，是不是深爱过我这边的长辈？……谢谢你愿意告诉我。',
    ]);
    this.store.addChatMsg('me', 'her', 'owner', choice === 0
      ? '原来是为了找外婆的答案啊……别担心，我陪你一起找。'
      : '外婆当年，是不是深爱过我这边的长辈？……谢谢你愿意告诉我。');
    await this.scriptMessages(['……谢谢你。', '那我们说好了，一起找。'], 1100);

    this.store.addMemory({
      kind: 'milestone',
      summary: `${this.charPronoun()}向你坦白：她是为了查外婆抱憾一生的真相，才加了你。`,
      weight: 5,
      tags: ['坦白', '外婆', '遗物'],
    });
    this.store.pushTimeline('她坦白了外婆的遗物');
    this.store.save();
  }

  /** 关系进展到 150 后播放一次完整的跨界发现剧情。 */
  private async playGiftFumbleStory(): Promise<void> {
    const name = this.store.state.character.personality.name;
    this.ui.openPanel('myphone');
    // 接受好友后才能进入本段主线；若旧档尚未通过申请，就提示并等下次主循环重试。
    const opening = this.store.state.metPeople.find((p) => p.id === 'her-opening');
    if (opening && !opening.added) {
      this.store.update((d) => { d.story.giftFumbleAt = null; });
      return;
    }
    this.phonesMeOpenChat();
    this.ui.addLog(`${this.charPronoun()}兴冲冲地说有件好消息要告诉你。`, true);
    await this.scriptMessages([
      '对啦对啦！告诉你一个超级好消息！',
      '我今天去镇上的市集，看到一个特别精致的手作限定挂件，第一眼就觉得特别适合你！',
      '快把详细收货地址发给我，我顺路去驿站寄给你，当作认识这么久的惊喜礼物♪',
    ], 1250);

    const addressSubmitted = await this.ui.showAddressDialog();
    if (!addressSubmitted) return;
    // 输入框只做必填校验，地址不离开输入框、不写入会话、存档或网络请求。
    const firstChoice = await this.ui.showStoryChoice(`怎么回复${this.charPronoun()}？`, [
      '哇，太惊喜了！地址发你啦，谢谢你呀~',
      '居然还悄悄准备了礼物？那我以后也得想想送你什么了。',
    ]);
    this.store.addChatMsg('me', 'her', 'owner', firstChoice === 0
      ? '哇，太惊喜了！地址发你啦，谢谢你呀~'
      : '居然还悄悄准备了礼物？那我以后也得想想送你什么了。');
    await this.scriptMessages(['嘿嘿，不客气！我这就去驿站排队～你等我好消息哦！📮'], 900);

    await new Promise((resolve) => window.setTimeout(resolve, 5000));
    await this.scriptMessages([
      '诶……？奇怪了。',
      '我刚拿着地址去驿站，工作人员在电脑上输了半天，说系统一直报错：查无此行政区……',
      '我用快递软件搜了一下，你说的省和城市，在我们这里的系统里都不存在呀？',
    ], 1150);
    const secondChoice = await this.ui.showStoryChoice(`${this.charPronoun()}在驿站遇到了问题。`, [
      '怎么可能？这可是挺大的城市啊，你是不是拼音或字打错了？',
      '你搜搜看全称呢？或者是驿站的网络出故障了吧？',
    ]);
    this.store.addChatMsg('me', 'her', 'owner', secondChoice === 0
      ? '怎么可能？这可是挺大的城市啊，你是不是拼音或字打错了？'
      : '你搜搜看全称呢？或者是驿站的网络出故障了吧？');
    await this.scriptMessages([
      '我核对了好几次，字完全没错呀……',
      '等一下哦，我打开我们这里的权威世界地图软件查查看……',
      { image: '/map/eislan.jpg' },
    ], 1150);
    this.ui.showStoryMonologue(
      '这张地图上，没有我们这边任何一个国家或城市。\n难道我们真的隔着完全不同的世界？！',
      '异世界？',
    );
    await this.scriptMessages([
      '怎么会这样……地图上完全找不到你的城市……',
      '我们真的踩在完全不同的世界里吗……？',
      '那我是不是……永远都没法把礼物亲手送到你手里了？',
      '呜，眼睛有点湿了……等我一下，我去摸个纸巾。',
    ], 950);
    await new Promise((resolve) => window.setTimeout(resolve, 3000));
    await this.scriptMessages([
      '对方撤回了一条消息',
      '打错字了……手太笨，刚才找纸巾把桌上的置物盒撞翻了。',
      '纸巾没摸到，把外婆以前留下的老摆件给砸地上了，我头顶还挨了一下……',
    ], 1100);
    const thirdChoice = await this.ui.showStoryChoice(`先确认${this.charPronoun()}有没有受伤。`, [
      '噗……没事吧？有没有碰痛头呀？',
      '手忙脚乱的也太可爱了……没受伤吧？',
    ]);
    this.store.addChatMsg('me', 'her', 'owner', thirdChoice === 0
      ? '噗……没事吧？有没有碰痛头呀？'
      : '手忙脚乱的也太可爱了……没受伤吧？');
    this.ui.showStoryMonologue(
      `虽然隔着屏幕看不到，但脑海里已经浮现出${this.charPronoun()}手忙脚乱撞翻盒子、被纸巾盒砸中的笨拙画面了……`,
      '脑内画面',
    );
    await this.scriptMessages([
      '没受伤啦，就是有点丢脸……这个老摆件居然完全没坏，还在地上咔哒咔哒地摇。',
      '我小时候听外婆说过：明明一点风都没有，它怎么总能顺着那边的节奏在响呢。',
      '那时候我觉得外婆记错了，窗子明明开着。可刚才看着它摇，我突然觉得……就算隔着不同世界、现在摸不到，我也不要和你断开联系！',
    ], 1200);
    const fourthChoice = await this.ui.showStoryChoice('摆件和不想断联，好像不是一回事？', [
      '虽然确实很感动……但“看着摆件摇晃”和“不跟我断开联系”，这是什么逻辑啊？',
      '等一下，这摆件摇晃跟你不跟我断开联系……有什么必然联系吗？',
    ]);
    this.store.addChatMsg('me', 'her', 'owner', fourthChoice === 0
      ? '虽然确实很感动……但看着摆件摇晃和不跟我断开联系，这是什么逻辑啊？'
      : '等一下，这摆件摇晃跟你不跟我断开联系……有什么必然联系吗？');
    await this.scriptMessages([
      '因为……我觉得你肯定和它一样，呆呆的、又有点可爱啊！看到它就想起你了！',
    ], 1100);
    this.ui.showStoryMonologue('喂喂……我怎么就跟那个摇摇晃晃的呆呆摆件像了啊！', '逻辑吐槽');
    const fifthChoice = await this.ui.showStoryChoice('要不要反击一下？', [
      '喂！我哪里呆了，明明是你在平地摔跤手忙脚乱好不好！',
      '好吧，看在你夸我可爱的份上，就不跟你计较啦~',
    ]);
    this.store.addChatMsg('me', 'her', 'owner', fifthChoice === 0
      ? '喂！我哪里呆了，明明是你在平地摔跤手忙脚乱好不好！'
      : '好吧，看在你夸我可爱的份上，就不跟你计较啦~');
    await this.scriptMessages([
      '嘿嘿，被它这么一闹，我刚才那种难过得要死的感觉都没了～',
      '反正，就算只能隔着屏幕，我也要一直一直陪着你！',
    ], 1200);
    this.store.addMemory({ kind: 'event', summary: `我们发现地图属于两个不同的世界；${this.charPronoun()}摔倒时撞翻了外婆留下的摇摆摆件，并决定继续陪伴彼此。`, weight: 5, tags: ['异世界', '外婆', '摆件'] });
    this.store.save();
    this.ui.addLog(`${name}说会一直陪着你。`, true);
  }

  private phonesMeOpenChat(): void {
    this.ui.openPanel('myphone');
    // UI 面板刚打开时，通过聊天页的公开入口保持和普通聊天一致。
    this.ui.openChatWithHer();
  }

  /**
   * 逐条把她的话排进会话（走排期队列，像真人一条条打出来）。
   * 一行既可以是纯文本，也可以是 `{ text, image }` —— 后者送达时会成为一条图片消息，
   * 和真人微信一样留在聊天记录里（可翻回、可点开），而不是弹一次就没的弹窗。
   */
  private scriptMessages(
    lines: Array<string | { text?: string; image: string }>,
    intervalMs: number,
  ): Promise<void> {
    const base = Date.now();
    this.store.scheduleMsgs(lines.map((line, index) => {
      const one = typeof line === 'string' ? { text: line, image: undefined } : line;
      return {
        owner: 'me' as const,
        contactId: 'her',
        from: 'her' as const,
        text: one.text ?? '',
        image: one.image,
        dueAt: base + intervalMs * (index + 1),
      };
    }));
    return new Promise((resolve) => window.setTimeout(resolve, intervalMs * lines.length + 120));
  }

  /** 开场沉默催促的固定台词（也用作"是否已催过"的判据，写死别改） */
  private static readonly NUDGE_LINES = ['……在吗？', '那个……你还在吗？'];
  /** 催促节奏：她最后一条消息发出去之后，隔多久催一次（真实毫秒） */
  private static readonly NUDGE_DELAYS = [180_000, 300_000, 600_000];

  /** 按当前性格重建剧本树（换立绘=换人，剧本语气也跟着换） */
  private buildOpening(): OpeningScript {
    const c = this.store.state.character;
    return buildOpeningScript(c.personality.preset, c.personality.gender, c.personality.name, this.store.state.playerName);
  }

  /**
   * 开局剧本的推进（每 tick）：
   * 1. 她某一层的台词全部送达后，如果该层有选项 → 弹出快捷回复；
   * 2. 节点自带的 OS（玩家心里话）跟着播一遍（大字）。
   * 判定全部基于存档（阶段 0 + 已通过申请 + 队列空 + 最后一条她的台词能定位节点），
   * 所以刷新页面也接得上，不依赖运行时标记。
   */
  private tickOpening(): void {
    if (this.openingAbandoned) return;
    const st = this.store.state;
    if (st.story.phase !== 0) return;
    const op = st.metPeople.find((p) => p.id === 'her-opening');
    if (!op || !op.added) return; // 还没通过好友申请
    if (!this.openingScript) this.openingScript = this.buildOpening();
    if (this.store.pendingHerCount() > 0) return; // 她还在打字，等这层发完

    const th = st.threads.find(
      (t) => t.owner === 'me' && t.contactId === 'her' && t.profileId === st.profileId,
    );
    const msgs = th?.msgs ?? [];
    const lastHer = [...msgs].reverse().find((m) => m.from === 'her');
    if (!lastHer) return;

    // 玩家跳过剧本自己打字聊过 → 放弃剧本（onSend 也会清，这里管刷新后的情况）
    const lastAny = msgs[msgs.length - 1];
    if (lastAny && lastAny.from !== 'her' && lastAny.from !== 'sys') {
      this.openingAbandoned = true;
      this.ui.hideOpeningChoices();
      return;
    }

    // 内心：每个节点最后一条台词送达时，播该节点的心里话
    const node = this.openingNodeByLastLine(lastHer.text);
    if (node?.neixin) {
      const key = Array.isArray(node.neixin) ? node.neixin.join('|') : node.neixin;
      if (key !== this.lastNeixinKey) {
        this.lastNeixinKey = key;
        this.ui.setNeixin(node.neixin, true);
      }
    }
    // 到选择点了 → 弹快捷回复。
    // 但她的气泡是**逐字浮现**的（每个字 26ms + 0.32s 动画，见 hud 的 staggerChars），
    // 必须等这段动画跑完才算"说完"——否则她还在打字，底下就已经能选了。
    if (node?.options?.length) {
      const landedAt = new Date(lastHer.iso).getTime();
      const settleMs = Math.min([...lastHer.text].length * 26 + 320, 2200) + 260;
      if (Number.isFinite(landedAt) && Date.now() - landedAt < settleMs) return;
      this.ui.showOpeningChoices(node.options.map((o) => o.label));
    }
  }

  /** 剧情节点有预设台词/选项时，只允许玩家通过剧情选项回应。 */
  private openingInputLocked(): boolean {
    if (this.openingAbandoned || this.store.state.story.phase !== 0) return false;
    const st = this.store.state;
    const op = st.metPeople.find((p) => p.id === 'her-opening');
    if (!op?.added) return false;
    if (this.store.pendingHerCount() > 0) return true;
    if (!this.openingScript) this.openingScript = this.buildOpening();
    const thread = st.threads.find(
      (t) => t.owner === 'me' && t.contactId === 'her' && t.profileId === st.profileId,
    );
    const lastHer = [...(thread?.msgs ?? [])].reverse().find((m) => m.from === 'her');
    if (!lastHer) return false;
    const node = this.openingNodeByLastLine(lastHer.text);
    if (!node) return false;
    if (node.options?.length) return true;
    const landedAt = new Date(lastHer.iso).getTime();
    const settleMs = Math.min([...lastHer.text].length * 26 + 320, 2200) + 260;
    return Number.isFinite(landedAt) && Date.now() - landedAt < settleMs;
  }

  /** 最后一条台词 → 节点（刷新后重建进度用） */
  private openingNodeByLastLine(text: string): OpeningNode | null {
    return this.openingScript?.nodeByLastLine.get(text) ?? null;
  }

  /** 玩家从快捷回复里选了一句 → 发出去，接着播下一层 */
  private pickOpeningChoice(label: string): void {
    const st = this.store.state;
    const th = st.threads.find(
      (t) => t.owner === 'me' && t.contactId === 'her' && t.profileId === st.profileId,
    );
    const lastHer = (th?.msgs ?? []).filter((m) => m.from === 'her').slice(-1)[0];
    const node = lastHer ? this.openingNodeByLastLine(lastHer.text) : null;
    const choice = node?.options?.find((o) => o.label === label);
    this.ui.hideOpeningChoices();
    if (!choice) return;
    this.store.addChatMsg('me', 'her', 'owner', label, false);
    // leadBeats=1：玩家这句发出去之后，先隔一拍她再回，别同时冒出来
    this.store.scheduleMsgs(scheduleNode(choice.next, Date.now(), undefined, 1));
    this.lastNeixinKey = ''; // 让下一层内心能播
  }

  /**
   * 阶段 0 的沉默催促：她道别之后玩家一直不回，隔一阵子主动问一句"……在吗？"。
   * 节奏按**她最后一条消息的真实时间戳**算（存档里查得到），刷新也接得上；
   * 间隔放得比较长——催太紧会显得烦人。
   */
  private tickOpeningNudge(now: number): void {
    const st = this.store.state;
    if (st.story.phase !== 0) return;
    const op = st.metPeople.find((p) => p.id === 'her-opening');
    if (!op || !op.added) return; // 还没通过好友申请
    const th = st.threads.find(
      (t) => t.owner === 'me' && t.contactId === 'her' && t.profileId === st.profileId,
    );
    const msgs = th?.msgs ?? [];
    // ⚠️ 玩家自己发的话 from 是 'owner'（不是 'me'）——写错会导致
    // "玩家明明聊过了还催在吗"（拜拜后立马追问的那个 bug）
    if (msgs.some((m) => m.from === 'owner')) return; // 玩家已经开口，不催
    const hers = msgs.filter((m) => m.from === 'her');
    if (!hers.length) return;
    // 剧本还没播完（还在等选择）不催——那会儿她正等着玩家接话呢
    if (!this.openingAbandoned && this.openingScript) {
      const node = this.openingNodeByLastLine(hers[hers.length - 1].text);
      if (node?.options?.length) return;
    }
    if (this.store.pendingHerCount() > 0) return; // 她还在打字
    const sent = hers.filter((m) => Game.NUDGE_LINES.includes(m.text)).length;
    if (sent >= Game.NUDGE_LINES.length) return;
    const lastAt = hers[hers.length - 1].at;
    const delay = Game.NUDGE_DELAYS[Math.min(sent, Game.NUDGE_DELAYS.length - 1)];
    if (now - lastAt < delay) return;

    this.store.addChatMsg('me', 'her', 'her', Game.NUDGE_LINES[sent], true);
    this.ui.addLog(`${st.character.personality.name}又发来一条。`);
  }

  /** 游戏内时钟始终跟随真实本地时间（再叠加玩家手动偏移），做到"时间和现实统一"。 */
  private tickClock(dt: number): void {
    this.store.update((d) => {
      d.clock = realHours() + d.timeOffset;
      const phase = clockToPhase(d.clock);
      const phaseChanged = phase !== d.character.phase;
      d.character.phase = phase;

      if (phaseChanged) {
        d.character.energyValue = phase === 'night' ? Math.min(100, d.character.energyValue + 12) : Math.max(10, d.character.energyValue - 6);
      }

      // 时间流动缓慢消耗精力；作息会自动切换活动
      d.character.energyValue = Math.max(0, Math.min(100, d.character.energyValue - dt * 0.06));
      if (d.character.energyValue < 20) d.character.mood = 'sleepy';

      // 活动自动轮换：精力够且没被玩家锁定时，按"人设 + 当前真实时间"挑一个在做的活动。
      // 不是死板到点的切换，而是以时间段为基线、性格微调，让 18:25 自然对应做饭/吃饭之类。
      const now = performance.now();
      if (now > this.activityLockUntil && this.animator.current) {
        const want = dailyActivity(d.clock, d.character.personality.preset, d.character.energyValue);
        if (want !== d.character.activity && Math.random() < dt * 0.12) {
          d.character.activity = want;
        }
      }
    });
  }

  // ── 打字机效果 ────────────────────────────
  private tickTyping(dt: number): void {
    const buf = this.typingBuffer;
    if (!buf) return;
    const rate = this.store.state.character.personality.speechRate;
    const step = rate * dt;
    const before = buf.idx;
    buf.idx = Math.min(buf.text.length, buf.idx + step);
    const shown = buf.text.slice(0, Math.floor(buf.idx));

    if (Math.floor(buf.idx) !== before) {
      this.ui.setBubble(shown);
    }
    if (buf.idx >= buf.text.length) {
      this.typingBuffer = null;
      buf.done?.();
    }
  }

  /**
   * 角色说话的唯一入口：气泡（瞬时）+ 语音 + 打字机，**同时写入左侧聊天面板 thread**。
   * 统一到这里是关键——之前触摸/送礼/活动的台词只进气泡不进 thread，
   * 才显得"头顶说的话"和"聊天框里的记录"对不上。
   */
  private say(line: string, instant = false, intent?: import('./core/types').IntentSchema): void {
    if (!line) return;
    const away = this.isAway;
    // 出门在外时头顶气泡不出现（人不在，只有手机消息）
    if (!away) this.ui.setBubble('');
    // 同一句话同时进气泡和聊天面板，两边永远一致
    this.ui.pushTurn({ role: 'boy', text: line, iso: new Date().toISOString(), intent });
    if (away || instant) {
      if (!away) this.ui.setBubble(line);
      this.startSpeaking(line);
    } else {
      this.typingBuffer = { text: line, idx: 0, done: () => this.startSpeaking(line) };
    }
    // 人不在家 = 她在"发消息"，所以落进微信记录；当面说就不落
    if (away) this.store.addChatMsg('me', 'her', 'her', line);
  }

  /** 说话时长按字数估算，驱动口型；同时触发语音 */
  private startSpeaking(line: string): void {
    const rate = this.store.state.character.personality.speechRate;
    this.speaking = true;
    this.speechEndsAt = this.timeSec + line.length / rate + 0.25;
    voice.speak(
      line,
      this.store.state.character.personality.preset,
      this.store.state.character.personality.gender,
    );
  }

  /**
   * 当前角色的第三人称。
   * 所有面向玩家的文案都必须经过它——Natori 是男性立绘，
   * 写死"她"就会让他显示成她。注意这不只是称呼问题：
   * 玩家性别也是可选的，这个项目不预设固定配对。
   */
  private charPronoun(): '他' | '她' {
    return pronoun(this.store.state.character.personality.gender);
  }

  // ── 输入：触摸 ───────────────────────────
  private bindInput(): void {


    // 当前可见的角色层才是接收触摸的目标
    const layer = () => this.canvasFor(this.profile);

    const move = (x: number, y: number) => {
      const el = layer();
      const rect = el.getBoundingClientRect();
      const px = x - rect.left;
      const py = y - rect.top;
      // 视线：角色站在 40% 宽度处，把触摸点换算成相对偏移
      const cx = rect.width * 0.4;
      this.gazeTarget.x = Math.max(-1, Math.min(1, (px - cx) / (rect.width * 0.3)));
      this.gazeTarget.y = Math.max(-1, Math.min(1, (py - rect.height * 0.5) / (rect.height * 0.3)));
    };

    // 视觉反馈：点哪儿就在哪儿留一个涟漪，让人确信"我点到了"
    const ripple = (x: number, y: number, hit: boolean) => {
      const el = layer();
      const rect = el.getBoundingClientRect();
      const r = document.createElement('div');
      r.className = hit ? 'ripple hit' : 'ripple';
      r.style.left = `${x - rect.left}px`;
      r.style.top = `${y - rect.top}px`;
      el.parentElement?.appendChild(r);
      window.setTimeout(() => r.remove(), 620);
    };

    const onDown = (e: PointerEvent) => {
      if (this.isAway) return; // 她不在家，点不到人
      move(e.clientX, e.clientY);
      const el = layer();
      const rect = el.getBoundingClientRect();
      const part = this.boy.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      ripple(e.clientX, e.clientY, part !== null && part !== 'none');
      if (part && part !== 'none') this.handleTouch(part as TouchKind);
    };

    layer().addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
    layer().addEventListener('pointerdown', onDown);
    layer().addEventListener('pointerleave', () => {
      this.gazeTarget = { x: 0, y: 0 };
    });

    window.addEventListener('resize', this.resize);
    window.addEventListener('orientationchange', () => setTimeout(this.resize, 120));
    window.addEventListener('beforeunload', () => this.store.save());
    this.resize();
  }

  private resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.room.resize(w, h);
    this.boy.resize(w, h);
  };

  /**
   * 让角色"泡"进小屋的光线里。
   * Live2D 画布不受房间的昼夜/台灯压暗影响，夜里会出现"背景很暗、人却白得发光"的
   * 割裂感。这里按昼夜给角色层加一层色调滤镜，人就和环境融在一起了。
   */
  private lastTintKey = '';
  private applyPhaseTint(phase: DayPhase, lampOn: boolean): void {
    const key = `${phase}${lampOn ? '+lamp' : ''}`;
    if (key === this.lastTintKey) return;
    this.lastTintKey = key;
    const table: Record<DayPhase, string> = {
      morning: 'none',
      noon: 'none',
      evening: 'brightness(0.95) sepia(0.12) saturate(1.02)',
      night: lampOn
        ? 'brightness(0.88) sepia(0.16)'
        : 'brightness(0.66) saturate(0.85) hue-rotate(-8deg)',
    };
    const f = table[phase];
    for (const id of ['live2d-canvas', 'boy-canvas', 'acc-layer']) {
      const el = document.getElementById(id);
      if (el) el.style.filter = f;
    }
  }

  // ── 交互处理 ─────────────────────────────
  private handleTouch(part: TouchKind): void {
    // 实体未购入前不能触摸。提示玩家去手机里买实体。
    if (!this.store.state.story?.hasPhysical) {
      this.ui.addLog('她还不在你身边……先在「状态」里给她买一个实体。');
      return;
    }
    const result = resolveTouch(part, this.store.state);
    this.store.update((d) => {
      applyGain(d, result.affinityDelta, result.moodDelta, 'touch');
      // 被摸头/碰脸容易害羞
      if (result.emotion === 'shy') d.character.mood = 'shy';
      d.character.activity = 'idle';
    });
    this.reaction = { kind: part === 'head' ? 'patted' : part === 'face' ? 'shy' : 'surprised', startedAt: performance.now() };
    this.activityLockUntil = performance.now() + 3500;
    this.boy.playReaction?.();
    this.say(result.line);
    this.ui.addLog(result.summary, result.memorable);
    if (result.memorable) {
      this.store.addMemory({ kind: 'touch', summary: result.summary, weight: result.weight, tags: ['触碰', part] });
    }
    this.markDiarySignal(result.memorable ? 2 : 1, result.summary);
    this.store.save();
  }

  private handleGift(id: string): void {
    // 实体未购入前，礼物也送不过去（不在同一个世界）。
    if (!this.store.state.story?.hasPhysical) {
      this.ui.addLog('礼物还送不过去……先在「状态」里给她买一个实体吧。');
      return;
    }
    const gift = GIFTS.find((g) => g.id === id);
    if (!gift) return;
    const result = resolveGift(gift, this.store.state);
    this.store.update((d) => {
      applyGain(d, result.affinityDelta, result.moodDelta, 'gift');
      d.character.mood = 'happy';
      if (!d.character.likedGifts.includes(gift.id) && Math.random() < 0.5) {
        d.character.likedGifts.push(gift.id);
      }
      d.character.activity = 'idle';
    });
    this.reaction = { kind: 'gift', startedAt: performance.now() };
    this.activityLockUntil = performance.now() + 4000;
    this.say(result.line);
    this.ui.addLog(result.summary, true);
    this.store.addMemory({ kind: 'gift', summary: result.summary, weight: result.weight, tags: ['礼物', gift.label] });
    this.store.pushTimeline(`收到${gift.label}`);
    this.store.addMoment({ at: this.store.state.clock, kind: 'gift', author: 'her', text: `收到了${gift.label}。` });
    this.markDiarySignal(2, result.summary);
    this.store.save();
  }

  private handleActivity(id: string): void {
    // 共同活动要她真的在你身边（买了实体）才做得到
    if (!this.store.state.story?.hasPhysical) {
      this.ui.addLog('还碰不到她……先在「状态」里给她买一个实体吧。');
      return;
    }
    const def = ACTIVITIES.find((a) => a.id === id);
    if (!def) return;
    const result = resolveActivity(def, this.store.state);
    this.store.update((d) => {
      applyGain(d, result.affinityDelta, result.moodDelta, 'activity');
      d.character.activity = def.activity;
      d.character.mood = 'happy';
    });
    this.activityLockUntil = performance.now() + 9000;
    this.say(result.line);
    this.ui.addLog(result.summary, true);
    this.store.addMemory({ kind: 'event', summary: result.summary, weight: result.weight, tags: ['共同活动', def.label] });
    this.markDiarySignal(result.memorable ? 2 : 1, result.summary);
    this.store.save();
  }

  // ── 环境状态变化 ─────────────────────────
  private toggleLamp(): void {
    this.store.update((d) => {
      d.room.lampOn = !d.room.lampOn;
    });
    const on = this.store.state.room.lampOn;
    this.ui.addLog(on ? '你打开了台灯。' : '你关掉了台灯。');
    if (on && this.store.state.character.phase === 'night') {
      this.store.update((d) => {
        d.character.moodValue = Math.min(100, d.character.moodValue + 3);
      });
    }
    this.store.save();
  }

  private toggleCurtain(): void {
    this.store.update((d) => {
      d.room.curtainOpen = !d.room.curtainOpen;
      // 拉上窗帘会变暗，夜里角色更容易困
      if (!d.room.curtainOpen) d.character.energyValue = Math.max(0, d.character.energyValue - 2);
    });
    this.ui.addLog(this.store.state.room.curtainOpen ? '你拉开了窗帘。' : '你拉上了窗帘。');
    this.store.save();
  }

  private toggleTidy(): void {
    this.store.update((d) => {
      d.room.tidiness = d.room.tidiness >= 95 ? 55 : 96;
      // 房间整洁度影响心情
      d.character.moodValue = Math.max(
        0,
        Math.min(100, d.character.moodValue + (d.room.tidiness > 90 ? 4 : -3)),
      );
    });
    const tidy = this.store.state.room.tidiness;
    this.ui.addLog(tidy > 90 ? '你把房间收拾干净了。' : '你把房间弄乱了一点。');
    this.store.save();
  }

  /** 把时间设到指定时刻（"HH:MM"）。设完时钟仍从该点继续走（跟随真实时间流逝）。 */
  private setTime(hhmm: string): void {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return;
    const target = (Number(m[1]) % 24) + Number(m[2]) / 60;
    this.store.update((d) => {
      d.timeOffset = target - realHours();
      d.clock = target;
      d.character.phase = clockToPhase(d.clock);
    });
    this.ui.addLog(`把时间调到了 ${formatClock(this.store.state.clock)}。`);
    this.store.save();
  }

  /** 同步回真实当前时间（把手动偏移清零）。 */
  private syncTime(): void {
    this.store.update((d) => {
      d.timeOffset = 0;
      d.clock = realHours();
      d.character.phase = clockToPhase(d.clock);
    });
    this.ui.addLog(`已同步到真实时间 ${formatClock(this.store.state.clock)}。`);
    this.store.save();
  }

  /**
   * 引擎护栏：明显的恶语不该被模型解读成撒娇。
   * "说什么话"交给模型，但"被骂了不可能更喜欢你"是确定性规则 ——
   * 和"白天不许睡觉"属于同一类约束，不交给模型判断。
   */
  private static readonly HOSTILE =
    /你好烦|闭嘴|滚开|你滚|讨厌你|不想理你|烦死|智障|傻逼|傻比|去死|神经病|别烦我/i;

  // ── 大模型对话 ───────────────────────────
  private async sendToModel(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean || this.pendingReply || this.openingInputLocked()) return;
    // 开局剧本进行中玩家直接打字 = 跳过剧本：撤掉还没播的台词，
    // 否则她的固定台词会和模型的回复撞成"精分"。
    if (!this.openingAbandoned && this.store.state.story.phase === 0) {
      const op = this.store.state.metPeople.find((p) => p.id === 'her-opening');
      if (op?.added && this.store.pendingHerCount() > 0) {
        this.openingAbandoned = true;
        this.store.clearPendingMsgs();
        this.ui.hideOpeningChoices();
      } else if (op?.added) {
        this.openingAbandoned = true;
        this.ui.hideOpeningChoices();
      }
    }
    this.pendingReply = true;
    this.ui.setThinking(true);
    this.ui.pushTurn({ role: 'user', text: clean, iso: new Date().toISOString() });
    // 我和她的对话同时写进微信记录（我的手机里能翻到、也会持久化）
    this.store.addChatMsg('me', 'her', 'owner', clean);
    this.store.touchMyUpdate(); // 玩家发了消息，等她看到

    // 用户消息也进记忆（低权重），模型能看到自己刚说过什么
    this.store.addMemory({ kind: 'dialogue', summary: `你说：${clean}`, weight: 2, tags: ['对话'] });
    // 陪她聊天能攒一点金币（商城用）
    this.store.addCoins(1);

    try {
      const place = getPlace(this.herPlaceId);
      const placeLine =
        this.herPlaceId === 'home'
          ? ''
          : `你（${this.store.state.character.personality.name}）现在不在家，人在${place.name}，${
              placeActivityLine(this.herPlaceId, this.profile.life)
            }；对方是在用手机给你发消息，不是在你身边。`;
      const result = await requestReply(this.store.state, clean, this.config, undefined, placeLine);
      const intent = result.safe.intent;
      const save = this.store.state;

      // 白名单之后的引擎处理：模型说了什么不重要，字段合法才生效
      const action = reconcileAction(intent.action, save.clock, save.character.energyValue);
      // 害羞阈值不再读预设常量，而是由 traits 推出来——
      // 戒备心高的她，同一句话也会更容易脸红。
      const mood = resolveMood(
        intent.emotion,
        intent.intensity,
        save.character.affinity,
        effectiveStats(save).shyThreshold,
      );

      this.store.update((d) => {
        d.character.mood = mood;
        d.character.activity = action;
        // 关系涨跌由**她自己**决定：模型（或离线规则）给出她对这次对话的真实感受，
        // 引擎再 clamp 一遍。不再是"聊一句就固定 +1.5"的无脑累加。
        // 前端不弹任何提示 —— 想知道她怎么想，去状态面板看。
        // 恶语还要再过一道护栏：模型今天心情好、把人骂它当撒娇，引擎不允许。
        const bond = Game.HOSTILE.test(clean)
          ? Math.min(intent.affinityDelta, -0.5)
          : intent.affinityDelta;
        d.character.affinity = clampNum(d.character.affinity + bond, 0, AFFINITY_MAX);
        // 她开口、你接住了 —— 这是一次"经历"，会改写她的表达欲与戒备心
        applyExperience(d, 'chat_reply');
      });
      this.lastPlayerReplyAt = performance.now();
      this.activityLockUntil = performance.now() + 6000;

      // 重要对话 / 情绪强烈的对话 → 记下写日记的契机
      if (intent.memorable === 1) {
        this.markDiarySignal(2, `关于「${clean.slice(0, 12)}」的那次聊天`);
      } else if (intent.intensity >= 0.7) {
        this.markDiarySignal(1, `和你聊「${clean.slice(0, 10)}」聊得起劲`);
      }

      if (intent.skip === 1) {
        // 她选择这次不回 —— 真人不会每句都接。心情/关系已在上面的 update 里结算，
        // 只是不发这条消息（比如玩家只是道了个别，硬接一句反而像失忆）。
      } else {
        this.say(intent.line, false, intent);
        if (intent.memorable === 1) {
          this.store.addMemory({
            kind: 'dialogue',
            summary: `关于「${clean.slice(0, 12)}」，${intent.line.slice(0, 24)}`,
            weight: 4,
            tags: ['重要对话', mood],
          });
        }
      }

      if (result.provider === 'offline') {
        this.ui.addLog(result.error ? `大模型不可用（${result.error}），已切到离线回复。` : '当前为离线回复。');
      }
      if (result.safe.repaired.length) {
        console.warn('[intent] 字段被修正:', result.safe.repaired);
      }
      this.ui.setLatency(result.latencyMs, result.provider !== 'offline');
    } catch (err) {
      this.ui.addLog(`对话出错：${(err as Error).message}`);
      this.say('……我有点走神。');
    } finally {
      this.pendingReply = false;
      this.ui.setThinking(false);
      this.store.save();
    }
  }

  /** 长时间无操作时，她自己开口 */
  private maybeGossip(now: number): void {
    if (this.pendingReply || this.typingBuffer || this.speaking) return;
    if (now - this.lastGossipAt < 45_000) return;
    const line = idleGossip(this.store.state);
    if (!line) {
      this.lastGossipAt = now - 30_000; // 失败也要退避，避免每帧重试
      return;
    }
    this.lastGossipAt = now;
    this.say(line);
  }

  /**
   * 主动"看时间"。
   *
   * 这是"作息不僵硬"的关键反差点：不是到点机械切换活动，而是她**偶尔**瞄一眼
   * 钟、顺口说一句"六点半了该吃饭了"之类。间隔随机（6~15 分钟，性格越外向越勤），
   * 而且有相当概率"看了也不说"——像真人那样不刻意。
   */
  private tickTimeGlance(now: number): void {
    if (this.pendingReply || this.typingBuffer || this.speaking) return;
    if (now < this.nextTimeGlanceAt) return;
    const c = this.store.state.character;
    const init = c.personality.initiative;
    // 随机下次时间点，性格越主动间隔越短
    this.nextTimeGlanceAt = now + (6 * 60_000 + Math.random() * 9 * 60_000) * (1.4 - init);
    if (Math.random() > 0.45 + init * 0.3) return; // 很多时候只是看了看，没说
    const line = timeGlance(this.store.state);
    if (line) this.say(line);
  }

  /**
   * 日记：傍晚到夜里，她**可能**随手写一笔当天的感受——不是每天必写，
   * 看性格（越主动越勤）和当天有没有值得记的事。
   * 正文由大模型生成第一人称短句；不可用时退回离线模板。
   */
  /** 记下"值得写进日记"的情绪契机（取最强的一条）。 */
  private markDiarySignal(strength: number, note: string): void {
    if (!this.diarySignal || strength > this.diarySignal.strength) {
      this.diarySignal = { strength, note };
    }
  }

  /**
   * 日记：**由情绪契机驱动，而不是每天固定写**。
   * 参考《妹居物语》/《胡桃日记》的做法——日记映射真实发生的互动与情绪：
   *   · 强契机（收到契合礼物、被记住的对话、一起活动）随时可写；
   *   · 弱契机（普通触碰/心情小波动）要等到傍晚之后才写，避免白天碎碎念；
   *   · 每次写完冷却若干小时、同一天最多一篇。
   * 没有任何契机时，就什么都不写（所以"今天没心情，没写日记"是完全正常的）。
   */
  private tickDiary(now: number): void {
    if (this.diaryPending) return;
    if (now < this.nextDiaryCheckAt) return;
    this.nextDiaryCheckAt = now + 90_000; // 每 90 秒评估一次

    const save = this.store.state;
    const sig = this.diarySignal;
    if (!sig) return; // 没有情绪契机 → 不写

    const clock = save.clock;
    const hour = clock % 24;
    const day = Math.floor(clock / 24);

    // 冷却：距上次日记至少 4 小时；同一天最多一篇
    if (this.lastDiaryClock !== null && clock - this.lastDiaryClock < 4) return;
    if (this.lastDiaryDay === day) return;
    // 弱契机要等到傍晚之后
    if (sig.strength < 2 && hour < 19) return;

    this.lastDiaryDay = day;
    this.lastDiaryClock = clock;
    this.diarySignal = null;
    this.diaryPending = true;

    void requestDiary(save, sig.note)
      .then((r) => {
        this.store.addDiary({ day, text: r.text, mood: this.store.state.character.mood });
        this.store.addMoment({ at: this.store.state.clock, kind: 'diary', author: 'her', text: r.text });
        this.store.save();
        const t = pronoun(this.store.state.character.personality.gender);
        this.ui.addLog(`${t}在日记里写了一笔。`);
      })
      .catch((err) => console.warn('[diary] 生成失败', err))
      .finally(() => {
        this.diaryPending = false;
      });
  }

  /**
   * 作息台词。
   *
   * 这是"像个真人"的关键一环：不是等玩家来触发，而是时间到了她自己有反应。
   * 夜里十一点后精力低 → 说要去睡并关灯；早上醒来 → 主动打招呼。
   * 每个节点每天只触发一次，不会复读。
   */
  private tickRoutine(): void {
    const save = this.store.state;
    const hour = save.clock % 24;
    const c = save.character;
    const key = Math.floor(save.clock / 24); // 第几天

    // 夜里该睡了
    if (hour >= 23 && hour < 24 && this.routineDay !== key) {
      this.routineDay = key;
      this.routineNight(c.energyValue);
      return;
    }
    // 早上醒来
    if (hour >= 6 && hour < 7 && this.routineDay !== key) {
      this.routineDay = key;
      this.routineMorning();
      return;
    }

    // 精力见底时主动说累
    if (c.energyValue < 18 && now2() - this.lastRoutineAt > 240_000) {
      this.lastRoutineAt = now2();
      this.say(TIRED_TALK[Math.floor(Math.random() * TIRED_TALK.length)]);
    }
  }

  private routineNight(energy: number): void {
    const lines =
      energy < 45
        ? ['……我睡了。灯我关。', '困得不行了……晚安。']
        : ['还不困，但到点了。我去躺一会儿。', '这么晚了，你不睡吗。'];
    this.say(lines[Math.floor(Math.random() * lines.length)]);
    this.store.update((d) => {
      d.character.activity = 'resting';
      d.room.lampOn = false;
    });
    const t = pronoun(this.store.state.character.personality.gender);
    this.ui.addLog(`${t}关掉台灯，准备休息了。`);
    this.store.addMemory({
      kind: 'event',
      summary: `夜里，${t}主动道了晚安并关灯。`,
      weight: 2,
      tags: ['作息', '晚安'],
    });
  }

  private routineMorning(): void {
    const lines = ['……早。', '早啊，今天起得比你早。', '醒了。你声音听着还没睡醒。'];
    this.say(lines[Math.floor(Math.random() * lines.length)]);
    this.store.update((d) => {
      d.character.activity = 'stretching';
      d.character.energyValue = Math.min(100, d.character.energyValue + 22);
    });
    this.ui.addLog(`新的一天，${pronoun(this.store.state.character.personality.gender)}先醒了。`);
  }

  /**
   * AI 有限视角的"活人感"实现：
   * - 玩家发了新内容（touchMyUpdate 推进 myLastUpdate）
   * - 这次循环里，如果她到时间该刷手机，按 initiative + 心情/好感决定：
   *     - 找玩家 → 等 5~30 分钟后发条微信（耗 1 次 token）
   *     - 不找 → 红点继续
   * - 没到时间，啥都不做
   *
   * 时机选择：玩家发完内容的那一刻就重置她的"下次 check"（5~15 分钟内她会看），
   * 避免她拖一整天都不看。如果她看完了决定不找，那就等下一个游戏小时再 check。
   */
  private tickAIPerspective(save: SaveData, now: number): void {
    const p = save.perspective;
    // 0) 玩家刚发了新内容 → 重置她下次 check 时间到 5~15 分钟（real sec）后
    if (p.myLastUpdate > p.herLastCheck && this._nextCheckRealAt < now) {
      this._nextCheckRealAt = now + 5 + Math.random() * 10; // 5~15 sec 后她会看
    }

    // 1) 她决定主动发消息的时间到了
    if (this._nextProactiveMsgAt > 0 && now >= this._nextProactiveMsgAt) {
      this._nextProactiveMsgAt = 0;
      // 防止同一小时重复
      const clockInt = Math.floor(save.clock);
      if (clockInt === this._lastProactiveClock) return;
      this._lastProactiveClock = clockInt;
      // 触发主动发消息（耗 1 次 token）
      void this.sendProactiveGreeting();
    }

    // 2) 她该刷手机了
    if (this._nextCheckRealAt > 0 && now >= this._nextCheckRealAt) {
      this._nextCheckRealAt = 0;
      // 决定看还是不看：她"在不在家"决定概率更高（在家时刷手机概率高）
      const home = this.herPlaceId === 'home';
      const checkProb = home ? 0.85 : 0.4; // 在家 85% 概率看，出门只 40%
      if (Math.random() < checkProb) {
        this.store.herCheckedPhone();

        // 她刷手机时发现：上一次主动找你，你没回。
        // 这是一次"被冷落"的经历——会让她更想被回应（黏人度↑），也更收着（戒备心↑）。
        if (
          this._pendingProactiveAt > 0 &&
          this.lastPlayerReplyAt < this._pendingProactiveAt &&
          now - this._pendingProactiveAt > 45
        ) {
          this._pendingProactiveAt = 0;
          this.store.update((d) => {
            applyExperience(d, 'chat_ignored');
          });
          this.store.addMemory({
            kind: 'event',
            summary: '她主动找你说话，你没回，她自己坐了一会儿。',
            weight: 2,
            tags: ['被冷落'],
          });
        }

        // 看完决定找不找玩家。
        // 主动性不再读预设里的常量，而是由 traits 推出来的值：
        // 被回应得多、表达欲长上去了的她，会明显更愿意先开口。
        const { initiative } = effectiveStats(this.store.state);
        const affinity = this.store.state.character.affinity;
        const mood = this.store.state.character.moodValue;
        // 越主动 / 好感越高 / 心情越好 → 越倾向找
        const reachProb = Math.min(0.9, initiative * 0.4 + affinity / (AFFINITY_MAX * 2) + (mood - 50) / 200);
        if (p.myLastUpdate > p.herLastCheck) {
          // 玩家有新内容 → 找的概率高
          if (Math.random() < Math.max(0.4, reachProb + 0.2)) {
            // 决定找：5~30 秒后发条微信
            this._nextProactiveMsgAt = now + 5 + Math.random() * 25;
          }
          // 不找就不安排，让玩家那边红点持续
        }
      } else {
        // 决定不看 → 等下一个游戏小时再决定
        this._nextCheckRealAt = now + 30 * 60; // 半小时后再说
      }
    }
  }

  /**
   * 视界重叠的**幕后原因**：女巫一个人偷偷把两个世界的通道打开了。
   *
   * 这就是"关系数值到了就解锁"缺的那一环 —— 光聊天不该能开通不同世界。
   *
   * 她谁也没告诉，所以这里**不点破**：只在「她的手机」里留下一条
   * 玩家翻得到、当时却完全看不懂的痕迹。等她哪天翻到，
   * 那就是这个伏笔兑现的地方 —— 而不是靠一句旁白告诉玩家。
   */
  private secretlyOpenByWitch(): void {
    const w = this.store.npcState(WITCH_ID);
    w.secretlyOpened = true;
    w.knowsContact = true;
    this.store.save();
    // 证据不能写成"此地无银"——玩家一眼就看出被提示了，伏笔就变说明书了。
    // 所以要写得**当时看完全没意义**：一句自言自语的丧气话。
    // 等玩家哪天翻到，把时间点和"突然就能看见了"一对，才会"啊"出来。
    this.store.addChatMsg('her', WITCH_ID, WITCH_ID, '啧，手一抖，差点偏了。');
    this.store.addChatMsg('her', WITCH_ID, 'owner', '……啊？');
    this.store.addChatMsg('her', WITCH_ID, WITCH_ID, '没事没事，睡你的。');
  }

  /**
   * 她主动找你聊天：跟模型要一句问候语，写进微信会话。
   * 不会让玩家产生任何"回合"感，是她从她那边主动发起的。
   */
  private async sendProactiveGreeting(): Promise<void> {
    const cname = this.store.state.character.personality.name;
    try {
      const { requestProactive } = await import('./ai/client');
      const text = await requestProactive(this.store.state);
      this.store.addChatMsg('me', 'her', 'her', text);
      // 记下"她主动开口了"，等她被回应或被冷落
      this._pendingProactiveAt = performance.now();
      // 同时发到我这边手机，让她有"她找我了"的未读感
      this.ui.addLog(`${cname}发来一条消息。`);
    } catch {
      // 离线兜底
      this.store.addChatMsg(
        'me',
        'her',
        'her',
        this.store.state.character.moodValue > 50
          ? '……喂，在干嘛？'
          : '……今天有点累。你呢？',
      );
    }
  }
}

const TIRED_TALK = [
  '……有点撑不住了。',
  '让我歇一会儿。',
  '今天格外累。',
];

function now2(): number {
  return performance.now();
}

function d_name(name: string): string {
  return name || '你';
}
