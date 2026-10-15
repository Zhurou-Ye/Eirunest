import { ACTIVITIES, GIFTS } from '../core/interaction';
import { diaryFor, formatClock, memoriesFor, momentsFor, photosFor, threadFor } from '../core/store';
import { pronoun } from '../core/gender';
import type { TouchKind } from '../core/interaction';
import { PROFILES } from '../core/profile';
import { ACCESSORIES, SLOT_LABEL } from '../core/shop';
import { describeTraits, evolutionLine } from '../core/evolution';
import { AFFINITY_MAX, PHYSICAL_COST, STORY } from '../core/story';
import {
  ALBUM_IMG,
  JOBS,
  PLACES,
  describePlan,
  getPlace,
  herContacts,
  hm,
  isJobOpen,
  jobHoursText,
  myContacts,
} from '../core/world';
import type {
  ChatMsg,
  Contact,
  DialogueTurn,
  PlanBlock,
  PlayerGender,
  SaveData,
  WxStatus,
} from '../core/types';
import type { LlmConfig } from '../ai/client';

/**
 * HUD 层。只负责显示和收集点击，不做任何游戏逻辑。
 *
 * 布局原则（参考《妹居物语》）：画面主体留给场景和角色，
 * 功能入口全部收在右侧竖排，对话/状态/交互/送礼各是一个独立浮层。
 * 底部只留一条极简输入栏。
 */

export interface UICallbacks {
  onSend(text: string): void;
  onTouch(part: TouchKind): void;
  onGift(id: string): void;
  onActivity(id: string): void;
  onToggleLamp(): void;
  onToggleCurtain(): void;
  onToggleTidy(): void;
  /** 设定到某个时刻（"HH:MM"） */
  onSetTime(hhmm: string): void;
  /** 同步回真实当前时间 */
  onSyncTime(): void;
  onConfigChange(cfg: LlmConfig): void;
  onRename(name: string): void;
  onSwitchProfile(id: string): void;
  /** 开局：选定人设 + 主控名字/性别 */
  onStartGame(profileId: string, playerName: string, playerGender: PlayerGender): void;
  /** 买配件 */
  onBuyAccessory(id: string): void;
  /** 戴上/取下配件 */
  onEquipAccessory(id: string): void;
  /** 开始打工 */
  onStartJob(jobId: string): void;
  /** 给朋友圈点/取消赞 */
  onLikeMoment(id: string): void;
  /** 我发一条朋友圈 */
  onPostMoment(text: string): void;
  /** 我写一句日记 */
  onWriteMyDiary(text: string): void;
  /** 保存我的日程 */
  onSaveMyPlan(blocks: PlanBlock[]): void;
  /** 打开某个会话（用于清未读） */
  onReadThread(owner: 'her' | 'me', contactId: string): void;
  /** 把认识的人加进通讯录；remark 为玩家设的备注名 */
  onAddContact(id: string, remark?: string): void;
  /** 换头像（两部手机同步） */
  onSetAvatar(owner: 'her' | 'me', emoji: string): void;
  /** 发/结束微信状态 */
  onSetStatus(owner: 'her' | 'me', s: WxStatus | null): void;
  /** 购买实体（800 金币 + 阶段 2） */
  onBuyPhysical(): boolean;
  /** 相机：在当前地点拍一张，存进相册 */
  onShoot(placeId: string): void;
}

export type PanelName =
  | 'chat'
  | 'status'
  | 'touch'
  | 'gift'
  | 'memory'
  | 'shop'
  | 'map'
  | 'phone'
  | 'myphone';

export interface PresenceInfo {
  away: boolean;
  placeId: string;
  placeName: string;
  emoji: string;
  line: string;
  working: boolean;
}

export interface UI {
  setBubble(text: string): void;
  setBubbleHint(text: string): void;
  setThinking(v: boolean): void;
  setModelStatus(text: string, offline: boolean): void;
  setLatency(ms: number, usedModel: boolean): void;
  setPlayerName(name: string): void;
  setConfig(cfg: LlmConfig): void;
  pushTurn(t: DialogueTurn): void;
  getTurns(): DialogueTurn[];
  addLog(text: string, important?: boolean): void;
  tick(save: SaveData): void;
  greet(save: SaveData): void;
  setLive2DStatus(s: { loading: boolean; ready: boolean; error?: string }): void;
  setProfileSwitching(v: boolean, name?: string): void;
  setProfileId(id: string): void;
  /** 打开某个面板，同时关掉其他面板 */
  openPanel(name: PanelName | null): void;
  openNewGameContacts(): void;
  openChatWithHer(): void;
  get openPanelName(): PanelName | null;
  /** 她在哪 / 是否出门 */
  setPresence(p: PresenceInfo): void;
  /** 主线剧情解锁的独白弹窗（日系台词，N 秒后自动消失） */
  showStoryMonologue(text: string, title?: string): void;
  showAddressDialog(): Promise<boolean>;
  showStoryChoice(title: string, options: string[]): Promise<number>;
}

const MOOD_LABEL: Record<string, string> = {
  happy: '开心',
  calm: '平静',
  shy: '害羞',
  sleepy: '困倦',
  sulky: '闹别扭',
  excited: '兴奋',
};

const ENERGY_LABEL: Record<string, string> = {
  fresh: '精神',
  okay: '还好',
  tired: '累了',
  exhausted: '疲惫',
};

const PHASE_LABEL: Record<string, string> = {
  morning: '清晨',
  noon: '白天',
  evening: '傍晚',
  night: '夜里',
};

const WEATHER_LABEL: Record<string, string> = {
  sunny: '晴',
  cloudy: '多云',
  rain: '下雨',
  snow: '下雪',
};

const ACTIVITY_LABEL: Record<string, string> = {
  idle: '发呆',
  reading: '看书',
  resting: '休息',
  playing_game: '打游戏',
  stretching: '伸展',
  cooking: '做饭',
  sleeping: '睡着了',
  talking: '说话',
};

const TOUCH_ITEMS: { kind: TouchKind; label: string; hint: string }[] = [
  { kind: 'head', label: '摸头', hint: 'TA 会低头蹭你的手' },
  { kind: 'face', label: '戳脸', hint: '软软的，会愣住' },
  { kind: 'hand', label: '牵手', hint: '手心有点凉' },
  { kind: 'torso', label: '靠一会儿', hint: '安静地待着' },
];

