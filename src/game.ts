import { Animator, type AnimInputs, type ReactionKind } from './anim/animator';
import { Store, clockToPhase, formatClock, dailyActivity, realHours } from './core/store';
import {
  ACTIVITIES,
  GIFTS,
  applyGain,
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
  JOBS,
  buildHerPlan,
  describePlan,
  getPlace,
  herContacts,
  herOutingMessage,
  isJobOpen,
  jobHoursText,
  planAt,
  placeActivityLine,
  type JobDef,
} from './core/world';
import type { DayPhase, PlanBlock, PlayerGender } from './core/types';
import { applyProfile, getProfile, DEFAULT_PROFILE_ID, PROFILES } from './core/profile';
import type { CharacterProfile } from './core/profile';
import { loadConfig, requestDiary, requestMomentComment, requestReply, saveConfig, cloudConfigured, type LlmConfig } from './ai/client';
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
      onPostMoment: (text) => void this.postMoment(text),
      onWriteMyDiary: (text) => this.writeMyDiary(text),
      onSaveMyPlan: (blocks) => this.saveMyPlan(blocks),
      onReadThread: (owner, contactId) => this.store.markThreadRead(owner, contactId),
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

    // 离线期间的时间已结算，提示玩家
    if (drift > 0.5) {
      this.ui.addLog(
        `你离开了约 ${drift.toFixed(1)} 小时，${pronoun(this.store.state.character.personality.gender)}一直在等你。`,
      );
    }
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
          this.ui.addLog('Live2D 模型加载失败，已回退到矢量立绘。');
          this.switchRendererFallback();
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
    this.store.setPlayer(playerName, playerGender);
    this.ui.setPlayerName(this.store.state.playerName);
    this.store.save();
    await this.switchProfile(id);
    // 同一人设时 switchProfile 会早退，这里兜底确保 TA 有属于自己的初遇记忆
    this.store.ensureProfileIntro();
    this.store.save();
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
  private tickPresence(save: import('./core/types').SaveData): void {
    const weekday = new Date().getDay();
    const day = Math.floor(save.clock / 24);

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
      });
      this.herPlanBlocks = blocks;
      this.store.setHerPlan({ day, profileId: this.profile.id, blocks });
      this.ensureChats();
      const t = pronoun(this.profile.gender);
      this.ui.addLog(`${t}今天决定：${describePlan(blocks)}`);
    } else {
      this.herPlanBlocks = save.herPlan.blocks;
    }

    const block = planAt(this.herPlanBlocks, save.clock % 24);
    const place = block?.placeId ?? 'home';
    const line = block && block.kind !== 'rest' ? block.label : '';

    if (place !== this.herPlaceId) {
      this.herPlaceId = place;
      const t = pronoun(this.profile.gender);
      const p = getPlace(place);
      this.setCharacterVisible(place === 'home');
      if (place !== 'home') {
        this.ui.addLog(`${t}出门了，去${p.name}了。`);
        // 她在外会随手拍张照、发条朋友圈——回来你能在手机里翻到。
        // 同一段行程只记一次，避免时间来回调时刷屏。
        const last = this.store.state.moments.filter((m) => m.profileId === this.profile.id).slice(-1)[0];
        const dup = last && last.placeId === place && Math.abs(this.store.state.clock - last.at) < 2;
        if (!dup) {
          this.store.addPhoto({ at: save.clock, placeId: place, caption: line || `在${p.name}`, mood: save.character.mood });
          const moment = this.store.addMoment({
            at: save.clock,
            placeId: place,
            kind: 'outing',
            author: 'her',
            text: line ? `今天${line}。` : `在${p.name}。`,
          });
          // 她的朋友会在下面回一两句，让朋友圈像真有人在用
          const friends = herContacts(this.profile.life, save.playerName).filter((c) => c.id !== 'me');
          const who = friends[Math.floor(Math.random() * friends.length)];
          const say = ['注意身体', '哈哈哈', '下次带上我', '好羡慕', '收到～', '我也想去'][
            Math.floor(Math.random() * 6)
          ];
          if (who) this.store.addMomentComment(moment.id, 'npc', who.name, say);
          // 她顺手给谁发了条消息（她的手机里看得到）
          const out = herOutingMessage(place, this.profile.life, save.character.personality.preset);
          if (out) this.store.addChatMsg('her', out.contactId, 'owner', out.text, true);
        }
      } else {
        this.ui.addLog(`${t}回来了。`);
      }
      this.store.save();
    }

    const p = getPlace(this.herPlaceId);
    this.ui.setPresence({
      away: this.herPlaceId !== 'home',
      placeId: this.herPlaceId,
      placeName: p.name,
      emoji: p.emoji,
      line: this.herPlaceId === 'home' ? '在家' : line || placeActivityLine(this.herPlaceId, this.profile.life),
      working: this.working !== null,
    });
  }

  /** 她不在家时把角色（含配件）藏起来 */
  private setCharacterVisible(v: boolean): void {
    for (const id of ['live2d-canvas', 'acc-layer']) {
      const el = document.getElementById(id);
      if (el) el.style.visibility = v ? '' : 'hidden';
    }
  }

  /** 她是否在家（不在家时只能通过手机联系） */
  get isAway(): boolean {
    return this.herPlaceId !== 'home';
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
  }

  // ── 微信 / 我的手机 ─────────────────────
  /** 铺一点她和其他人的聊天记录，让"她的手机"像真在用 */
  private ensureChats(): void {
    const save = this.store.state;
    const seeds: Record<string, { from: 'owner' | 'other'; text: string }[]> = {
      friend: [
        { from: 'other', text: '你作业写完没' },
        { from: 'owner', text: '还差一点，回去再写' },
        { from: 'other', text: '明天体育课记得带鞋' },
        { from: 'owner', text: '知道啦' },
      ],
      club: [
        { from: 'other', text: '这周活动改到周四了' },
        { from: 'owner', text: '收到' },
      ],
      colleague: [
        { from: 'other', text: '早会资料发你邮箱了' },
        { from: 'owner', text: '好，我等会儿看' },
        { from: 'other', text: '中午食堂见？' },
      ],
      boss: [
        { from: 'other', text: '周报今天记得交' },
        { from: 'owner', text: '好的组长' },
      ],
      mom: [
        { from: 'other', text: '记得吃饭' },
        { from: 'owner', text: '吃过啦' },
      ],
    };
    for (const c of herContacts(this.profile.life, save.playerName)) {
      if (c.id === 'me') continue;
      const has = this.store.state.threads.some(
        (t) => t.owner === 'her' && t.contactId === c.id && t.profileId === this.profile.id,
      );
      if (has) continue;
      const lines = seeds[c.id] ?? [{ from: 'other' as const, text: '在吗' }];
      for (const s of lines) {
        this.store.addChatMsg('her', c.id, s.from === 'owner' ? 'owner' : c.id, s.text);
      }
    }
  }

  /** 我发一条朋友圈 → 她来评论 */
  private async postMoment(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    const m = this.store.addMoment({ at: this.store.state.clock, kind: 'mine', author: 'me', text: clean });
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

  private writeMyDiary(text: string): void {
    this.store.addMyDiary(text);
    this.ui.addLog('你写了今天的日记。');
  }

  private saveMyPlan(blocks: import('./core/types').PlanBlock[]): void {
    this.store.setMyPlan(blocks);
    this.ui.addLog('日程已保存。');
  }

  /** Live2D 加载失败时退回矢量渲染器 */  private switchRendererFallback(): void {
    const vectorProfile = getProfile(DEFAULT_PROFILE_ID);
    this.boy.dispose();
    this.boy = this.createRenderer(vectorProfile);
    this.boy.mount(this.canvasFor(vectorProfile));
    this.boy.resize(window.innerWidth, window.innerHeight);
    this.profile = vectorProfile;
    this.store.update((d) => applyProfile(vectorProfile, d));
    this.ui.setProfileId(vectorProfile.id);
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

    const home = this.herPlaceId === 'home';
    // 无操作时的主动搭话（只有她在旁边时才会当面开口）
    if (home) this.maybeGossip(now);
    // 作息台词：到点自己说要去睡 / 早上打招呼
    if (home) this.tickRoutine();
    // 偶尔主动看一眼时间，顺口说一句（作息不僵硬的关键）
    if (home) this.tickTimeGlance(now);
    // 傍晚/夜里她可能随手写一笔日记
    this.tickDiary(now);

    // UI 数值
    this.ui.tick(save);

    // 定期存档
    if (now % 1 < dt) this.store.save();

    requestAnimationFrame(this.loop);
  };

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
    voice.speak(line, this.store.state.character.personality.preset);
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
    const result = resolveTouch(part, this.store.state);
    this.store.update((d) => {
      applyGain(d, result.affinityDelta, result.moodDelta);
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
    const gift = GIFTS.find((g) => g.id === id);
    if (!gift) return;
    const result = resolveGift(gift, this.store.state);
    this.store.update((d) => {
      applyGain(d, result.affinityDelta, result.moodDelta);
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
    const def = ACTIVITIES.find((a) => a.id === id);
    if (!def) return;
    const result = resolveActivity(def, this.store.state);
    this.store.update((d) => {
      applyGain(d, result.affinityDelta, result.moodDelta);
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

  // ── 大模型对话 ───────────────────────────
  private async sendToModel(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean || this.pendingReply) return;
    this.pendingReply = true;
    this.ui.setThinking(true);
    this.ui.pushTurn({ role: 'user', text: clean, iso: new Date().toISOString() });
    // 我和她的对话同时写进微信记录（我的手机里能翻到、也会持久化）
    this.store.addChatMsg('me', 'her', 'owner', clean);

    // 用户消息也进记忆（低权重），模型能看到自己刚说过什么
    this.store.addMemory({ kind: 'dialogue', summary: `你说：${clean}`, weight: 2, tags: ['对话'] });
    // 陪她聊天能攒一点金币（商城用）
    this.store.addCoins(1);

    const turns = this.ui.getTurns();
    void turns;

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
      const mood = resolveMood(
        intent.emotion,
        intent.intensity,
        save.character.affinity,
        save.character.personality.shyThreshold,
      );

      this.store.update((d) => {
        d.character.mood = mood;
        d.character.activity = action;
        // 对话本身也有轻微亲密度收益，跟内容质量无关，只跟"你愿意说话"有关
        d.character.affinity = Math.min(100, d.character.affinity + 0.15);
      });
      this.activityLockUntil = performance.now() + 6000;

      // 重要对话 / 情绪强烈的对话 → 记下写日记的契机
      if (intent.memorable === 1) {
        this.markDiarySignal(2, `关于「${clean.slice(0, 12)}」的那次聊天`);
      } else if (intent.intensity >= 0.7) {
        this.markDiarySignal(1, `和你聊「${clean.slice(0, 10)}」聊得起劲`);
      }

      this.say(intent.line, false, intent);

      if (intent.memorable === 1) {
        this.store.addMemory({
          kind: 'dialogue',
          summary: `关于「${clean.slice(0, 12)}」，${intent.line.slice(0, 24)}`,
          weight: 4,
          tags: ['重要对话', mood],
        });
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