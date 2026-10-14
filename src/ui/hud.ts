import { ACTIVITIES, GIFTS } from '../core/interaction';
import { diaryFor, formatClock, memoriesFor, momentsFor, photosFor, threadFor } from '../core/store';
import { pronoun } from '../core/gender';
import type { TouchKind } from '../core/interaction';
import { PROFILES } from '../core/profile';
import { ACCESSORIES, SLOT_LABEL } from '../core/shop';
import {
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
import type { ChatMsg, Contact, DialogueTurn, PlanBlock, PlayerGender, SaveData } from '../core/types';
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
  get openPanelName(): PanelName | null;
  /** 她在哪 / 是否出门 */
  setPresence(p: PresenceInfo): void;
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
            <span class="chip-mini" id="chip-aff">亲密 0</span>
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
            <span>她的手机</span>
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
              <div class="meter"><span class="k">亲密</span><div class="bar warm"><i id="ui-aff-bar"></i></div><span class="v" id="ui-aff-v">0</span></div>
            </div>
            <div class="rows">
              <div class="row"><span>正在做</span><b id="ui-activity">—</b></div>
              <div class="row"><span>房间</span><b id="ui-tidy">—</b></div>
              <div class="row"><span>天气</span><b id="ui-weather">—</b></div>
            </div>
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
            <p class="hint">存档（记忆、亲密、房间、时间）存在本机浏览器；只有对话内容会发给云端模型生成回复。</p>
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
  let lastCoins = -1;
  let lastGender = '';
  let lastPresence: PresenceInfo | null = null;
  let lastPresenceKey = '';
  /** 时间输入框被用户改过：改过就不要再被时钟回写覆盖，直到点"设定/同步" */
  let timeDirty = false;

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

  // ── 实现接口 ────────────────────────────
  const ui: UI = {
    get openPanelName() {
      return open;
    },

    openPanel(name: PanelName | null) {
      open = name;
      root.querySelectorAll<HTMLElement>('.panel[data-panel]').forEach((p) => {
        p.hidden = p.dataset.panel !== name;
      });
      root.querySelectorAll<HTMLElement>('.drawer-item').forEach((b) => {
        b.classList.toggle('on', b.dataset.panel === name);
      });
      if (name === 'chat') input.focus();
      if (name === 'memory' && lastSave) renderMemories(lastSave);
      if (name === 'shop' && lastSave) {
        lastShopKey = '';
        renderShop(lastSave);
      }
      if (name === 'map' && lastSave) renderMap(lastSave);
      if (name === 'phone') phones.her.onShow();
      if (name === 'myphone') phones.me.onShow();
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
      }
      const clockText = formatClock(save.clock);
      if (clockText !== lastClockText) {
        lastClockText = clockText;
        $<HTMLSpanElement>('ui-clock').textContent = clockText;
      }
      $<HTMLSpanElement>('ui-phase').textContent = PHASE_LABEL[c.phase] ?? c.phase;
      $<HTMLSpanElement>('ui-mood').textContent = MOOD_LABEL[c.mood] ?? c.mood;
      $<HTMLSpanElement>('chip-aff').textContent = `亲密 ${Math.round(c.affinity)}`;
      $<HTMLSpanElement>('chip-energy').textContent = `精力 ${Math.round(c.energyValue)}`;

      $<HTMLElement>('ui-mood-bar').style.width = `${c.moodValue}%`;
      $<HTMLElement>('ui-energy-bar').style.width = `${c.energyValue}%`;
      $<HTMLElement>('ui-aff-bar').style.width = `${c.affinity}%`;
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
      // 金币显示
      const coins = Math.round(save.coins);
      if (coins !== lastCoins) {
        lastCoins = coins;
        $<HTMLSpanElement>('chip-coins').textContent = `金币 ${coins}`;
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

  // ── 手机：微信 ──────────────────────────
  const MOMENT_KIND: Record<string, string> = {
    outing: '出门了',
    diary: '日记',
    gift: '收到了礼物',
    event: '日常',
    mine: '我发的',
  };

  /** 每个地点的"照片"配色（不依赖生图，纯 CSS 渐变拼出来的照片卡） */
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
    walk: ['#7d8f9c', '#c2ccd4', '🚶'],
  };

  function presenceEmoji(): string {
    return lastPresence?.emoji ?? '🏠';
  }

  const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  void WEEKDAY_CN;

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  }

  /** 通讯录：她的 / 我的 —— 在 createPhone 内按 owner 取 */

  type PhonePage = 'chats' | 'contacts' | 'discover' | 'me' | 'chat' | 'moments' | 'album' | 'diary' | 'schedule';

  interface PhoneCtl {
    onShow(): void;
    refresh(save: SaveData): void;
    notifyHerMsg(): void;
    openChat(contactId: string): void;
  }

  /**
   * 一台手机。owner='her' → 她的手机（她联系别人，你只能看）；
   * owner='me' → 我的手机（我发消息 / 写日记 / 排日程 / 发朋友圈，她会回复）。
   * 两台共用同一套微信布局：微信 / 通讯录 / 发现 / 我。
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
            <button data-tab="chats" class="on"><span>💬</span><em>微信</em><i class="wx-dot" hidden></i></button>
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

    let page: PhonePage = 'chats';
    /** 记住从哪个 tab 进来的，返回时回到那里（微信的行为） */
    let lastTab: PhonePage = 'chats';
    let chatId: string | null = null;
    let unreadReal = 0;
    let lastSig = '';

    /** 这台手机的通讯录 */
    function contactsOf(save: SaveData): Contact[] {
      if (owner === 'me') return myContacts(save.character.personality.name);
      const p = PROFILES.find((x) => x.id === save.profileId) ?? PROFILES[0];
      return herContacts(p.life, save.playerName);
    }

    const SUB_PAGES: PhonePage[] = ['chat', 'moments', 'album', 'diary', 'schedule'];
    const TITLES: Partial<Record<PhonePage, string>> = {
      chat: '聊天',
      moments: '朋友圈',
      album: '相册',
      diary: owner === 'me' ? '我的日记' : '日记',
      schedule: owner === 'me' ? '我的日程' : 'TA 的日程',
    };

    /** 共享会话 vs 各自的 NPC 会话 */
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
      // 同一台手机内：'owner' 是机主；跨手机镜像查看时，'her' 才是机主（她）
      return tOwner === owner ? msg.from === 'owner' : msg.from === 'her';
    }

    function canSend(contactId: string | null): boolean {
      return owner === 'me' && contactId === 'her';
    }

    function unreadOf(save: SaveData, contactId: string): number {
      if (canSendForRead(contactId)) return unreadReal;
      const th = threadFor(save, owner, contactId);
      return th?.unread ?? 0;
    }
    /** 只有"我 → 她"这段真实对话用 UI 侧未读 */
    function canSendForRead(contactId: string | null): boolean {
      return owner === 'me' && contactId === 'her';
    }

    function lastMsgOf(save: SaveData, contactId: string): ChatMsg | null {
      const { msgs } = threadOf(save, contactId);
      return msgs.length ? msgs[msgs.length - 1] : null;
    }

    function totalUnread(save: SaveData): number {
      return contactsOf(save).reduce((n, c) => n + unreadOf(save, c.id), 0);
    }

    // ── 各页内容 ─────────────────────────
    function chatsBody(save: SaveData): string {
      const cs = contactsOf(save);
      return `<div class="wx-list">${cs
        .map((c) => {
          const m = lastMsgOf(save, c.id);
          const un = unreadOf(save, c.id);
          const preview = m ? escapeHtml(m.text) : '<span class="wx-mute">还没有聊天记录</span>';
          return `<button class="wx-chat" data-chat="${c.id}">
            <span class="wx-ava">${c.emoji}</span>
            <span class="wx-cbody">
              <span class="wx-cname">${escapeHtml(c.name)}</span>
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
      const cs = contactsOf(save);
      return `<div class="wx-list">
        <div class="wx-idx">联系人</div>
        ${cs
          .map(
            (c) => `<button class="wx-contact" data-chat="${c.id}">
              <span class="wx-ava">${c.emoji}</span>
              <span class="wx-cbody"><span class="wx-cname">${escapeHtml(c.name)}</span><span class="wx-prev">${escapeHtml(c.note)}</span></span>
            </button>`,
          )
          .join('')}
      </div>`;
    }

    function discoverBody(): string {
      return `<div class="wx-list">
        <div class="wx-row" data-go="moments"><span class="wx-row-i">🌈</span><span class="wx-row-t">朋友圈</span><i class="wx-arrow">›</i></div>
        <div class="wx-row ghost"><span class="wx-row-i">📷</span><span class="wx-row-t">扫一扫</span><i class="wx-arrow">›</i></div>
        <div class="wx-row ghost"><span class="wx-row-i">🎵</span><span class="wx-row-t">听一听</span><i class="wx-arrow">›</i></div>
      </div>`;
    }

    function meBody(save: SaveData): string {
      const her = owner === 'her';
      const name = her ? save.character.personality.name : save.playerName;
      const sub = her
        ? lastPresence?.away
          ? `${lastPresence.emoji} 在${lastPresence.placeName}`
          : '🏠 在家'
        : '住在小屋';
      return `<div class="wx-list">
        <div class="wx-me">
          <span class="wx-ava big">${her ? presenceEmoji() : '🧑'}</span>
          <span class="wx-cbody"><span class="wx-cname">${escapeHtml(name)}</span><span class="wx-prev">${escapeHtml(sub)}</span></span>
        </div>
        <div class="wx-row" data-go="album"><span class="wx-row-i">🖼️</span><span class="wx-row-t">相册</span><i class="wx-arrow">›</i></div>
        <div class="wx-row" data-go="diary"><span class="wx-row-i">📖</span><span class="wx-row-t">${her ? '日记' : '写日记'}</span><i class="wx-arrow">›</i></div>
        <div class="wx-row" data-go="schedule"><span class="wx-row-i">🗓️</span><span class="wx-row-t">${her ? '日程' : '排日程'}</span><i class="wx-arrow">›</i></div>
      </div>`;
    }

    function chatBody(save: SaveData, contactId: string): string {
      const { msgs, tOwner } = threadOf(save, contactId);
      const cs = contactsOf(save);
      const c = cs.find((x) => x.id === contactId);
      const head = `<div class="wx-chat-note">${escapeHtml(c?.note ?? '')}</div>`;
      if (!msgs.length) {
        return head + `<p class="ph-empty">${owner === 'me' ? '还没有聊过，说点什么吧。' : '还没有聊天记录。'}</p>`;
      }
      return (
        head +
        msgs
          .map(
            (m) =>
              `<div class="wx-line ${isMineMsg(m, tOwner) ? 'mine' : ''}">
                ${isMineMsg(m, tOwner) ? '' : `<span class="wx-mini">${owner === 'her' && c && m.from === 'me' ? '🧑' : c?.emoji ?? ''}</span>`}
                <span class="wx-bub">${escapeHtml(m.text)}</span>
              </div>`,
          )
          .join('')
      );
    }

    function momentsBody(save: SaveData): string {
      const list = [...momentsFor(save)].reverse().slice(0, 30);
      const post = owner === 'me'
        ? `<div class="wx-post">
             <textarea class="wx-post-in" rows="2" placeholder="这一刻的想法…"></textarea>
             <button class="wx-post-btn">发表</button>
           </div>`
        : '';
      const feed = list
        .map((m) => {
          const author = m.author === 'me' ? save.playerName : save.character.personality.name;
          const avatar = m.author === 'me' ? '🧑' : m.placeId ? getPlace(m.placeId).emoji : '🌙';
          const where = m.placeId ? getPlace(m.placeId).name : '';
          const comments = m.comments
            .map((cm) => `<div class="mo-cmt"><b>${escapeHtml(cm.name)}</b>${escapeHtml(cm.text)}</div>`)
            .join('');
          return `<article class="mo">
            <div class="mo-head">
              <span class="mo-ava">${avatar}</span>
              <div class="mo-who"><b>${escapeHtml(author)}</b><span>${hm(m.at)}${where ? ` · ${where}` : ''}</span></div>
            </div>
            <p class="mo-text">${escapeHtml(m.text)}</p>
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
      if (!list.length) return '<p class="ph-empty">相册还是空的。</p>';
      return `<div class="ph-album">${list
        .map((p) => {
          const pl = getPlace(p.placeId);
          const [a, b, icon] = PLACE_ART[p.placeId] ?? PLACE_ART.walk;
          return `<figure class="ph-photo">
            <div class="pp-art" style="background:linear-gradient(160deg,${a},${b})"><span>${icon}</span></div>
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
                  .map(
                    (d) =>
                      `<div class="wx-diary-item"><span class="d-day">第 ${d.day + 1} 天</span>${escapeHtml(d.text)}</div>`,
                  )
                  .join('')
              : '<p class="ph-empty">还没写过。写下来，她会看见。</p>'
          }`;
      }
      const list = [...diaryFor(save)].reverse().slice(0, 20);
      return list
        .map(
          (d) => `<div class="wx-diary-item"><span class="d-day">第 ${d.day + 1} 天</span>${escapeHtml(d.text)}</div>`,
        )
        .join('') || '<p class="ph-empty">TA 还没写过日记。有值得记的事、或心情有波动时，才会写一笔。</p>';
    }

    function planRows(blocks: PlanBlock[], editable: boolean): string {
      return blocks
        .map((b, i) => {
          const pl = getPlace(b.placeId);
          if (!editable) {
            const nowOn = (lastSave?.clock ?? 0) % 24 >= b.start && (lastSave?.clock ?? 0) % 24 < b.end;
            const kindText = b.kind === 'commit' ? '必须去' : b.kind === 'want' ? 'TA 想去' : '';
            return `<li class="${nowOn ? 'on' : ''} ${b.kind}">
              <span class="sc-time">${hm(b.start)}</span>
              <span class="sc-e">${b.placeId === 'home' ? '🏠' : pl.emoji}</span>
              <span class="sc-b"><b>${escapeHtml(b.label)}</b>${kindText ? `<i>${kindText}</i>` : ''}</span>
              ${nowOn ? '<span class="sc-now">现在</span>' : ''}
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
        return `<p class="ph-note">排一下自己今天要做什么。她会看到你的日程，也可能拿来调侃你。</p>
          <ul class="ph-sched">${planRows(blocks, true)}</ul>
          <div class="wx-plan-actions">
            <button class="wx-add">加一条</button>
            <button class="wx-save-plan">保存</button>
          </div>`;
      }
      const plan = save.herPlan;
      const t = pronoun(save.character.personality.gender);
      if (!plan || !plan.blocks.length) return `<p class="ph-empty">${t}还没定今天要做什么。</p>`;
      return `<p class="ph-note">${escapeHtml(`${t}今天：${describePlan(plan.blocks)}`)}</p>
        <ul class="ph-sched">${planRows(plan.blocks, false)}</ul>`;
    }

    function bodyFor(save: SaveData): string {
      switch (page) {
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
        case 'album':
          return albumBody(save);
        case 'diary':
          return diaryBody(save);
        case 'schedule':
          return scheduleBody(save);
        default:
          return '';
      }
    }

    /** 便宜的变化指纹：变了才重绘，避免每帧重建 DOM */
    function sigFor(save: SaveData): string {
      const base = `${page}|${chatId ?? ''}|${save.profileId}|`;
      const cs = contactsOf(save);
      switch (page) {
        case 'chats':
          return base + cs.map((c) => `${c.id}:${unreadOf(save, c.id)}:${lastMsgOf(save, c.id)?.id ?? ''}`).join(',');
        case 'chat':
          return base + threadOf(save, chatId!).msgs.map((m) => m.id).join(',');
        case 'moments':
          return base + momentsFor(save).map((m) => `${m.id}:${m.likes}:${m.likedByMe ? 1 : 0}:${m.comments.length}`).join(',');
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
          return base + `${save.playerName}|${save.character.personality.name}`;
      }
    }

    function bindBody(save: SaveData): void {
      scroll.querySelectorAll<HTMLElement>('[data-chat]').forEach((b) =>
        b.addEventListener('click', () => openChat(b.dataset.chat as string)),
      );
      scroll.querySelectorAll<HTMLElement>('[data-go]').forEach((b) =>
        b.addEventListener('click', () => go(b.dataset.go as PhonePage)),
      );
      scroll.querySelectorAll<HTMLElement>('[data-like]').forEach((b) =>
        b.addEventListener('click', () => cb.onLikeMoment(b.dataset.like as string)),
      );
      const post = scroll.querySelector<HTMLButtonElement>('.wx-post-btn');
      const postIn = scroll.querySelector<HTMLTextAreaElement>('.wx-post-in');
      post?.addEventListener('click', () => {
        const v = postIn?.value.trim() ?? '';
        if (!v) return;
        cb.onPostMoment(v);
        if (postIn) postIn.value = '';
      });
      const dIn = scroll.querySelector<HTMLTextAreaElement>('.wx-diary-in');
      scroll.querySelector<HTMLButtonElement>('.wx-diary-btn')?.addEventListener('click', () => {
        const v = dIn?.value.trim() ?? '';
        if (!v) return;
        cb.onWriteMyDiary(v);
        if (dIn) dIn.value = '';
      });
      scroll.querySelector<HTMLButtonElement>('.wx-add')?.addEventListener('click', () => {
        const blocks = [...(save.myPlan?.blocks ?? [])];
        const last = blocks[blocks.length - 1];
        const start = last ? Math.min(23, Math.round(last.end)) : 9;
        blocks.push({ start, end: Math.min(24, start + 2), placeId: 'walk', kind: 'want', label: '做点什么' });
        cb.onSaveMyPlan(blocks);
      });
      scroll.querySelector<HTMLButtonElement>('.wx-save-plan')?.addEventListener('click', () => {
        const rows = [...scroll.querySelectorAll<HTMLElement>('.sc-edit')];
        const blocks: PlanBlock[] = rows.map((r) => {
          const times = [...r.querySelectorAll<HTMLInputElement>('.sc-in-time')].map((i) => toHours(i.value));
          const text = r.querySelector<HTMLInputElement>('.sc-in-text')?.value.trim() || '待着';
          const [s, e] = times;
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
    }

    function toHours(v: string): number {
      const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
      if (!m) return 9;
      return (Number(m[1]) % 24) + Number(m[2]) / 60;
    }

    function paint(save: SaveData): void {
      clockEl.textContent = formatClock(save.clock);
      const isTab = !SUB_PAGES.includes(page);
      tabs.hidden = !isTab;
      appbar.hidden = isTab;
      titleEl.textContent = TITLES[page] ?? (owner === 'her' ? '她的手机' : '我的手机');
      foot.hidden = !canSend(chatId);
      scroll.innerHTML = bodyFor(save);
      bindBody(save);
      tabs.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
        b.classList.toggle('on', b.dataset.tab === page),
      );
      const un = totalUnread(save);
      dot.hidden = un === 0;
    }

    function go(p: PhonePage): void {
      page = p;
      if (!SUB_PAGES.includes(p)) lastTab = p;
      if (p !== 'chat') chatId = null;
      lastSig = '';
      if (lastSave) paint(lastSave);
    }

    function openChat(contactId: string): void {
      chatId = contactId;
      page = 'chat';
      if (canSendForRead(contactId)) unreadReal = 0;
      cb.onReadThread(owner, contactId);
      lastSig = '';
      if (lastSave) paint(lastSave);
      if (canSend(contactId)) window.setTimeout(() => input.focus(), 60);
    }

    // 事件绑定
    tabs.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => go(b.dataset.tab as PhonePage)),
    );
    panel.querySelector<HTMLElement>('.wx-back')!.addEventListener('click', () => go(lastTab));
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
        page = 'chats';
        lastTab = 'chats';
        chatId = null;
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
        const viewing = open === 'myphone' && page === 'chat' && chatId === 'her';
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
          <span class="pl-n">${pl.name}${pl.id === here ? '<i>· 她在这</i>' : ''}</span>
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