export function mountUI(root: HTMLElement, cb: UICallbacks): UI {
  root.innerHTML = `
    <div class="stage">
      <canvas class="layer room" id="room-canvas"></canvas>
      <canvas class="layer boy" id="boy-canvas" hidden></canvas>
      <canvas class="layer live2d" id="live2d-canvas"></canvas>
      <div class="layer acc" id="acc-layer"></div>

      <div class="away-note" id="away-note" hidden>
        <span class="away-emoji" id="away-emoji">🏫</span>
        <span class="away-title" id="away-title">出门了</span>
        <span class="away-sub" id="away-sub">—</span>
        <button class="away-phone" id="away-phone">发消息</button>
      </div>

      <div class="hud">
        <header class="topbar">
          <div class="who">
            <span class="name" id="ui-name">—</span>
            <span class="sub"><span id="ui-clock">--:--</span><i></i><span id="ui-phase">—</span><i></i><span id="ui-mood">—</span></span>
          </div>
          <div class="chips">
            <span class="chip-mini coin" id="chip-coins">金币 0</span>
            <span class="chip-mini" id="chip-aff">关系 0</span>
            <span class="chip-mini" id="chip-energy">精力 0</span>
          </div>
        </header>

        <div class="bubble-wrap" id="bubble-wrap">
          <div class="bubble" id="ui-bubble"></div>
          <div class="think" id="ui-think" hidden><span></span><span></span><span></span></div>
        </div>

        <div class="log" id="ui-log"></div>

        <button class="menu-toggle" id="btn-menu" aria-label="菜单">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>

        <nav class="drawer" id="drawer" hidden>
          <div class="drawer-head">和小屋有关的</div>
          <button class="drawer-item" data-panel="chat">
            <svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
            <span>对话</span>
          </button>
          <button class="drawer-item" data-panel="status">
            <svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
            <span>状态</span>
          </button>
          <button class="drawer-item" data-panel="memory">
            <svg viewBox="0 0 24 24"><path d="M7 4h9a2 2 0 0 1 2 2v13a1 1 0 0 1-1.6.8L12 17l-4.4 2.8A1 1 0 0 1 6 19V6a2 2 0 0 1 1-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
            <span>记忆</span>
          </button>
          <button class="drawer-item" data-panel="touch">
            <svg viewBox="0 0 24 24"><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0 0V4.5a1.5 1.5 0 0 1 3 0V11m0 0V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-3a1.5 1.5 0 0 1 3 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>互动</span>
          </button>
          <button class="drawer-item" data-panel="gift">
            <svg viewBox="0 0 24 24"><rect x="3.5" y="8.5" width="17" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 12.5h14V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 8.5v13M12 8.5S10 4 7.5 5.5C5.6 6.6 7 8.5 9 8.5zM12 8.5s2-4.5 4.5-3c1.9 1.1.5 3-1.5 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
            <span>送礼</span>
          </button>
          <button class="drawer-item" data-panel="shop">
            <svg viewBox="0 0 24 24"><path d="M4.5 8h15l-1 12H5.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.5 8a3.5 3.5 0 0 1 7 0" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
            <span>商城</span>
          </button>
          <button class="drawer-item" data-panel="map">
            <svg viewBox="0 0 24 24"><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 4v14M15 6v14" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
            <span>地图</span>
          </button>
          <button class="drawer-item" data-panel="phone">
            <svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 18h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            <span id="drawer-phone-label">她的手机</span>
          </button>
          <button class="drawer-item" data-panel="myphone">
            <svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9.5 7h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10.5 18h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            <span>我的手机</span>
          </button>
        </nav>
        <div class="drawer-mask" id="drawer-mask" hidden></div>

        <div class="panel" data-panel="chat" hidden>
          <div class="panel-card">
            <div class="panel-head"><h3>对话</h3><button class="x" data-close aria-label="关闭">×</button></div>
            <div class="thread" id="ui-thread"></div>
            <div class="panel-foot">
              <input id="ui-input" type="text" placeholder="跟 TA 说点什么…" autocomplete="off" enterkeyhint="send" />
              <button class="send" id="btn-send">说</button>
            </div>
          </div>
        </div>

        <div class="panel" data-panel="status" hidden>
          <div class="panel-card">
            <div class="panel-head"><h3 id="status-title">TA 的状态</h3><button class="x" data-close aria-label="关闭">×</button></div>
            <div class="meters">
              <div class="meter"><span class="k">心情</span><div class="bar"><i id="ui-mood-bar"></i></div><span class="v" id="ui-mood-v">0</span></div>
              <div class="meter"><span class="k">精力</span><div class="bar alt"><i id="ui-energy-bar"></i></div><span class="v" id="ui-energy-v">—</span></div>
              <div class="meter"><span class="k">关系进展</span><div class="bar warm"><i id="ui-aff-bar"></i></div><span class="v" id="ui-aff-v">0</span></div>
            </div>
            <div class="rows">
              <div class="row"><span>正在做</span><b id="ui-activity">—</b></div>
              <div class="row"><span>房间</span><b id="ui-tidy">—</b></div>
              <div class="row"><span>天气</span><b id="ui-weather">—</b></div>
            </div>
            <div class="env" id="story-progress"></div>
            <div class="env" id="trait-panel"></div>
            <div class="env">
              <span class="env-label">房间</span>
              <div class="env-btns">
                <button class="chip" id="btn-lamp">台灯</button>
                <button class="chip" id="btn-curtain">窗帘</button>
                <button class="chip" id="btn-tidy">整理</button>
              </div>
            </div>
            <div class="env">
              <span class="env-label">时间</span>
              <div class="time-ctl">
                <input type="time" id="cfg-time" step="60" />
                <button class="chip" id="btn-set-time">设定</button>
                <button class="chip" id="btn-sync-time">同步现在</button>
              </div>
            </div>
          </div>
        </div>

        <div class="panel" data-panel="touch" hidden>
          <div class="panel-card">
            <div class="panel-head"><h3>交互</h3><button class="x" data-close aria-label="关闭">×</button></div>
            <p class="tip">也可以直接点 TA 身上——头顶、脸、手、肚子反应都不一样。</p>
            <div class="touch-grid">
              ${TOUCH_ITEMS.map(
                (t) => `
                <button class="touch-card" data-touch="${t.kind}">
                  <span class="tl">${t.label}</span>
                  <span class="th">${t.hint}</span>
                </button>`,
              ).join('')}
            </div>
            <span class="env-label">一起做</span>
            <div class="act-grid">
              ${ACTIVITIES.map(
                (a) => `<button class="chip" data-act="${a.id}">${a.icon} ${a.label}</button>`,
              ).join('')}
            </div>
          </div>
        </div>

        <div class="panel" data-panel="gift" hidden>
          <div class="panel-card">
            <div class="panel-head"><h3>送礼</h3><button class="x" data-close aria-label="关闭">×</button></div>
            <p class="tip">送对了 TA 会记很久。</p>
            <div class="gift-grid">
              ${GIFTS.map(
                (g) => `
                <button class="gift-card" data-gift="${g.id}">
                  <span class="gi">${g.icon}</span>
                  <span class="gl">${g.label}</span>
                </button>`,
              ).join('')}
            </div>
          </div>
        </div>

        <div class="panel" data-panel="memory" hidden>
          <div class="panel-card">
            <div class="panel-head"><h3 id="memory-title">TA 记得的事</h3><button class="x" data-close aria-label="关闭">×</button></div>
            <p class="tip">越重要的事，记得越牢。这里只放 TA 自己的记忆，不掺别人。</p>
            <ul id="ui-memories" class="mem-list"></ul>
          </div>
        </div>

        <div class="panel" data-panel="shop" hidden>
          <div class="panel-card">
            <div class="panel-head"><h3>商城</h3><button class="x" data-close aria-label="关闭">×</button></div>
            <p class="tip">用金币给 TA 买点小东西。买下后点一下就能戴上或取下。</p>
            <div class="shop-grid" id="shop-grid"></div>
          </div>
        </div>

        <div class="panel" data-panel="map" hidden>
          <div class="panel-card">
            <div class="panel-head"><h3>大地图</h3><button class="x" data-close aria-label="关闭">×</button></div>
            <p class="tip" id="map-status">—</p>
            <canvas id="map-canvas" class="map-canvas"></canvas>
            <span class="env-label">地点</span>
            <ul class="place-list" id="place-list"></ul>
            <span class="env-label">打工赚钱</span>
            <div class="job-list" id="job-list"></div>
          </div>
        </div>

        <div class="panel" data-panel="phone" hidden></div>
        <div class="panel" data-panel="myphone" hidden></div>

        <div class="panel" id="settings" hidden>
          <div class="panel-card">
            <div class="panel-head"><h3>设置</h3><button class="x" data-close aria-label="关闭">×</button></div>
            <p class="hint" id="cfg-channel">对话默认由<strong>云端大模型</strong>（免密钥）驱动。</p>
            <label>（可选）自带大模型接口
              <input id="cfg-base" placeholder="留空即用云端，不必填" />
            </label>
            <label>API Key<input id="cfg-key" type="password" placeholder="不填就不用" /></label>
            <label>模型名<input id="cfg-model" placeholder="gpt-4o-mini" /></label>
            <label>你的名字<input id="cfg-player" placeholder="TA 该怎么称呼你" /></label>
            <div class="panel-actions">
              <span class="status" id="cfg-status"></span>
              <button class="primary" id="btn-save-cfg">保存</button>
            </div>
            <p class="hint">存档（记忆、关系进展、房间、时间）存在本机浏览器；只有对话内容会发给云端模型生成回复。</p>
            <button class="ghost wide" id="btn-switch-role">换一个人陪</button>
          </div>
        </div>

        <button class="gear" id="btn-settings" aria-label="设置">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </div>

      <div class="boot" id="boot">
        <div class="boot-card">
          <p class="boot-kicker">治愈日常</p>
          <h1 class="boot-title">小 屋</h1>
          <p class="boot-sub">先说说你自己</p>
          <div class="player-setup">
            <div class="gender-toggle" id="gender-toggle">
              <button type="button" class="gbtn on" data-gender="female">女生</button>
              <button type="button" class="gbtn" data-gender="male">男生</button>
            </div>
            <input id="player-name" type="text" placeholder="你的名字" maxlength="12" autocomplete="off" />
          </div>
          <p class="boot-sub">再选一个人，开始你们的日常</p>
          <div class="roles" id="role-list"></div>
          <div class="boot-actions">
            <button class="primary wide" id="btn-new" disabled>开始新日常</button>
            <button class="ghost wide" id="btn-continue" hidden>继续上次的日常</button>
          </div>
          <p class="boot-hint" id="boot-hint"></p>
        </div>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement>(id: string): T => root.querySelector(`#${id}`) as T;
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;

  const bubble = $<HTMLDivElement>('ui-bubble');
  const think = $<HTMLDivElement>('ui-think');
  const logBox = $<HTMLDivElement>('ui-log');
  const input = $<HTMLInputElement>('ui-input');
  const thread = $<HTMLDivElement>('ui-thread');
  const boot = $<HTMLDivElement>('boot');
  const awayNote = $<HTMLDivElement>('away-note');
  const turns: DialogueTurn[] = [];

  let hintTimer: number | null = null;
  let lastClockText = '';
  let open: PanelName | null = null;
  let lastSave: SaveData | null = null;
  let lastShopKey = '';
  let lastStoryKey = '';
  let lastTraitKey = '';
  let lastCoins = -1;
  let lastGender = '';

  /**
   * 当前角色的第三人称。
   * 面向玩家的文案一律走这里 —— Natori 是男性立绘，写死"她"就会把他显示成她。
   */
  function tp(save?: SaveData | null): '他' | '她' {
    const g = (save ?? lastSave)?.character.personality.gender ?? 'female';
    return pronoun(g);
  }
  let lastPresence: PresenceInfo | null = null;
  let lastPresenceKey = '';
  /** 时间输入框被用户改过：改过就不要再被时钟回写覆盖，直到点"设定/同步" */
  let timeDirty = false;
  /** "她的手机"是否已锁（阶段 0 打不开），只在变化时改 DOM */
  let herPhoneLocked: boolean | null = null;

  // ── 选人界面 ────────────────────────────
  const roleList = $<HTMLDivElement>('role-list');
  roleList.innerHTML = PROFILES.map(
    (p) => `
    <button class="role-card" data-role="${p.id}">
      <span class="role-name">${p.name}</span>
      <span class="role-tag">${p.tagline}</span>
      <span class="role-tags">${p.tags.map((t) => `<i>${t}</i>`).join('')}</span>
    </button>`,
  ).join('');

  const hasSave = (() => {
    try {
      const raw = localStorage.getItem('hearth-boy.save.v1');
      if (!raw) return false;
      const d = JSON.parse(raw) as { profileId?: string };
      return Boolean(d && d.profileId);
    } catch {
      return false;
    }
  })();
  if (hasSave) $<HTMLButtonElement>('btn-continue').hidden = false;

  /** 选人界面的事件绑定。首次和「换一个人陪」复用同一套逻辑。 */
  function bindBoot(el: HTMLElement): void {
    const list = el.querySelector('#role-list') as HTMLElement | null;
    const newBtn = el.querySelector('#btn-new') as HTMLButtonElement | null;
    const contBtn = el.querySelector('#btn-continue') as HTMLButtonElement | null;
    if (!list || !newBtn) return;

    // 主控性别切换
    let gender: PlayerGender = 'female';
    const toggle = el.querySelector('#gender-toggle') as HTMLElement | null;
    toggle?.querySelectorAll<HTMLElement>('[data-gender]').forEach((b) => {
      b.addEventListener('click', () => {
        gender = (b.dataset.gender as PlayerGender) ?? 'female';
        toggle
          .querySelectorAll<HTMLElement>('[data-gender]')
          .forEach((x) => x.classList.toggle('on', x === b));
      });
    });
    const nameInput = el.querySelector('#player-name') as HTMLInputElement | null;

    let picked = '';
    list.querySelectorAll<HTMLElement>('[data-role]').forEach((b) => {
      b.addEventListener('click', () => {
        picked = b.dataset.role as string;
        list.querySelectorAll<HTMLElement>('[data-role]').forEach((x) => x.classList.toggle('on', x === b));
        newBtn.disabled = false;
      });
    });

    newBtn.addEventListener('click', () => {
      if (!picked) return;
      el.classList.add('out');
      cb.onStartGame(picked, (nameInput?.value ?? '').trim(), gender);
      window.setTimeout(() => el.remove(), 420);
    });

    contBtn?.addEventListener('click', () => {
      el.classList.add('out');
      window.setTimeout(() => el.remove(), 420);
    });
  }

  bindBoot(boot);

  // ── 抽屉导航 ────────────────────────────
  const drawer = $<HTMLElement>('drawer');
  const drawerMask = $<HTMLElement>('drawer-mask');
  const setDrawer = (v: boolean): void => {
    drawer.hidden = !v;
    drawerMask.hidden = !v;
    $('btn-menu').classList.toggle('open', v);
  };
  $('btn-menu').addEventListener('click', () => setDrawer(drawer.hidden));
  drawerMask.addEventListener('click', () => setDrawer(false));
  root.querySelectorAll<HTMLElement>('.drawer-item').forEach((el) => {
    el.addEventListener('click', () => {
      setDrawer(false);
      ui.openPanel(el.dataset.panel as PanelName);
    });
  });

  root.querySelectorAll<HTMLElement>('.panel[data-panel]').forEach((p) => {
    p.querySelectorAll<HTMLElement>('[data-close]').forEach((b) =>
      b.addEventListener('click', () => ui.openPanel(null)),
    );
  });

  // ── 交互绑定 ────────────────────────────
  root.querySelectorAll<HTMLElement>('[data-touch]').forEach((el) => {
    el.addEventListener('click', () => {
      cb.onTouch(el.dataset.touch as TouchKind);
      ui.openPanel(null);
    });
  });
  root.querySelectorAll<HTMLElement>('[data-gift]').forEach((el) => {
    el.addEventListener('click', () => {
      cb.onGift(el.dataset.gift as string);
      ui.openPanel(null);
    });
  });
  root.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
    el.addEventListener('click', () => {
      cb.onActivity(el.dataset.act as string);
      ui.openPanel(null);
    });
  });

  $('btn-lamp').addEventListener('click', cb.onToggleLamp);
  $('btn-curtain').addEventListener('click', cb.onToggleCurtain);
  $('btn-tidy').addEventListener('click', cb.onToggleTidy);
  const timeInputEl = $<HTMLInputElement>('cfg-time');
  // 用户一动这个框就标记为"脏"：时钟每帧回写会让刚选好的时间被打回原样，
  // 所以脏了就不再自动回写，直到点了「设定」或「同步现在」。
  const markTimeDirty = (): void => {
    timeDirty = true;
  };
  timeInputEl.addEventListener('input', markTimeDirty);
  timeInputEl.addEventListener('change', markTimeDirty);
  $('btn-set-time').addEventListener('click', () => {
    const v = timeInputEl.value;
    if (!v) return;
    cb.onSetTime(v);
    timeDirty = false;
  });
  $('btn-sync-time').addEventListener('click', () => {
    cb.onSyncTime();
    timeDirty = false;
  });

  const send = () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    cb.onSend(v);
  };
  $('btn-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });

  // 出门时「发消息」→ 打开我自己的手机，直接进和她的聊天
  $('away-phone').addEventListener('click', () => {
    ui.openPanel('myphone');
    phones.me.openChat('her');
  });

  $('btn-settings').addEventListener('click', () => {
    q('#settings').hidden = !q('#settings').hidden;
  });
  q('#settings').querySelector('[data-close]')?.addEventListener('click', () => {
    q('#settings').hidden = true;
  });

  $('btn-switch-role').addEventListener('click', () => {
    q('#settings').hidden = true;
    // 重新拉起选人界面
    const again = document.createElement('div');
    again.className = 'boot';
    again.id = 'boot';
    again.innerHTML = boot.innerHTML;
    (boot.parentElement ?? root).appendChild(again);
    bindBoot(again);
  });

  $('btn-save-cfg').addEventListener('click', () => {
    const cfg: LlmConfig = {
      baseUrl: $<HTMLInputElement>('cfg-base').value.trim(),
      apiKey: $<HTMLInputElement>('cfg-key').value.trim(),
      model: $<HTMLInputElement>('cfg-model').value.trim(),
      temperature: 0.9,
      maxTokens: 200,
    };
    cb.onConfigChange(cfg);
    cb.onRename($<HTMLInputElement>('cfg-player').value.trim());
    $<HTMLDivElement>('cfg-status').textContent = '已保存';
    window.setTimeout(() => {
      q('#settings').hidden = true;
    }, 900);
  });

  /**
   * 全屏看大图 —— 「点开聊天里的图片」用的查看器。
   * 图本身作为一条消息留在会话里，这里只负责放大看；关掉后聊天记录不动。
   */
  function openImageViewer(src: string, title = '图片'): void {
    document.querySelector('.img-viewer')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'story-mono img-viewer';
    wrap.innerHTML = `<div class="story-mono-card story-map-card">
        <div class="story-mono-title">${escapeHtml(title)}</div>
        <img class="story-map-img" src="${escapeHtml(src)}" alt="" />
        <button class="story-mono-ok">收起图片</button>
      </div>`;
    document.body.appendChild(wrap);
    const close = (): void => wrap.remove();
    wrap.querySelector('button')!.addEventListener('click', close);
    // 点背景也能关，符合看图的直觉
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close();
    });
  }

  // ── 实现接口 ────────────────────────────
  const ui: UI = {
    get openPanelName() {
      return open;
    },

    openPanel(name: PanelName | null) {
      // 阶段 0 你还看不见她的世界，也就打不开"她的手机"——只有自己这部
      if (name === 'phone' && (lastSave?.story?.phase ?? 0) < 1) {
        this.setBubbleHint(`还看不见${tp()}的手机……`);
        return;
      }
      open = name;
      root.querySelectorAll<HTMLElement>('.panel[data-panel]').forEach((p) => {
        p.hidden = p.dataset.panel !== name;
      });
      root.querySelectorAll<HTMLElement>('.drawer-item').forEach((b) => {
        b.classList.toggle('on', b.dataset.panel === name);
      });
      if (name === 'chat') input.focus();
      if (name === 'memory' && lastSave) renderMemories(lastSave);
      if (name === 'status' && lastSave) {
        renderStoryProgress(lastSave);
        renderTraits(lastSave);
      }
      if (name === 'shop' && lastSave) {
        lastShopKey = '';
        renderShop(lastSave);
      }
      if (name === 'map' && lastSave) renderMap(lastSave);
      if (name === 'phone') phones.her.onShow();
      if (name === 'myphone') phones.me.onShow();
    },

    openNewGameContacts() {
      this.openPanel('myphone');
      phones.me.openContacts();
    },

    openChatWithHer() {
      this.openPanel('myphone');
      phones.me.openChat('her');
    },

    setBubble(text: string) {
      bubble.textContent = text;
      bubble.classList.toggle('on', text.length > 0);
      bubble.style.maxWidth = text.length > 40 ? 'min(72vw, 380px)' : 'min(56vw, 300px)';
    },

    setBubbleHint(text: string) {
      this.setBubble(text);
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => this.setBubble(''), 3600);
    },

    setThinking(v: boolean) {
      think.hidden = !v;
    },

    setModelStatus(text: string, offline: boolean) {
      $<HTMLSpanElement>('cfg-status').textContent = text;
      void offline;
    },

    setLatency(ms: number, usedModel: boolean) {
      $<HTMLDivElement>('cfg-status').textContent = `${usedModel ? '模型' : '离线'} ${Math.round(ms)}ms`;
    },

    setPlayerName(name: string) {
      $<HTMLInputElement>('cfg-player').value = name;
    },

    setConfig(cfg: LlmConfig) {
      $<HTMLInputElement>('cfg-base').value = cfg.baseUrl;
      $<HTMLInputElement>('cfg-key').value = cfg.apiKey;
      $<HTMLInputElement>('cfg-model').value = cfg.model;
    },

    pushTurn(t: DialogueTurn) {
      turns.push(t);
      if (turns.length > 60) turns.shift();

      const el = document.createElement('div');
      el.className = t.role === 'user' ? 'msg me' : 'msg her';
      el.textContent = t.text;
      thread.appendChild(el);
      while (thread.children.length > 40) thread.firstElementChild?.remove();
      thread.scrollTop = thread.scrollHeight;

      // 她不在家 = 是在给你发消息；这时你没看着那段对话就记未读
      if (t.role === 'boy' && lastPresence?.away) phones.me.notifyHerMsg();
    },

    getTurns: () => turns,

    addLog(text: string, important = false) {
      const el = document.createElement('div');
      el.className = important ? 'log-item key' : 'log-item';
      el.textContent = text;
      logBox.prepend(el);
      while (logBox.children.length > 4) logBox.lastElementChild?.remove();
      window.setTimeout(() => {
        el.classList.add('fade');
        window.setTimeout(() => el.remove(), 900);
      }, 7000);
    },

    showStoryMonologue(text: string, title = '……') {
      // 移除旧的
      const old = document.querySelector('.story-mono');
      if (old) old.remove();
      const wrap = document.createElement('div');
      wrap.className = 'story-mono';
      wrap.innerHTML = `<div class="story-mono-card">
          <div class="story-mono-title">${escapeHtml(title)}</div>
          <div class="story-mono-text">${escapeHtml(text)}</div>
          <button class="story-mono-ok">继续</button>
        </div>`;
      document.body.appendChild(wrap);
      const close = () => {
        wrap.classList.add('out');
        window.setTimeout(() => wrap.remove(), 600);
      };
      wrap.querySelector('.story-mono-ok')!.addEventListener('click', close);
      window.setTimeout(close, 9000);
    },

    showAddressDialog() {
      return new Promise<boolean>((resolve) => {
        const wrap = document.createElement('div');
        wrap.className = 'story-mono';
        wrap.innerHTML = `<div class="story-mono-card story-choice-card">
          <div class="story-mono-title">收货地址</div>
          <div class="story-mono-text">填写一个虚构地址继续剧情。地址只用于本次剧情，不会保存。</div>
          <input class="story-address-input" maxlength="80" placeholder="例如：星芒市月桂路 12 号" />
          <button class="story-mono-ok">发送地址</button>
        </div>`;
        document.body.appendChild(wrap);
        const input = wrap.querySelector<HTMLInputElement>('.story-address-input')!;
        input.focus();
        wrap.querySelector('button')!.addEventListener('click', () => {
          const hasValue = input.value.trim().length > 0;
          if (!hasValue) { input.focus(); return; }
          input.value = '';
          wrap.remove();
          resolve(true);
        });
      });
    },

    showStoryChoice(title, options) {
      return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.className = 'story-mono';
        wrap.innerHTML = `<div class="story-mono-card story-choice-card">
          <div class="story-mono-title">${escapeHtml(title)}</div>
          <div class="story-choice-options">${options.map((option, index) => `<button data-choice="${index}">${escapeHtml(option)}</button>`).join('')}</div>
        </div>`;
        document.body.appendChild(wrap);
        wrap.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((button) => {
          button.addEventListener('click', () => {
            const selected = Number(button.dataset.choice);
            wrap.remove();
            resolve(selected);
          });
        });
      });
    },

    tick(save: SaveData) {
      lastSave = save;
      const c = save.character;
      $<HTMLSpanElement>('ui-name').textContent = c.personality.name;
      // 面板标题随性别走（他/她）
      if (c.personality.gender !== lastGender) {
        lastGender = c.personality.gender;
        const t = pronoun(c.personality.gender);
        $<HTMLElement>('status-title').textContent = `${t}的状态`;
        $<HTMLElement>('memory-title').textContent = `${t}记得的事`;
        // 抽屉里的入口标签也要跟着走，否则男性角色会显示"她的手机"
        const phoneLabel = document.getElementById('drawer-phone-label');
        if (phoneLabel) phoneLabel.textContent = `${t}的手机`;
      }
      const clockText = formatClock(save.clock);
      if (clockText !== lastClockText) {
        lastClockText = clockText;
        $<HTMLSpanElement>('ui-clock').textContent = clockText;
      }
      $<HTMLSpanElement>('ui-phase').textContent = PHASE_LABEL[c.phase] ?? c.phase;
      $<HTMLSpanElement>('ui-mood').textContent = MOOD_LABEL[c.mood] ?? c.mood;
      $<HTMLSpanElement>('chip-aff').textContent = `关系 ${Math.round(c.affinity)}`;
      $<HTMLSpanElement>('chip-energy').textContent = `精力 ${Math.round(c.energyValue)}`;

      $<HTMLElement>('ui-mood-bar').style.width = `${c.moodValue}%`;
      $<HTMLElement>('ui-energy-bar').style.width = `${c.energyValue}%`;
      $<HTMLElement>('ui-aff-bar').style.width = `${Math.min(100, (c.affinity / AFFINITY_MAX) * 100)}%`;
      $<HTMLSpanElement>('ui-mood-v').textContent = String(Math.round(c.moodValue));
      $<HTMLSpanElement>('ui-energy-v').textContent = ENERGY_LABEL[c.energy] ?? '';
      $<HTMLSpanElement>('ui-aff-v').textContent = String(Math.round(c.affinity));
      $<HTMLElement>('ui-activity').textContent = ACTIVITY_LABEL[c.activity] ?? c.activity;
      $<HTMLElement>('ui-tidy').textContent = `${Math.round(save.room.tidiness)}/100`;
      $<HTMLElement>('ui-weather').textContent = WEATHER_LABEL[save.room.weather] ?? save.room.weather;

      $('btn-lamp').classList.toggle('on', save.room.lampOn);
      $('btn-curtain').classList.toggle('on', save.room.curtainOpen);

      // 时间输入框跟随当前时钟。用户手动改过（dirty）或正在输入时不回写，
      // 否则刚选好的时间会被下一帧打回原样——这就是"设不了时间"的根因。
      if (!timeDirty && document.activeElement !== timeInputEl) {
        const hh = String(Math.floor(save.clock % 24)).padStart(2, '0');
        const mm = String(Math.floor((save.clock % 1) * 60)).padStart(2, '0');
        const val = `${hh}:${mm}`;
        if (timeInputEl.value !== val) timeInputEl.value = val;
      }
      // 手机（只看打开着的那台，避免每帧重建 DOM）
      if (open === 'phone') phones.her.refresh(save);
      else if (open === 'myphone') phones.me.refresh(save);

      // 阶段 0 时"她的手机"是锁着的：你还看不见她的世界（只在变化时动 DOM）
      const herLocked = (save.story?.phase ?? 0) < 1;
      if (herLocked !== herPhoneLocked) {
        herPhoneLocked = herLocked;
        const btn = root.querySelector<HTMLElement>('.drawer-item[data-panel="phone"]');
        if (btn) {
          btn.classList.toggle('locked', herLocked);
          btn.title = herLocked ? '关系进展达到阶段要求后，就能看见对方的手机了' : '';
        }
      }
      // 金币显示
      const coins = Math.round(save.coins);
      if (coins !== lastCoins) {
        lastCoins = coins;
        $<HTMLSpanElement>('chip-coins').textContent = `金币 ${coins}`;
      }
      // 状态面板：羁绊进度 / 购买实体
      if (open === 'status') {
        renderStoryProgress(save);
        renderTraits(save);
      }
      // 商城打开时，状态变了才重绘（避免每帧重建 DOM）
      if (open === 'shop') {
        const key = `${coins}|${save.ownedAccessories.join(',')}|${save.equippedAccessories.join(',')}`;
        if (key !== lastShopKey) {
          lastShopKey = key;
          renderShop(save);
        }
      }
    },

    greet(save: SaveData) {
      const c = save.character;
      const lines: Record<string, string> = {
        morning: '……早。',
        noon: '回来啦？',
        evening: '天快黑了。',
        night: '……还没睡啊。',
      };
      window.setTimeout(() => {
        ui.setBubble(lines[c.phase] ?? '……');
        window.setTimeout(() => ui.setBubble(''), 2800);
      }, 700);
    },

    // 注意：boot-hint 在选人界面里。开始游戏后 boot 被移除，
    // 之后换人时这个元素已经不存在了 —— 必须判空，否则 null.textContent 会抛异常。
    setLive2DStatus(s: { loading: boolean; ready: boolean; error?: string }) {
      const hint = root.querySelector('#boot-hint') as HTMLParagraphElement | null;
      const text = s.loading
        ? '正在载入模型…'
        : s.ready
          ? ''
          : s.error
            ? `模型载入失败：${s.error}`
            : '';
      if (hint) hint.textContent = text;
      else if (s.error) this.addLog(`模型载入失败：${s.error}`, true);
    },

    setProfileSwitching(v: boolean, name?: string) {
      const hint = root.querySelector('#boot-hint') as HTMLParagraphElement | null;
      if (hint) hint.textContent = v ? `正在换成 ${name ?? ''}…` : '';
      else if (v) this.addLog(`正在换成 ${name ?? ''}…`);
    },

    setProfileId(id: string) {
      roleList.querySelectorAll<HTMLElement>('[data-role]').forEach((el) => {
        el.classList.toggle('on', el.dataset.role === id);
      });
    },

    setPresence(p: PresenceInfo) {
      lastPresence = p;
      const key = `${p.away}|${p.placeId}|${p.working}`;
      if (key === lastPresenceKey) return;
      lastPresenceKey = key;

      // 出门提示
      awayNote.hidden = !p.away;
      if (p.away) {
        $<HTMLElement>('away-emoji').textContent = p.emoji;
        $<HTMLElement>('away-title').textContent = `${p.line}`;
        $<HTMLElement>('away-sub').textContent = `在 ${p.placeName}`;
      }
      // 手机上"她此刻在哪"
      if (lastSave) {
        phones.her.refresh(lastSave);
        phones.me.refresh(lastSave);
      }

      if (open === 'map' && lastSave) renderMap(lastSave);
    },
  };

  function renderMemories(save: SaveData): void {
    const ul = $<HTMLUListElement>('ui-memories');
    const items = [...memoriesFor(save)].sort((a, b) => b.weight - a.weight).slice(0, 12);
    ul.innerHTML = items.map((m) => `<li>${m.summary}</li>`).join('') || '<li class="empty">还没有</li>';
  }

  /** 在状态面板渲染「羁绊进度 / 购买实体」入口。实体不再是手机 APP，而是功能开关。 */
  function renderStoryProgress(save: SaveData): void {
    const el = document.getElementById('story-progress');
    if (!el) return;
    const story = save.story;
    const phase = story.phase;
    const aff = Math.round(save.character.affinity);
    const key = `${phase}|${story.hasPhysical ? 1 : 0}|${aff}|${save.coins}`;
    if (key === lastStoryKey) return;
    lastStoryKey = key;
    if (story.hasPhysical) {
      el.innerHTML = `<span class="env-label">羁绊</span>
        <div class="story-progress on">
          <span>✨ 跨界连接已建立</span>
          <p>近距离互动与共同活动功能已开启。</p>
        </div>`;
      return;
    }
    if (phase >= 2) {
      const canBuy = save.coins >= PHYSICAL_COST;
      el.innerHTML = `<span class="env-label">羁绊</span>
        <div class="story-progress">
          <span>女巫工坊的跨界转换器可以试制了</span>
          <p>关系进展 ${aff} / ${STORY.PHYSICAL} · 金币 ${save.coins} / ${PHYSICAL_COST}</p>
          <button class="primary wide" id="btn-buy-physical" ${canBuy ? '' : 'disabled'}>${canBuy ? `购买跨界实体转换器（${PHYSICAL_COST} 金币）` : '去女巫工坊打工攒材料费'}</button>
        </div>`;
      el.querySelector<HTMLElement>('#btn-buy-physical')?.addEventListener('click', () => {
        if (cb.onBuyPhysical()) {
          renderStoryProgress(save);
          ui.addLog(`${tp(save)}来了。`);
        }
      });
      return;
    }
    if (phase >= 1) {
      el.innerHTML = `<span class="env-label">羁绊</span>
        <div class="story-progress">
          <span>你能看见那边的世界了</span>
          <p>关系进展 ${aff} / ${STORY.PHYSICAL} · 金币 ${save.coins} / ${PHYSICAL_COST}</p>
          <p class="hint">多聊聊，看看异世界的信号还会不会变清晰。女巫工坊也许有线索。</p>
        </div>`;
      return;
    }
    // 还没觉醒：下一站是"坦白"（若已过）还是"寄件失败"
    const nextLabel = story.confessionAt ? '寄件失败' : '坦白';
    const nextAt = story.confessionAt ? STORY.GIFT_FUMBLE : STORY.CONFESS;
    el.innerHTML = `<span class="env-label">羁绊</span>
      <div class="story-progress">
        <span>你们还隔着一部手机</span>
        <p>关系进展 ${aff} / ${nextAt}（${nextLabel}）</p>
        <p class="hint">多聊聊，说不定会解锁异世界的新线索……这算隐藏任务吗？</p>
      </div>`;
  }

  /**
   * 状态面板里的「人格倾向」区。
   *
   * 这三条不是设定，是攒出来的：同一副预设，遇到不同的事会长成不同的人。
   * 把数值和最近一次变动的原因摊开，是为了让"她变了"这件事可见、可回溯，
   * 而不是只能由开发者口头声称。
   */
  function renderTraits(save: SaveData): void {
    const el = document.getElementById('trait-panel');
    if (!el) return;
    const traits = describeTraits(save);
    const key = `${save.character.personality.preset}|${traits.map((t) => t.value.toFixed(3)).join(',')}|${save.traitHistory.length}`;
    if (key === lastTraitKey) return;
    lastTraitKey = key;

    const rows = traits
      .map(
        (t) => `<div class="trait-row">
          <span class="trait-k">${t.label}</span>
          <div class="trait-bar"><i style="width:${Math.round(t.value * 100)}%"></i></div>
          <span class="trait-v">${Math.round(t.value * 100)}</span>
        </div>`,
      )
      .join('');

    const recent = save.traitHistory.slice(-2).reverse();
    const history = recent.length
      ? recent.map((p) => `<li><i>第${p.day + 1}天</i>${escapeHtml(p.reason)}</li>`).join('')
      : `<li><i>—</i>还没有什么值得改变${tp(save)}的事</li>`;

    el.innerHTML = `<span class="env-label">人格倾向（会被经历改写）</span>
      <div class="trait-box">
        ${rows}
        <p class="trait-note">${escapeHtml(evolutionLine(save))}</p>
        <div class="trait-idx">最近让${tp(save)}变了一点的事</div>
        <ul class="trait-hist">${history}</ul>
      </div>`;
  }

  // ── 手机：主屏 APP + 微信 ────────────────
  const MOMENT_KIND: Record<string, string> = {
    outing: '出门了',
    diary: '日记',
    gift: '收到了礼物',
    event: '日常',
    mine: '我拍的',
  };

  /** 每个地点的"照片"配色（没有生成图时退化成配色卡片） */
  const PLACE_ART: Record<string, [string, string, string]> = {
    home: ['#3a2b23', '#241a15', '🏠'],
    school: ['#8fb4cf', '#c9d9e4', '🏫'],
    office: ['#5b6f86', '#9aacbd', '🏢'],
    cafe: ['#c79a6b', '#e8c9a0', '☕'],
    store: ['#7fa8c9', '#bfd8e8', '🏪'],
    park: ['#6f9c76', '#c6dcae', '🌳'],
    station: ['#8b8f9c', '#c3c8d2', '🚉'],
    arcade: ['#7a5cae', '#e07ba8', '🎮'],
    bookstore: ['#8a6a4f', '#d3b189', '📚'],
    'witch-workshop': ['#4a3a6b', '#b08fd0', '🔮'],
    walk: ['#7d8f9c', '#c2ccd4', '🚶'],
  };

  /** 可选头像（两部手机共用同一批） */
  const AVATARS = ['🧑', '🌸', '🌙', '🐱', '🍞', '🎧', '🦊', '🐰', '🌿', '⭐', '🍵', '🧸'];

  /** 微信状态词（参考微信状态：心情想法 / 工作学习 / 活动 / 休息） */
  const STATUS_WORDS: { emoji: string; word: string }[] = [
    { emoji: '😴', word: '困' },
    { emoji: '📚', word: '学习' },
    { emoji: '☕', word: '发呆' },
    { emoji: '🏃', word: '忙' },
    { emoji: '🎮', word: '玩游戏' },
    { emoji: '😤', word: '烦' },
    { emoji: '🥰', word: '美滋滋' },
    { emoji: '🌧️', word: '下雨' },
    { emoji: '🛏️', word: '躺平' },
    { emoji: '🍳', word: '做饭' },
    { emoji: '🛒', word: '买东西' },
    { emoji: '🎧', word: '听歌' },
  ];

  const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  }

  /** 微信状态：24 小时后自动过期（跟真微信一样） */
  function activeStatus(s: WxStatus | null): WxStatus | null {
    if (!s) return null;
    if (!lastSave || lastSave.clock - s.at > 24) return null;
    return s;
  }

  type PhonePage =
    | 'home'
    | 'wechat'
    | 'album'
    | 'diary'
    | 'schedule'
    | 'camera'
    | 'weather';
  type WxPage =
    | 'chats'
    | 'contacts'
    | 'discover'
    | 'me'
    | 'chat'
    | 'moments'
    | 'newfriends'
    | 'onlychat'
    | 'avatar'
    | 'status'
    | 'remark';

  interface PhoneCtl {
    onShow(): void;
    refresh(save: SaveData): void;
    notifyHerMsg(): void;
    openChat(contactId: string): void;
    openContacts(): void;
  }

  /**
   * 一台手机。
   *
   * owner='her' → 她的手机：微信里是她和认识的人的聊天，只读；
   * owner='me' → 我的手机：能给她发消息、写日记、排日程、发朋友圈、发状态。
   *
   * 结构：主屏（APP 宫格）→ 点进「微信」才是微信（消息 / 通讯录 / 发现 / 我）。
   * 两台手机共用同一个组件，头像和状态读同一份存档，所以换头像会同步。
   */
  function createPhone(owner: 'her' | 'me'): PhoneCtl {
    const panel = root.querySelector<HTMLElement>(
      `.panel[data-panel="${owner === 'her' ? 'phone' : 'myphone'}"]`,
    );
    if (!panel) throw new Error('phone panel missing');
    panel.innerHTML = `
      <div class="panel-card phone-card">
        <button class="x phone-x" data-close aria-label="关闭">×</button>
        <div class="phone">
          <div class="phone-bar">
            <span class="ph-clock">--:--</span>
            <span class="ph-notch" aria-hidden="true"></span>
            <span class="ph-sys"><i>📶</i><b>${owner === 'her' ? '76' : '82'}%</b></span>
          </div>
          <div class="phone-body">
            <div class="wx-appbar" hidden>
              <button class="wx-back" aria-label="返回">‹</button>
              <span class="wx-title"></span>
            </div>
            <div class="wx-scroll"></div>
            <div class="wx-foot" hidden>
              <input class="wx-input" type="text" placeholder="发消息…" autocomplete="off" />
              <button class="wx-send">发送</button>
            </div>
          </div>
          <nav class="wx-tabs">
            <button data-tab="chats" class="on"><span>💬</span><em>消息</em><i class="wx-dot" hidden></i></button>
            <button data-tab="contacts"><span>👥</span><em>通讯录</em></button>
            <button data-tab="discover"><span>🧭</span><em>发现</em></button>
            <button data-tab="me"><span>🙂</span><em>我</em></button>
          </nav>
        </div>
      </div>`;

    const clockEl = panel.querySelector<HTMLElement>('.ph-clock')!;
    const appbar = panel.querySelector<HTMLElement>('.wx-appbar')!;
    const titleEl = panel.querySelector<HTMLElement>('.wx-title')!;
    const scroll = panel.querySelector<HTMLElement>('.wx-scroll')!;
    const foot = panel.querySelector<HTMLElement>('.wx-foot')!;
    const input = panel.querySelector<HTMLInputElement>('.wx-input')!;
    const tabs = panel.querySelector<HTMLElement>('.wx-tabs')!;
    const dot = panel.querySelector<HTMLElement>('.wx-dot')!;
    // 关闭按钮必须在面板内容建好之后再绑——之前它在空面板上绑，所以点了没用
    panel.querySelector<HTMLElement>('.phone-x')!.addEventListener('click', () => ui.openPanel(null));

    let page: PhonePage = 'home';
    let wx: WxPage = 'chats';
    /** 从哪个微信 tab 进来的，返回时回到那里 */
    let lastWx: WxPage = 'chats';
    let chatId: string | null = null;
    let remarkId: string | null = null;
    let unreadReal = 0;
    let lastSig = '';

    const WX_TABS: WxPage[] = ['chats', 'contacts', 'discover', 'me'];

    // ── 联系人：你/她 + 在世界里认识的人 ──
    function contactsOf(save: SaveData): Contact[] {
      // 开局的好友申请没通过之前，两边手机的通讯录都该是空的——
      // 那时你还"不认识"她，她也还没把加上的人收进通讯录。
      // 老存档没有 her-opening 这条（!op）时按已通过处理，不影响旧档。
      const op = save.metPeople.find((p) => p.id === 'her-opening');
      const openingAccepted = !op || op.added;
      if (!openingAccepted) return [];

      const base = owner === 'me' ? myContacts(save.character.personality.name) : herContacts(save.playerName);
      const met = save.metPeople
        // 'her-opening' 只是开局的"好友申请"道具，不是真联系人：
        // 玩家这边她本来就是 'her'，她那边不该出现"她自己"，两边都要排掉。
        .filter((p) => p.added && p.id !== 'her-opening')
        .map((p): Contact => ({ id: p.id, name: p.remark || p.name, emoji: p.emoji, note: p.note }));
      // 按 id 去重：女巫本来就在她的通讯录里（外婆的老朋友），
      // 但她出门在工坊"再遇到"女巫时也会进 metPeople —— 不去重就会出现两个女巫。
      const seen = new Set<string>();
      return [...base, ...met].filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
    }

    function contactOf(save: SaveData, id: string): Contact | null {
      const direct = contactsOf(save).find((c) => c.id === id);
      if (direct) return direct;
      const met = save.metPeople.find((p) => p.id === id);
      return met ? { id: met.id, name: met.name, emoji: met.emoji, note: met.note } : null;
    }

    function avatarOf(save: SaveData, id: string): string {
      if (id === 'me') return save.myAvatar;
      if (id === 'her') return save.herAvatar;
      return contactOf(save, id)?.emoji ?? '👤';
    }

    function myStatusOf(save: SaveData): WxStatus | null {
      return activeStatus(owner === 'me' ? save.myStatus : save.herStatus);
    }

    function threadOf(save: SaveData, contactId: string): { msgs: ChatMsg[]; tOwner: 'her' | 'me' } {
      const shared = (owner === 'me' && contactId === 'her') || (owner === 'her' && contactId === 'me');
      if (shared) {
        const th = threadFor(save, 'me', 'her');
        return { msgs: th?.msgs ?? [], tOwner: 'me' };
      }
      const th = threadFor(save, owner, contactId);
      return { msgs: th?.msgs ?? [], tOwner: owner };
    }

    function isMineMsg(msg: ChatMsg, tOwner: 'her' | 'me'): boolean {
      return tOwner === owner ? msg.from === 'owner' : msg.from === 'her';
    }

    function canSend(contactId: string | null): boolean {
      return owner === 'me' && contactId === 'her';
    }

    function unreadOf(save: SaveData, contactId: string): number {
      if (owner === 'me' && contactId === 'her') return unreadReal;
      return threadFor(save, owner, contactId)?.unread ?? 0;
    }

    function totalUnread(save: SaveData): number {
      return contactsOf(save).reduce((n, c) => n + unreadOf(save, c.id), 0);
    }

    // ── 主屏 ──────────────────────────────
    function homeBody(save: SaveData): string {
      const her = owner === 'her';
      const name = her ? save.character.personality.name : save.playerName;
      const phase = save.story?.phase ?? 0;
      // 我这边的主屏副标题跟着剧情阶段走，不再暗示"共处一室"：
      // 起初只是隔屏联系，能看见她那边的世界之后，才是"在场"。
      const sub = her
        ? lastPresence?.away
          ? `${lastPresence.emoji} 在${lastPresence.placeName}`
          : '🏠 在家'
        : save.story?.hasPhysical
          ? `${tp(save)}来到你身边了`
          : phase >= 1
            ? '你能看见那边的世界了'
            : '隔着两个世界';

      // 我手机：阶段 0 只有微信/日记/日程，天气删除；她那边的手机保留天气。
      // 相机在世界解锁后（我这边能看见）才出现；她手机一直可用。
      const apps: { id: string; ico: string; label: string; locked?: boolean }[] = [
        { id: 'wechat', ico: '💬', label: '微信' },
        ...(owner === 'her' || phase >= 1 ? [{ id: 'camera', ico: '📷', label: '相机' }] : []),
        { id: 'diary', ico: '📖', label: '日记' },
        { id: 'schedule', ico: '🗓️', label: '日程' },
        ...(owner === 'her' ? [{ id: 'weather', ico: '🌤️', label: '天气' }] : []),
        { id: 'shop', ico: '🛒', label: '商店' },
      ];
      return `<div class="ph-wall">
          <div class="ph-wall-row"><b>${formatClock(save.clock)}</b><span>${WEEKDAY_CN[new Date().getDay()]} · 第 ${Math.floor(save.clock / 24) + 1} 天</span></div>
          <div class="ph-me">
            <span class="ph-ava">${her ? save.herAvatar : save.myAvatar}</span>
            <div class="ph-me-txt"><b>${escapeHtml(name)}</b><span>${escapeHtml(sub)}</span></div>
          </div>
        </div>
        <div class="ph-apps">
          ${apps
            .map(
              (a) =>
                `<button class="ph-app${a.locked ? ' locked' : ''}" data-app="${a.id}"><span class="ph-ico">${a.ico}</span><em>${escapeHtml(a.label)}</em></button>`,
            )
            .join('')}
        </div>`;
    }

    function cameraBody(): string {
      const place = lastPresence?.placeId ?? 'home';
      const p = getPlace(place);
      const img = ALBUM_IMG[place];
      const art = img
        ? `<img class="wx-shot" src="${img}" alt="" />`
        : `<div class="wx-shot" style="background:linear-gradient(160deg,${PLACE_ART[place]?.[0] ?? '#333'},${PLACE_ART[place]?.[1] ?? '#222'})"><span>${PLACE_ART[place]?.[2] ?? '📷'}</span></div>`;
      return `<p class="ph-note">对准的是${escapeHtml(p.name)}。</p>
        <div class="wx-cam">${art}</div>
        <div class="wx-cam-foot"><button class="wx-shoot">拍一张</button></div>`;
    }

    function weatherBody(save: SaveData): string {
      const hour = save.clock % 24;
      const phase = hour < 5 ? '深夜' : hour < 11 ? '早上' : hour < 13 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
      return `<div class="wx-weather">
          <div class="wx-w-big">${WEATHER_LABEL[save.room.weather] ?? save.room.weather}</div>
          <div class="wx-w-sub">${phase} · ${formatClock(save.clock)}</div>
          <div class="wx-w-rows">
            <div class="row"><span>位置</span><b>${escapeHtml(lastPresence?.placeName ?? '小屋')}</b></div>
            <div class="row"><span>台灯</span><b>${save.room.lampOn ? '开着' : '关着'}</b></div>
            <div class="row"><span>窗帘</span><b>${save.room.curtainOpen ? '拉开' : '拉上'}</b></div>
            <div class="row"><span>整洁度</span><b>${Math.round(save.room.tidiness)}/100</b></div>
          </div>
        </div>`;
    }

    // ── 微信各页 ───────────────────────────
    function chatsBody(save: SaveData): string {
      const cs = contactsOf(save);
      // 阶段 0 + 还没通过好友申请 → 引导去通讯录
      const openingPending = save.metPeople.find((p) => p.id === 'her-opening' && !p.added);
      if (openingPending && cs.length === 0) {
        return `<div class="wx-empty-guide">
          <div class="wx-empty-ico">📨</div>
          <h4>还没有聊天对象</h4>
          <p>先到「通讯录」看一眼新的朋友，<br/>通过好友申请之后就可以聊天了。</p>
        </div>`;
      }
      return `<div class="wx-list">${cs
        .map((c) => {
          const m = threadOf(save, c.id).msgs.slice(-1)[0] ?? null;
          const un = unreadOf(save, c.id);
          const preview = m ? escapeHtml(m.text) : '<span class="wx-mute">还没有聊天记录</span>';
          const st = c.id === (owner === 'me' ? 'her' : 'me') ? myStatusOf(save) : null;
          return `<button class="wx-chat" data-chat="${c.id}">
            <span class="wx-ava">${avatarOf(save, c.id)}</span>
            <span class="wx-cbody">
              <span class="wx-cname">${escapeHtml(c.name)}${st ? `<i class="wx-st">${st.emoji}${escapeHtml(st.word)}</i>` : ''}</span>
              <span class="wx-prev">${preview}</span>
            </span>
            <span class="wx-cmeta">
              <span class="wx-time">${m ? hm(m.at) : ''}</span>
              ${un ? `<i class="wx-badge">${un > 99 ? '99+' : un}</i>` : ''}
            </span>
          </button>`;
        })
        .join('')}</div>`;
    }

    function contactsBody(save: SaveData): string {
      const added = contactsOf(save);
      const pending = save.metPeople.filter((p) => !p.added && p.id !== 'her-opening');
      const st = myStatusOf(save);
      return `<div class="wx-list">
          <button class="wx-row" data-go="newfriends">
            <span class="wx-row-i">👤</span><span class="wx-row-t">新的朋友</span>
            ${pending.length ? `<i class="wx-badge inline">${pending.length}</i>` : ''}<i class="wx-arrow">›</i>
          </button>
          <button class="wx-row" data-go="onlychat">
            <span class="wx-row-i">💬</span><span class="wx-row-t">仅聊天的朋友</span><i class="wx-arrow">›</i>
          </button>
          <div class="wx-idx">通讯录联系人</div>
          ${
            added.length
              ? added
                  .map(
                    (c) => `<button class="wx-contact" data-chat="${c.id}">
                      <span class="wx-ava">${avatarOf(save, c.id)}</span>
                      <span class="wx-cbody">
                        <span class="wx-cname">${escapeHtml(c.name)}${c.id === (owner === 'me' ? 'her' : 'me') && st ? `<i class="wx-st">${st.emoji}${escapeHtml(st.word)}</i>` : ''}</span>
                        <span class="wx-prev">${escapeHtml(c.note)}</span>
                      </span>
                    </button>`,
                  )
                  .join('')
              : '<p class="ph-empty">还没有联系人。</p>'
          }
        </div>`;
    }

    function newfriendsBody(save: SaveData): string {
      const pending = save.metPeople.filter((p) => !p.added);
      const opening = pending.find((p) => p.id === 'her-opening');
      const others = pending.filter((p) => p.id !== 'her-opening');
      const items = opening ? [opening, ...others] : others;
      if (!items.length) {
        return '<div class="wx-list"><p class="ph-empty">暂时没有新的朋友申请。</p></div>';
      }
      return `<div class="wx-list">
          <div class="wx-idx">好友申请</div>
          ${items
            .map(
              (p) => {
                const isOpening = p.id === 'her-opening';
                return `<div class="wx-pending ${isOpening ? 'opening' : ''}">
                  <span class="wx-ava">${p.emoji}</span>
                  <span class="wx-cbody">
                    <span class="wx-cname">${escapeHtml(p.name)}</span>
                    <span class="wx-prev">${escapeHtml(p.note)}</span>
                  </span>
                  <button class="wx-accept" data-accept="${p.id}">${isOpening ? '接受' : '添加'}</button>
                </div>`;
              },
            )
            .join('')}
        </div>`;
    }

    function onlychatBody(save: SaveData): string {
      const pending = save.metPeople.filter((p) => !p.added);
      return `<div class="wx-list">
          <div class="wx-idx">仅聊天的朋友</div>
          ${
            pending.length
              ? pending
                  .map(
                    (p) => `<div class="wx-contact static">
                      <span class="wx-ava">${p.emoji}</span>
                      <span class="wx-cbody"><span class="wx-cname">${escapeHtml(p.name)}</span><span class="wx-prev">聊过，还没加好友</span></span>
                    </div>`,
                  )
                  .join('')
              : '<p class="ph-empty">没有"只聊天、不加好友"的人。</p>'
          }
        </div>`;
    }

    function remarkBody(save: SaveData, id: string): string {
      const p = save.metPeople.find((x) => x.id === id);
      const name = p?.name ?? '';
      const isOpening = id === 'her-opening';
      return `<div class="wx-remark">
          <div class="wx-remark-head">
            <span class="wx-ava big">${p?.emoji ?? '👤'}</span>
            <div class="wx-cbody">
              <span class="wx-cname">${escapeHtml(name)}</span>
              <span class="wx-prev">${isOpening ? '新的朋友' : '新认识的人'}</span>
            </div>
          </div>
          <div class="wx-remark-row">
            <label>备注名</label>
            <input class="wx-remark-in" type="text" value="${escapeHtml(name)}" maxlength="12" placeholder="给TA一个备注" />
          </div>
          <div class="wx-remark-row">
            <label>分组</label>
            <div class="wx-remark-tags">
              ${['朋友', '家人', '同学', '同事']
                .map((g) => `<button class="wx-remark-tag ${g === '朋友' ? 'on' : ''}" data-group="${g}">${g}</button>`)
                .join('')}
            </div>
          </div>
          <button class="wx-remark-done" data-remark-done="${id}">完成</button>
        </div>`;
    }

    function discoverBody(): string {
      return `<div class="wx-list">
          <button class="wx-row" data-go="moments"><span class="wx-row-i">🌈</span><span class="wx-row-t">朋友圈</span><i class="wx-arrow">›</i></button>
          <button class="wx-row ghost"><span class="wx-row-i">📷</span><span class="wx-row-t">扫一扫</span><i class="wx-arrow">›</i></button>
          <button class="wx-row ghost"><span class="wx-row-i">🎵</span><span class="wx-row-t">听一听</span><i class="wx-arrow">›</i></button>
        </div>`;
    }

    function meBody(save: SaveData): string {
      const her = owner === 'her';
      const name = her ? save.character.personality.name : save.playerName;
      const wxid = her ? 'she_hearth' : 'me_hearth';
      const st = myStatusOf(save);
      const stHtml = st
        ? `<div class="wx-status on"><span class="wx-st-emoji">${st.emoji}</span><span class="wx-st-txt"><b>${escapeHtml(st.word)}</b><i>${escapeHtml(st.text)}</i></span></div>`
        : `<div class="wx-status"><span class="wx-st-emoji">＋</span><span class="wx-st-txt"><b>${her ? 'TA 还没发状态' : '发个状态'}</b>${her ? '<i>想法来了才会发</i>' : '<i>点一下写一句</i>'}</span></div>`;
      // 我手机去掉相册入口；她的手机保留相册。
      const albumRow = her
        ? `<button class="wx-row" data-go="album"><span class="wx-row-i">🖼️</span><span class="wx-row-t">相册</span><i class="wx-arrow">›</i></button>`
        : '';
      return `<div class="wx-list">
          <div class="wx-me">
            <button class="wx-ava big" data-avatar aria-label="换头像">${her ? save.herAvatar : save.myAvatar}</button>
            <span class="wx-cbody">
              <span class="wx-cname">${escapeHtml(name)}</span>
              <span class="wx-prev">微信号：${wxid}</span>
            </span>
          </div>
          ${her ? stHtml : `<button class="wx-status-btn" data-status>${stHtml}</button>`}
          <button class="wx-row" data-go="moments"><span class="wx-row-i">🌈</span><span class="wx-row-t">朋友圈</span><i class="wx-arrow">›</i></button>
          ${albumRow}
          <button class="wx-row ghost"><span class="wx-row-i">❤️</span><span class="wx-row-t">收藏</span><i class="wx-arrow">›</i></button>
          <button class="wx-row ghost"><span class="wx-row-i">⚙️</span><span class="wx-row-t">设置</span><i class="wx-arrow">›</i></button>
        </div>`;
    }

    function chatBody(save: SaveData, contactId: string): string {
      const { msgs, tOwner } = threadOf(save, contactId);
      const c = contactOf(save, contactId);
      const st = contactId === (owner === 'me' ? 'her' : 'me') ? myStatusOf(save) : null;
      const head = `<div class="wx-chat-note">${escapeHtml(c?.note ?? '')}</div>`;
      const stLine = st ? `<div class="wx-chat-status">${st.emoji} ${escapeHtml(st.word)} · ${escapeHtml(st.text)}</div>` : '';
      // 她还有话没"打完"（排期队列里还有她的消息）→ 显示"正在输入…"
      const herPending = (save.pendingMsgs ?? []).some((m) => m.owner === 'me' && m.from === 'her');
      const typing =
        owner === 'me' && contactId === 'her' && herPending
          ? `<div class="wx-line"><span class="wx-mini">${save.herAvatar}</span><span class="wx-bub wx-typing"><i></i><i></i><i></i></span></div>`
          : '';
      if (!msgs.length) {
        return (
          head +
          stLine +
          typing +
          (herPending ? '' : `<p class="ph-empty">${owner === 'me' ? '还没有聊过，说点什么吧。' : '还没有聊天记录。'}</p>`)
        );
      }
      return (
        head +
        stLine +
        msgs
          .map((m) => {
            const mine = isMineMsg(m, tOwner);
            const ava = mine
              ? ''
              : `<span class="wx-mini">${avatarOf(save, m.from === 'owner' ? (owner === 'me' ? 'me' : 'her') : m.from)}</span>`;
            // 图片消息：跟真人微信一样是一张缩略图，点开可放大；它不是气泡文字
            const body = m.image
              ? `<span class="wx-bub wx-bub-img">
                  <img class="wx-img" src="${escapeHtml(m.image)}" alt="图片" data-zoom="${escapeHtml(m.image)}" />
                  ${m.text ? `<em class="wx-img-cap">${escapeHtml(m.text)}</em>` : ''}
                </span>`
              : `<span class="wx-bub">${escapeHtml(m.text)}</span>`;
            return `<div class="wx-line ${mine ? 'mine' : ''}">${ava}${body}</div>`;
          })
          .join('') +
        typing
      );
    }

    function momentsBody(save: SaveData): string {
      const list = [...momentsFor(save)].reverse().slice(0, 30);
      const post =
        owner === 'me'
          ? `<div class="wx-post">
               <textarea class="wx-post-in" rows="2" placeholder="这一刻的想法…"></textarea>
               <button class="wx-post-btn">发表</button>
             </div>`
          : '';
      const feed = list
        .map((m) => {
          const mine = m.author === 'me';
          const author = mine ? save.playerName : save.character.personality.name;
          const avatar = mine ? save.myAvatar : m.placeId ? getPlace(m.placeId).emoji : save.herAvatar;
          const where = m.placeId ? getPlace(m.placeId).name : '';
          // 共同好友评论可见：我的评论她能看见，她的评论我能看见；NPC 评论只有共同好友时双方都可见
          const visibleCmts = m.comments.filter((cm) => {
            if (cm.by === 'me' || cm.by === 'her') return true;
            // NPC：评论者与发朋友圈的人是否共同好友
            return !!cm.isMutual;
          });
          const comments = visibleCmts
            .map((cm) => `<div class="mo-cmt"><b>${escapeHtml(cm.name)}</b>${escapeHtml(cm.text)}</div>`)
            .join('');
          const img = m.placeId ? ALBUM_IMG[m.placeId] : '';
          const photo = img ? `<img class="mo-img" src="${img}" alt="" />` : '';
          return `<article class="mo">
            <div class="mo-head">
              <span class="mo-ava">${avatar}</span>
              <div class="mo-who"><b>${escapeHtml(author)}</b><span>${hm(m.at)}${where ? ` · ${where}` : ''}</span></div>
            </div>
            <p class="mo-text">${escapeHtml(m.text)}</p>
            ${photo}
            <div class="mo-foot">
              <button class="mo-like ${m.likedByMe ? 'on' : ''}" data-like="${m.id}">♥ ${m.likes}</button>
              <span class="mo-kind">${MOMENT_KIND[m.kind] ?? ''}</span>
            </div>
            ${comments ? `<div class="mo-cmts">${comments}</div>` : ''}
          </article>`;
        })
        .join('');
      return post + (feed || '<p class="ph-empty">还没有动态。</p>');
    }

    function albumBody(save: SaveData): string {
      const list = [...photosFor(save)].reverse().slice(0, 40);
      if (!list.length) return '<p class="ph-empty">相册还是空的。TA 出门时会拍几张。</p>';
      return `<div class="ph-album">${list
        .map((p) => {
          const pl = getPlace(p.placeId);
          const [a, b, icon] = PLACE_ART[p.placeId] ?? PLACE_ART.walk;
          const art = p.img
            ? `<img class="pp-img" src="${p.img}" alt="${escapeHtml(p.caption)}" />`
            : `<div class="pp-art" style="background:linear-gradient(160deg,${a},${b})"><span>${icon}</span></div>`;
          return `<figure class="ph-photo">
            ${art}
            <figcaption><b>${escapeHtml(p.caption)}</b><span>${hm(p.at)} · ${pl.name}</span></figcaption>
          </figure>`;
        })
        .join('')}</div>`;
    }

    function diaryBody(save: SaveData): string {
      if (owner === 'me') {
        const mine = [...save.myDiary].reverse();
        return `<div class="wx-diary-write">
            <textarea class="wx-diary-in" rows="3" placeholder="今天想记点什么…"></textarea>
            <button class="wx-diary-btn">写进日记</button>
          </div>
          ${
            mine.length
              ? mine
                  .map((d) => `<div class="wx-diary-item"><span class="d-day">第 ${d.day + 1} 天</span>${escapeHtml(d.text)}</div>`)
                  .join('')
              : `<p class="ph-empty">还没写过。写下来，${tp(save)}会看见。</p>`
          }`;
      }
      const list = [...diaryFor(save)].reverse().slice(0, 20);
      return (
        list
          .map((d) => `<div class="wx-diary-item"><span class="d-day">第 ${d.day + 1} 天</span>${escapeHtml(d.text)}</div>`)
          .join('') || '<p class="ph-empty">TA 还没写过日记。有值得记的事、或心情有波动时，才会写一笔。</p>'
      );
    }

    function planRows(blocks: PlanBlock[], editable: boolean, save: SaveData): string {
      const hour = save.clock % 24;
      return blocks
        .map((b, i) => {
          const pl = getPlace(b.placeId);
          if (!editable) {
            const on = hour >= b.start && hour < b.end;
            const kindText = b.kind === 'commit' ? '必须去' : b.kind === 'want' ? 'TA 想去' : '';
            return `<li class="${on ? 'on' : ''} ${b.kind}">
              <span class="sc-time">${hm(b.start)}</span>
              <span class="sc-e">${b.placeId === 'home' ? '🏠' : pl.emoji}</span>
              <span class="sc-b"><b>${escapeHtml(b.label)}</b>${kindText ? `<i>${kindText}</i>` : ''}</span>
              ${on ? '<span class="sc-now">现在</span>' : ''}
            </li>`;
          }
          return `<li class="sc-edit" data-row="${i}">
            <input type="time" class="sc-in-time" value="${hm(b.start)}" />
            <input type="time" class="sc-in-time" value="${hm(b.end)}" />
            <input type="text" class="sc-in-text" value="${escapeHtml(b.label)}" maxlength="16" />
            <button class="sc-del" data-del="${i}" aria-label="删除">×</button>
          </li>`;
        })
        .join('');
    }

    function scheduleBody(save: SaveData): string {
      if (owner === 'me') {
        const blocks = save.myPlan?.blocks ?? [];
        return `<p class="ph-note">排一下自己今天要做什么。TA 会看到你的日程。</p>
          <ul class="ph-sched">${planRows(blocks, true, save)}</ul>
          <div class="wx-plan-actions">
            <button class="wx-add">加一条</button>
            <button class="wx-save-plan">保存</button>
          </div>`;
      }
      const plan = save.herPlan;
      const t = pronoun(save.character.personality.gender);
      if (!plan || !plan.blocks.length) return `<p class="ph-empty">${t}还没定今天要做什么。</p>`;
      return `<p class="ph-note">${escapeHtml(`${t}今天：${describePlan(plan.blocks)}`)}</p>
        <ul class="ph-sched">${planRows(plan.blocks, false, save)}</ul>`;
    }

    // ── 换头像 / 发状态 ────────────────────
    function avatarPickerBody(save: SaveData): string {
      const cur = owner === 'me' ? save.myAvatar : save.herAvatar;
      return `<p class="ph-note">选一个头像。两部手机会同时换。</p>
        <div class="wx-avatars">${AVATARS.map(
          (a) => `<button class="wx-av ${a === cur ? 'on' : ''}" data-av="${a}">${a}</button>`,
        ).join('')}</div>`;
    }

    function statusPickerBody(): string {
      const words = STATUS_WORDS.map(
        (w) => `<button class="wx-word" data-word="${w.emoji}|${w.word}"><span>${w.emoji}</span><em>${w.word}</em></button>`,
      ).join('');
      return `<p class="ph-note">选个状态，再写一句。24 小时后自动结束。</p>
        <div class="wx-words">${words}</div>
        <div class="wx-status-write">
          <input class="wx-status-in" type="text" maxlength="24" placeholder="写一句感受…" />
          <button class="wx-status-ok">就这样</button>
        </div>
        <div class="wx-status-end"><button class="wx-status-clear">结束状态</button></div>`;
    }

    let pickedWord: { emoji: string; word: string } | null = null;

    // ── 渲染 ──────────────────────────────
    const TITLES: Partial<Record<PhonePage | WxPage, string>> = {
      home: owner === 'her' ? `${tp()}的手机` : '我的手机',
      wechat: '微信',
      album: '相册',
      diary: owner === 'me' ? '我的日记' : '日记',
      schedule: owner === 'me' ? '我的日程' : 'TA 的日程',
      camera: '相机',
      weather: '天气',
      chats: '微信',
      contacts: '通讯录',
      discover: '发现',
      me: '我',
      chat: '聊天',
      moments: '朋友圈',
      newfriends: '新的朋友',
      onlychat: '仅聊天的朋友',
      avatar: '换头像',
      status: '发个状态',
      remark: '设置备注和标签',
    };

    function bodyFor(save: SaveData): string {
      if (page === 'home') return homeBody(save);
      if (page !== 'wechat') {
        if (page === 'album') return albumBody(save);
        if (page === 'diary') return diaryBody(save);
        if (page === 'schedule') return scheduleBody(save);
        if (page === 'camera') return cameraBody();
        if (page === 'weather') return weatherBody(save);
        return '';
      }
      switch (wx) {
        case 'chats':
          return chatsBody(save);
        case 'contacts':
          return contactsBody(save);
        case 'discover':
          return discoverBody();
        case 'me':
          return meBody(save);
        case 'chat':
          return chatId ? chatBody(save, chatId) : '';
        case 'moments':
          return momentsBody(save);
        case 'newfriends':
          return newfriendsBody(save);
        case 'onlychat':
          return onlychatBody(save);
        case 'avatar':
          return avatarPickerBody(save);
        case 'status':
          return statusPickerBody();
        case 'remark':
          return remarkId ? remarkBody(save, remarkId) : '';
        default:
          return '';
      }
    }

    function sigFor(save: SaveData): string {
      const base = `${page}|${wx}|${chatId ?? ''}|${save.profileId}|${save.myAvatar}|${save.herAvatar}|`;
      const st = myStatusOf(save);
      switch (page) {
        case 'home':
          return base + `${save.playerName}|${save.character.personality.name}|${st?.word ?? ''}`;
        case 'wechat':
          switch (wx) {
            case 'chats':
              return (
                base +
                contactsOf(save)
                  .map((c) => `${c.id}:${unreadOf(save, c.id)}:${threadOf(save, c.id).msgs.slice(-1)[0]?.id ?? ''}`)
                  .join(',') +
                `|${st?.word ?? ''}`
              );
            case 'chat':
              return (
                base +
                threadOf(save, chatId!).msgs.map((m) => m.id).join(',') +
                `|p${(save.pendingMsgs ?? []).filter((m) => m.owner === 'me' && m.from === 'her').length}`
              );
            case 'moments':
              return (
                base +
                momentsFor(save)
                  .map((m) => `${m.id}:${m.likes}:${m.likedByMe ? 1 : 0}:${m.comments.length}`)
                  .join(',')
              );
            case 'contacts':
              return (
                base +
                save.metPeople.map((p) => `${p.id}:${p.added ? 1 : 0}:${p.remark ?? ''}`).join(',') +
                `|${st?.word ?? ''}`
              );
            case 'newfriends':
            case 'onlychat':
              return base + save.metPeople.filter((p) => !p.added).map((p) => `${p.id}:${p.note}`).join(',') + `|${st?.word ?? ''}`;
            case 'remark':
              return base + `${remarkId ?? ''}|${save.metPeople.find((p) => p.id === remarkId)?.added ? 1 : 0}`;
            default:
              return base + `${save.playerName}|${save.character.personality.name}|${st?.word ?? ''}`;
          }
        case 'album':
          return base + photosFor(save).map((p) => p.id).join(',');
        case 'diary':
          return base + (owner === 'me' ? save.myDiary.map((d) => d.id).join(',') : diaryFor(save).map((d) => d.id).join(','));
        case 'schedule':
          return (
            base +
            (owner === 'me'
              ? JSON.stringify(save.myPlan?.blocks ?? [])
              : `${JSON.stringify(save.herPlan?.blocks ?? [])}#${Math.floor(save.clock % 24)}`)
          );
        default:
          return base + formatClock(save.clock);
      }
    }

    function toHours(v: string): number {
      const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
      if (!m) return 9;
      return (Number(m[1]) % 24) + Number(m[2]) / 60;
    }

    function bindBody(save: SaveData): void {
      // 主屏 APP
      scroll.querySelectorAll<HTMLElement>('[data-app]').forEach((b) =>
        b.addEventListener('click', () => {
          const app = b.dataset.app as PhonePage;
          if (app === 'wechat') {
            page = 'wechat';
            wx = 'chats';
            lastWx = 'chats';
          } else {
            page = app;
          }
          lastSig = '';
          paint(save);
        }),
      );
      // 微信 tab
      tabs.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
        b.addEventListener('click', () => {
          wx = b.dataset.tab as WxPage;
          lastWx = wx;
          pickedWord = null;
          lastSig = '';
          paint(save);
        }),
      );
      // 进入会话 / 子页
      scroll.querySelectorAll<HTMLElement>('[data-chat]').forEach((b) =>
        b.addEventListener('click', () => openChat(b.dataset.chat as string)),
      );
      // 点聊天里的图片 → 放大看（记录本身不动，翻回去还在）
      scroll.querySelectorAll<HTMLElement>('[data-zoom]').forEach((img) =>
        img.addEventListener('click', () => openImageViewer(img.dataset.zoom as string)),
      );
      scroll.querySelectorAll<HTMLElement>('[data-go]').forEach((b) =>
        b.addEventListener('click', () => {
          const go = b.dataset.go as WxPage;
          if (WX_TABS.includes(wx)) lastWx = wx;
          wx = go;
          lastSig = '';
          paint(save);
        }),
      );
      // 接受好友申请 → 进入备注/分组页面
      scroll.querySelectorAll<HTMLElement>('[data-accept]').forEach((b) =>
        b.addEventListener('click', () => {
          remarkId = b.dataset.accept as string;
          wx = 'remark';
          lastWx = 'newfriends';
          lastSig = '';
          if (lastSave) paint(lastSave);
        }),
      );
      // 分组选择（仅 UI 反馈）
      scroll.querySelectorAll<HTMLElement>('[data-group]').forEach((b) =>
        b.addEventListener('click', () => {
          scroll.querySelectorAll<HTMLElement>('[data-group]').forEach((x) => x.classList.toggle('on', x === b));
        }),
      );
      // 完成备注 → 真正加好友
      scroll.querySelectorAll<HTMLElement>('[data-remark-done]').forEach((b) =>
        b.addEventListener('click', () => {
          const id = b.dataset.remarkDone as string;
          const remark = scroll.querySelector<HTMLInputElement>('.wx-remark-in')?.value.trim();
          cb.onAddContact(id, remark);
          remarkId = null;
          wx = 'contacts';
          lastSig = '';
          if (lastSave) paint(lastSave);
        }),
      );
      scroll.querySelectorAll<HTMLElement>('[data-like]').forEach((b) =>
        b.addEventListener('click', () => cb.onLikeMoment(b.dataset.like as string)),
      );
      // 换头像
      scroll.querySelectorAll<HTMLElement>('[data-avatar]').forEach((b) =>
        b.addEventListener('click', () => {
          page = 'wechat';
          wx = 'avatar';
          lastSig = '';
          paint(save);
        }),
      );
      scroll.querySelectorAll<HTMLElement>('[data-av]').forEach((b) =>
        b.addEventListener('click', () => {
          cb.onSetAvatar(owner, b.dataset.av as string);
          wx = 'me';
          lastSig = '';
          if (lastSave) paint(lastSave);
        }),
      );
      // 发状态
      scroll.querySelectorAll<HTMLElement>('[data-status]').forEach((b) =>
        b.addEventListener('click', () => {
          page = 'wechat';
          wx = 'status';
          pickedWord = null;
          lastSig = '';
          paint(save);
        }),
      );
      scroll.querySelectorAll<HTMLElement>('[data-word]').forEach((b) => {
        b.addEventListener('click', () => {
          const [emoji, word] = (b.dataset.word as string).split('|');
          pickedWord = { emoji, word };
          scroll.querySelectorAll<HTMLElement>('[data-word]').forEach((x) => x.classList.toggle('on', x === b));
        });
      });
      scroll.querySelector<HTMLElement>('.wx-status-ok')?.addEventListener('click', () => {
        const txt = scroll.querySelector<HTMLInputElement>('.wx-status-in')?.value.trim() ?? '';
        if (!pickedWord) return;
        cb.onSetStatus(owner, { emoji: pickedWord.emoji, word: pickedWord.word, text: txt || '……', at: save.clock });
        wx = 'me';
        lastSig = '';
        if (lastSave) paint(lastSave);
      });
      scroll.querySelector<HTMLElement>('.wx-status-clear')?.addEventListener('click', () => {
        cb.onSetStatus(owner, null);
        wx = 'me';
        lastSig = '';
        if (lastSave) paint(lastSave);
      });
      // 相机
      scroll.querySelector<HTMLElement>('.wx-shoot')?.addEventListener('click', () => {
        cb.onShoot(lastPresence?.placeId ?? 'home');
        page = 'album';
        lastSig = '';
        if (lastSave) paint(lastSave);
      });
      // 朋友圈发布
      scroll.querySelector<HTMLElement>('.wx-post-btn')?.addEventListener('click', () => {
        const v = scroll.querySelector<HTMLTextAreaElement>('.wx-post-in')?.value.trim() ?? '';
        if (!v) return;
        cb.onPostMoment(v);
      });
      // 我的日记
      scroll.querySelector<HTMLElement>('.wx-diary-btn')?.addEventListener('click', () => {
        const v = scroll.querySelector<HTMLTextAreaElement>('.wx-diary-in')?.value.trim() ?? '';
        if (!v) return;
        cb.onWriteMyDiary(v);
      });
      // 我的日程
      scroll.querySelector<HTMLElement>('.wx-add')?.addEventListener('click', () => {
        const blocks = [...(save.myPlan?.blocks ?? [])];
        const last = blocks[blocks.length - 1];
        const start = last ? Math.min(23, Math.round(last.end)) : 9;
        blocks.push({ start, end: Math.min(24, start + 2), placeId: 'walk', kind: 'want', label: '做点什么' });
        cb.onSaveMyPlan(blocks);
      });
      scroll.querySelector<HTMLElement>('.wx-save-plan')?.addEventListener('click', () => {
        const rows = [...scroll.querySelectorAll<HTMLElement>('.sc-edit')];
        const blocks: PlanBlock[] = rows.map((r) => {
          const times = [...r.querySelectorAll<HTMLInputElement>('.sc-in-time')].map((i) => toHours(i.value));
          const text = r.querySelector<HTMLInputElement>('.sc-in-text')?.value.trim() || '待着';
          const s = times[0];
          const e = times[1];
          return { start: s, end: Math.max(s + 0.5, e), placeId: 'walk', kind: 'want', label: text };
        });
        cb.onSaveMyPlan(blocks);
      });
      scroll.querySelectorAll<HTMLElement>('[data-del]').forEach((b) =>
        b.addEventListener('click', () => {
          const blocks = [...(save.myPlan?.blocks ?? [])];
          blocks.splice(Number(b.dataset.del), 1);
          cb.onSaveMyPlan(blocks);
        }),
      );
      // 实体购买
      scroll.querySelector<HTMLElement>('.ph-buy-btn')?.addEventListener('click', () => {
        if (cb.onBuyPhysical()) {
          lastSig = '';
          if (lastSave) paint(lastSave);
        }
      });
    }

    function paint(save: SaveData): void {
      clockEl.textContent = formatClock(save.clock);
      const inWechatTab = page === 'wechat' && WX_TABS.includes(wx);
      tabs.hidden = !inWechatTab;
      appbar.hidden = page === 'home';
      titleEl.textContent = TITLES[wx] ?? TITLES[page] ?? '';
      foot.hidden = !(page === 'wechat' && wx === 'chat' && canSend(chatId));
      // 聊天页：重绘前记住"是否本来就贴着底部"，重绘后按需滚到底（不打断玩家上翻看历史）
      const chatView = page === 'wechat' && wx === 'chat';
      const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 56;
      scroll.innerHTML = bodyFor(save);
      bindBody(save);
      if (chatView && nearBottom) scroll.scrollTop = scroll.scrollHeight;
      tabs.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === wx));
      let un = totalUnread(save);
      // 阶段 0 + 好友申请待处理 → 通讯录 tab 强制显示红点
      const openingPending = save.metPeople.find((p) => p.id === 'her-opening' && !p.added);
      if (openingPending) un = Math.max(un, 1);
      dot.hidden = un === 0;
    }

    function openChat(contactId: string): void {
      chatId = contactId;
      page = 'wechat';
      wx = 'chat';
      if (owner === 'me' && contactId === 'her') unreadReal = 0;
      cb.onReadThread(owner, contactId);
      lastSig = '';
      if (lastSave) paint(lastSave);
      scroll.scrollTop = scroll.scrollHeight; // 进入聊天直接看到最新
      if (canSend(contactId)) window.setTimeout(() => input.focus(), 60);
    }

    // 返回：微信子页 → 微信 tab → 主屏
    const back = (): void => {
      if (page === 'wechat') {
        if (WX_TABS.includes(wx)) {
          page = 'home';
        } else {
          wx = lastWx;
        }
      } else {
        page = 'home';
      }
      lastSig = '';
      if (lastSave) paint(lastSave);
    };
    panel.querySelector<HTMLElement>('.wx-back')!.addEventListener('click', back);

    const send = (): void => {
      const v = input.value.trim();
      if (!v || !chatId) return;
      input.value = '';
      cb.onSend(v);
    };
    panel.querySelector<HTMLElement>('.wx-send')!.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    });

    return {
      onShow() {
        page = 'home';
        wx = 'chats';
        lastWx = 'chats';
        chatId = null;
        lastSig = '';
        if (lastSave) paint(lastSave);
      },
      openContacts() {
        page = 'wechat';
        wx = 'contacts';
        lastWx = 'contacts';
        lastSig = '';
        if (lastSave) paint(lastSave);
      },
      refresh(save) {
        const sig = sigFor(save);
        if (sig === lastSig) {
          clockEl.textContent = formatClock(save.clock);
          return;
        }
        lastSig = sig;
        paint(save);
      },
      notifyHerMsg() {
        const viewing = open === 'myphone' && page === 'wechat' && wx === 'chat' && chatId === 'her';
        if (viewing) return;
        unreadReal += 1;
        lastSig = '';
        if (lastSave) paint(lastSave);
      },
      openChat,
    };
  }

  const phones = {
    her: createPhone('her'),
    me: createPhone('me'),
  };

  function renderShop(save: SaveData): void {
    const grid = $<HTMLDivElement>('shop-grid');
    const owned = new Set(save.ownedAccessories);
    const equipped = new Set(save.equippedAccessories);
    grid.innerHTML = ACCESSORIES.map((a) => {
      const isOwned = owned.has(a.id);
      const isOn = equipped.has(a.id);
      const canAfford = save.coins >= a.price;
      const btn = isOwned
        ? `<button class="buy ${isOn ? 'on' : ''}" data-equip="${a.id}">${isOn ? '取下' : '戴上'}</button>`
        : `<button class="buy buy-buy" data-buy="${a.id}" ${canAfford ? '' : 'disabled'}>${a.price} 金币</button>`;
      return `<div class="shop-item ${isOwned ? 'owned' : ''}">
        <div class="si-thumb">${a.emoji}</div>
        <div class="si-body">
          <div class="si-name">${a.name}<span class="si-slot">${SLOT_LABEL[a.slot]}</span></div>
          <div class="si-desc">${a.desc}</div>
        </div>
        ${btn}
      </div>`;
    }).join('');
    grid.querySelectorAll<HTMLElement>('[data-buy]').forEach((b) =>
      b.addEventListener('click', () => cb.onBuyAccessory(b.dataset.buy as string)),
    );
    grid.querySelectorAll<HTMLElement>('[data-equip]').forEach((b) =>
      b.addEventListener('click', () => cb.onEquipAccessory(b.dataset.equip as string)),
    );
  }

  /** 大地图：把地点画成一张小地图，并列出"她此刻在哪"与可打工的活。 */
  function renderMap(save: SaveData): void {
    const here = lastPresence?.placeId ?? 'home';
    const t = pronoun(save.character.personality.gender);
    $<HTMLElement>('map-status').textContent = lastPresence?.away
      ? `${t}现在在「${lastPresence.placeName}」，${lastPresence.line}。`
      : `${t}现在在家。`;
    drawMapCanvas(here);

    $<HTMLUListElement>('place-list').innerHTML = PLACES.map(
      (pl) =>
        `<li class="${pl.id === here ? 'here' : ''}">
          <span class="pl-e">${pl.emoji}</span>
          <span class="pl-n">${pl.name}${pl.id === here ? `<i>· ${t}在这</i>` : ''}</span>
          <span class="pl-d">${pl.desc}</span>
        </li>`,
    ).join('');

    const working = lastPresence?.working ?? false;
    const weekday = new Date().getDay();
    const jl = $<HTMLDivElement>('job-list');
    jl.innerHTML = JOBS.map((j) => {
      const opened = isJobOpen(j, save.clock % 24, weekday);
      const disabled = working || !opened;
      const label = working ? '打工中…' : opened ? '去打工' : '已打烊';
      return `<div class="job-item ${opened ? '' : 'closed'}">
          <span class="job-e">${j.emoji}</span>
          <div class="job-b"><div class="job-n">${j.name}${opened ? '' : '<i class="job-off">打烊了</i>'}</div><div class="job-d">${j.desc} · ${j.seconds}s / +${j.pay}金币<br>营业时间 ${jobHoursText(j)}</div></div>
          <button class="buy buy-buy" data-job="${j.id}" ${disabled ? 'disabled' : ''}>${label}</button>
        </div>`;
    }).join('');
    jl.querySelectorAll<HTMLElement>('[data-job]').forEach((b) =>
      b.addEventListener('click', () => cb.onStartJob(b.dataset.job as string)),
    );
  }

  function drawMapCanvas(here: string): void {
    const c = $<HTMLCanvasElement>('map-canvas');
    const w = c.clientWidth || 340;
    const h = Math.round(w * 0.6);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.height = `${h}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#243447');
    g.addColorStop(1, '#1b2430');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo((w * i) / 6, 0);
      ctx.lineTo((w * i) / 6, h);
      ctx.stroke();
    }
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (h * i) / 4);
      ctx.lineTo(w, (h * i) / 4);
      ctx.stroke();
    }

    // 路：都从小屋连出去
    const home = PLACES.find((p) => p.id === 'home')!;
    ctx.strokeStyle = 'rgba(232,168,124,0.3)';
    ctx.lineWidth = 2;
    for (const p of PLACES) {
      if (p.id === 'home') continue;
      ctx.beginPath();
      ctx.moveTo(home.mx * w, home.my * h);
      ctx.lineTo(p.mx * w, p.my * h);
      ctx.stroke();
    }

    // 地点
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of PLACES) {
      const x = p.mx * w;
      const y = p.my * h;
      const active = p.id === here;
      if (active) {
        ctx.beginPath();
        ctx.arc(x, y, 17, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(232,168,124,0.3)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#e8a87c' : 'rgba(255,255,255,0.15)';
      ctx.fill();
      ctx.strokeStyle = active ? '#fff8ef' : 'rgba(255,255,255,0.32)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = '13px sans-serif';
      ctx.fillText(p.emoji, x, y + 0.5);
      ctx.font = '10px sans-serif';
      ctx.fillStyle = active ? '#ffd9b8' : 'rgba(255,255,255,0.62)';
      ctx.fillText(p.name, x, y + 23);
    }
  }

  return ui;
}
