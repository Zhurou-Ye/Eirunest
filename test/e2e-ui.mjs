/**
 * 简易 headless Chrome 端到端验证：截图开局与手机面板。
 * 使用 Chrome DevTools Protocol（CDP），不依赖 puppeteer/playwright。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const WebSocket = globalThis.WebSocket;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'test', 'screenshots');
mkdirSync(outDir, { recursive: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9223;
const URL = 'http://localhost:5173/';
/**
 * Chrome 的 user-data-dir 必须放在仓库外（系统临时目录）。
 * 放在仓库里会让 Vite 把 profile 里的文件当成源码监视，刷一堆无意义的 page reload。
 */
const PROFILE = join(tmpdir(), 'eirunest-e2e-profile');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 页面里抛出的未捕获异常，收尾时统一报出来 */
const pageErrors = [];

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      // 页面里抛的异常也要看见，否则只会得到一张"什么都没发生"的截图
      pageErrors.push(
        msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '未知异常',
      );
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send };
}

/**
 * 在页面里执行一段 JS。若页面抛异常，直接打印并中断 —— 避免步骤静默失败、
 * 最后只得到一张"什么都没发生"的截图。
 */
async function evalJs(send, expression, label = '', awaitPromise = false) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    const msg = d.exception?.description ?? d.text ?? JSON.stringify(d);
    throw new Error(`[evalJs] ${label} 页面抛错: ${msg}`);
  }
  return res.result?.value;
}

async function screenshot(send, file) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  await new Promise((resolve, reject) => {
    import('node:fs').then(({ writeFile }) => {
      writeFile(file, buf, (err) => (err ? reject(err) : resolve()));
    });
  });
  console.log('saved', file);
}

async function main() {
  const proc = spawn(CHROME, [
    '--headless',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${PROFILE}`,
    '--window-size=390,844',
  ], { detached: false });

  // 等 Chrome 启动。必须挑真正的页面目标：
  // 直接取 list[0] 有时会连到扩展的 popup/options 页，那样所有断言都是在别的页面上跑。
  let pageWs = null;
  let lastList = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      lastList = list;
      // 只要"页面"类型；chrome://newtab 也接受（后面会 Page.navigate 过去），
      // 但绝不能挑到扩展页 —— 之前就是因为取了 list[0]，整个测试跑在扩展的 popup 上。
      const pages = list.filter(
        (t) => t.type === 'page' && !(t.url ?? '').startsWith('chrome-extension://'),
      );
      const page = pages.find((t) => (t.url ?? '').includes('localhost')) ?? pages[0];
      if (page) {
        pageWs = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      await sleep(300);
    }
  }
  if (!pageWs) {
    console.log('可用的调试目标：', lastList ? lastList.map((t) => `${t.type}|${t.url}`).join(' , ') : '(一个都没拿到)');
    throw new Error('Chrome 没启动');
  }
  console.log('page ws', pageWs);

  const { send } = await cdp(pageWs);
  await send('Page.enable');
  await send('Runtime.enable');

  // 1. 打开页面并清空存档
  await send('Page.navigate', { url: URL });
  await sleep(2000);
  await evalJs(send, 'localStorage.clear();', 'clear-save');
  await evalJs(send, 'location.reload();', 'reload');
  await sleep(2000);

  // 2. 选人界面截图
  await screenshot(send, join(outDir, '01-boot.png'));

  // 3. 开始新游戏（立刻截图看底部对话框提示）
  const roleCount = await evalJs(send, `document.querySelectorAll('#role-list [data-role]').length`, 'probe-roles');
  console.log('role cards:', roleCount);
  await evalJs(
    send,
    `
      document.querySelector('[data-role="haru"]').click();
      setTimeout(() => { document.getElementById('btn-new').click(); }, 120);
    `,
    'start-new',
  );
  await sleep(900);
  const started = await evalJs(
    send,
    `!document.getElementById('boot') || document.getElementById('boot').classList.contains('out')`,
    'probe-started',
  );
  console.log('boot dismissed:', started);
  await screenshot(send, join(outDir, '02-main.png'));

  // 4. 打开"我的手机"
  await evalJs(
    send,
    `document.querySelector('.drawer-item[data-panel="myphone"]')?.click();`,
    'open-myphone',
  );
  await sleep(600);
  await screenshot(send, join(outDir, '03-myphone-home.png'));

  // 5. 进微信 → 通讯录 → 新的朋友
  await evalJs(
    send,
    `
      (function(){
        const panel = document.querySelector('.panel[data-panel="myphone"]');
        if (!panel) throw new Error('myphone 面板不存在');
        panel.querySelector('[data-app="wechat"]').click();
        setTimeout(() => panel.querySelector('[data-tab="contacts"]')?.click(), 120);
        setTimeout(() => panel.querySelector('[data-go="newfriends"]')?.click(), 300);
      })();
    `,
    'open-newfriends',
  );
  await sleep(1000);
  await screenshot(send, join(outDir, '04-newfriends.png'));

  // 6. 点接受 → 备注页面
  await evalJs(
    send,
    `document.querySelector('.panel[data-panel="myphone"] [data-accept]')?.click();`,
    'accept',
  );
  await sleep(700);
  await screenshot(send, join(outDir, '05-remark.png'));

  // 7. 完成备注 → 点进 Haru 聊天
  await evalJs(
    send,
    `
      (function(){
        const panel = document.querySelector('.panel[data-panel="myphone"]');
        const inp = panel.querySelector('.wx-remark-in');
        if (inp) inp.value = '小遥';
        panel.querySelector('[data-remark-done]')?.click();
        setTimeout(() => panel.querySelector('[data-chat="her"]')?.click(), 250);
      })();
    `,
    'finish-remark',
  );
  await sleep(1400);
  await screenshot(send, join(outDir, '06-chat.png'));

  /**
   * 发一句话，并确认**她真的收到了**。
   * `sendToModel` 有个闸门：她还在回上一条时，新消息会被**静默丢弃**
   * （连我发的那句都不进聊天记录）。不确认就判定，测出来的"关系没动"是假象。
   */
  async function sendChat(text) {
    const countMine = `(function(){
      const d = JSON.parse(localStorage.getItem('hearth-boy.save.v1'));
      const th = (d.threads || []).find((t) => t.owner === 'me' && t.contactId === 'her');
      return (th && th.msgs || []).filter((m) => m.from === 'owner').length;
    })()`;
    for (let i = 0; i < 6; i += 1) {
      const n0 = Number(await evalJs(send, countMine, 'count-before'));
      await evalJs(
        send,
        `(function(){
          const p = document.querySelector('.panel[data-panel="myphone"]');
          const inp = p.querySelector('.wx-input');
          inp.value = ${JSON.stringify(text)};
          p.querySelector('.wx-send').click();
        })()`,
        'send-chat',
      );
      await sleep(2800);
      const n1 = Number(await evalJs(send, countMine, 'count-after'));
      if (n1 > n0) return n1 - n0;
    }
    throw new Error(`消息发不出去（试了 6 次）：${text}`);
  }

  const affNow = () =>
    evalJs(
      send,
      `String(JSON.parse(localStorage.getItem('hearth-boy.save.v1')).character.affinity)`,
      'aff-now',
    );

  /**
   * 等关系值发生变化。
   * 不能只 sleep 固定时长：模型那一步可能挂在网络请求上（云端不可用时尤其慢），
   * 回复没回来之前，引擎根本还没改关系。轮询才稳。
   */
  async function waitAffinityChange(from, timeoutMs = 40000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const raw = await affNow();
      if (raw === 'null' || raw === 'NaN') {
        throw new Error(`关系值变成了非数字（${raw}）—— 存档被污染，多半是 undefined 参与了运算`);
      }
      if (Number(raw) !== from) return Number(raw);
      await sleep(1200);
    }
    return Number(await affNow());
  }

  const seedAffinity = (v) =>
    evalJs(
      send,
      `(function(){
        window.game.store.update((d) => { d.character.affinity = ${v}; });
        window.game.store.save();
      })()`,
      'seed-affinity',
    );

  // 探针：确认浏览器加载的 mapping.ts 真的带上了新字段。
  // 如果这里没有 affinityDelta，说明页面跑的是旧模块，后面所有断言都没意义。
  const mapProbe = await evalJs(
    send,
    `import('/src/ai/mapping.ts').then((m) => {
      const r = m.sanitizeIntent({ line: '嗯', emotion: 'calm', action: 'idle', affinityDelta: 3 }, 'x', 'calm', 'idle');
      return JSON.stringify({ keys: Object.keys(r.intent), delta: r.intent.affinityDelta });
    })`,
    'mapping-probe',
    true,
  );
  console.log('mapping 探针:', mapProbe);
  if (!JSON.parse(mapProbe).keys.includes('affinityDelta')) {
    throw new Error('浏览器加载的 mapping.ts 还是旧版（没有 affinityDelta），e2e 结果不可信');
  }

  // 7a. 好好聊天，关系要涨 —— 否则"陪伴"就退化成一台只会自己说话的单机打字机。
  const affBefore = Number(await affNow());
  const sentCount = await sendChat('今天在做什么呀');
  const tGood = Date.now();
  const affAfterGood = await waitAffinityChange(affBefore, 40000);
  console.log(
    '打字一轮后: 关系',
    affBefore,
    '→',
    affAfterGood,
    '| 本轮新增我方消息',
    sentCount,
    `| 等回复用了 ${Date.now() - tGood}ms`,
  );
  if (!(affAfterGood > affBefore)) {
    const logDump = await evalJs(
      send,
      `(document.getElementById('ui-log')?.textContent || '').split('\\n').slice(-6).join(' | ')`,
      'log-dump',
    );
    console.log('UI 日志:', logDump);
    throw new Error(`好好聊天关系却没涨（${affBefore} → ${affAfterGood}）`);
  }

  // 7a2. 关系必须能**降**：涨跌由她自己决定，她不该无底线地对你好。
  //      垫到一个不为 0、又**低于调试档坦白阈值**的值 ——
  //      高于阈值会把坦白剧情弹出来，后面的界面步骤全乱。
  await seedAffinity(8);
  const beforeRude = Number(await affNow());
  await sendChat('你好烦啊，闭嘴');
  const afterRude = await waitAffinityChange(beforeRude, 40000);
  console.log('说了难听话之后: 关系', beforeRude, '→', afterRude);
  if (!(afterRude < beforeRude)) {
    const dump = await evalJs(
      send,
      `(function(){
        const d = JSON.parse(localStorage.getItem('hearth-boy.save.v1'));
        const th = (d.threads || []).find((t) => t.owner === 'me' && t.contactId === 'her');
        const mine = (th && th.msgs || []).filter((m) => m.from === 'owner').slice(-3);
        const hers = (th && th.msgs || []).filter((m) => m.from === 'her').slice(-2);
        return JSON.stringify({ mine: mine.map((m) => m.text), hers: hers.map((m) => m.text) });
      })()`,
      'dump-chat',
    );
    console.log('聊天记录:', dump);
    throw new Error(
      `说了难听话关系却没掉（${beforeRude} → ${afterRude}）—— 她对什么都照单全收，等于没有自己的判断`,
    );
  }
  await seedAffinity(8); // 恢复（压在阈值以下，别把剧情弹出来）

  // 7a3. 离线规则表本身：好话给正分、难听话给负分。
  //      没有模型时她就是靠这张表"感受"的，所以它自己得是对的。
  const bondRaw = await evalJs(
    send,
    `import('/src/ai/offline.ts').then((m) => {
      const s = window.game.store.state;
      const one = (t) => m.offlineReply(s, t).affinityDelta;
      return JSON.stringify({ normal: one('今天在做什么呀'), rude: one('你好烦啊，闭嘴'), night: one('晚安') });
    })`,
    'bond-table',
    true,
  );
  console.log('离线感受值:', bondRaw);
  {
    const bond = JSON.parse(bondRaw);
    if (!(bond.normal > 0)) throw new Error(`普通寒暄该给正分，实际 ${bond.normal}`);
    if (!(bond.rude < 0)) throw new Error(`难听话该给负分，实际 ${bond.rude}`);
    if (!(bond.night > bond.normal)) throw new Error(`"晚安"该比普通寒暄更打动她（${bond.night} vs ${bond.normal}）`);
  }

  // 7b. 图片消息：她发来的图应该像真人微信那样，是**留在聊天记录里的一条消息** ——
  //     往上翻还在、点开能放大，而不是弹一次就消失的弹窗。
  await evalJs(
    send,
    `(function(){
      window.game.store.addChatMsg('me', 'her', 'her', '', false, '/map/eislan.jpg');
      window.game.store.save();
    })()`,
    'add-image-msg',
  );
  await sleep(500);
  // 滚到底，让图片进可视区（截图才有意义）
  await evalJs(
    send,
    `document.querySelector('.panel[data-panel="myphone"] .wx-scroll')?.scrollTo(0, 99999);`,
    'scroll-to-image',
  );
  await sleep(500);
  const chatImgRaw = await evalJs(
    send,
    `(function(){
      const img = document.querySelector('.panel[data-panel="myphone"] .wx-img');
      if (!img) return JSON.stringify({ ok: false, why: '聊天记录里没有图片消息' });
      return JSON.stringify({ ok: true, src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight });
    })()`,
    'chat-image',
  );
  console.log('聊天里的图片消息:', chatImgRaw);
  const chatImg = JSON.parse(chatImgRaw);
  if (!chatImg.ok) throw new Error(`图片没有成为一条聊天消息：${chatImg.why}`);
  if (chatImg.src !== '/map/eislan.jpg') throw new Error(`图片 src 不对：${chatImg.src}`);
  if (!chatImg.w || !chatImg.h) throw new Error(`聊天里的图片没加载出来（naturalWidth=${chatImg.w}）`);
  await screenshot(send, join(outDir, '06b-chat-image.png'));

  // 7c. 点开 → 放大
  await evalJs(
    send,
    `document.querySelector('.panel[data-panel="myphone"] .wx-img').click();`,
    'zoom-image',
  );
  await sleep(500);
  const viewerRaw = await evalJs(
    send,
    `(function(){
      const img = document.querySelector('.img-viewer .story-map-img');
      if (!img) return JSON.stringify({ ok: false, why: '点开没有出现看图器' });
      return JSON.stringify({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
    })()`,
    'image-viewer',
  );
  console.log('点开后的看图器:', viewerRaw);
  const viewer = JSON.parse(viewerRaw);
  if (!viewer.ok) throw new Error(`图片点不开：${viewer.why}`);
  if (!viewer.w) throw new Error('看图器里的图没加载出来');
  await screenshot(send, join(outDir, '06c-image-zoom.png'));
  await evalJs(send, `document.querySelector('.img-viewer .story-mono-ok')?.click();`, 'close-viewer');

  // 7d. "一直在那个地方"的直接证据：图片被写进了存档，刷新也不会消失
  const persistedRaw = await evalJs(
    send,
    `(function(){
      const d = JSON.parse(localStorage.getItem('hearth-boy.save.v1'));
      const th = (d.threads || []).find((t) => t.owner === 'me' && t.contactId === 'her');
      const m = (th && th.msgs || []).find((x) => x.image);
      return JSON.stringify({ found: !!m, image: m ? m.image : null });
    })()`,
    'image-persisted',
  );
  console.log('图片写进存档:', persistedRaw);
  if (!JSON.parse(persistedRaw).found) throw new Error('图片消息没有写进存档，刷新后就没了');

  // 8. 打开状态面板看关系进度
  await evalJs(
    send,
    `document.querySelector('.drawer-item[data-panel="status"]')?.click();`,
    'open-status',
  );
  await sleep(700);
  await screenshot(send, join(outDir, '07-status.png'));

  // 先把页面里抛过的异常报出来，再做断言——不然断言先抛，异常信息就永远看不到了
  if (pageErrors.length) {
    console.log('\n页面抛出了异常：');
    for (const e of pageErrors) console.log('  -', String(e).split('\n').slice(0, 4).join('\n     '));
    const dbg = await evalJs(
      send,
      `(function(){const s=localStorage.getItem('hearth-boy.save.v1');const d=s?JSON.parse(s):null;
        return JSON.stringify({hasSave:!!d, traits:d&&d.character&&d.character.traits, histLen:d&&d.traitHistory&&d.traitHistory.length, preset:d&&d.character&&d.character.personality&&d.character.personality.preset});})()`,
      'debug-traits',
    );
    console.log('存档里的 traits:', dbg);
  }

  // 9. 人格倾向面板必须真的渲染出来 —— 这是"她会被经历改写"在界面上的证据
  const traitHtml = await evalJs(
    send,
    `document.getElementById('trait-panel')?.innerHTML ?? ''`,
    'trait-panel',
  );
  const hasTraits = traitHtml.includes('表达欲') && traitHtml.includes('戒备心');
  console.log('人格倾向面板渲染:', hasTraits ? `是（${traitHtml.length} 字符）` : '否');
  if (!hasTraits) throw new Error('人格倾向面板没有渲染出来');

  // 10. 离线重放：把存档时间往回拨 5 小时再重载，
  //     验证"你不在时她去过哪"会被补记成真实的照片与朋友圈，而不是只结算数值。
  //
  // 注意：location.reload() 只是**安排**导航，旧页面还会继续跑一会儿，
  // 而游戏每秒自动存档一次，会把内存状态写回 localStorage，把我们的改动冲掉。
  // 所以写入之后立刻把 setItem 变成空操作，让值活到重载完成
  // （新文档会拿到全新的 Storage.prototype，不受影响）。
  await evalJs(
    send,
    `
      (function(){
        const k = 'hearth-boy.save.v1';
        const d = JSON.parse(localStorage.getItem(k));
        d.character.lastSavedAt = Date.now() - 5 * 3600 * 1000;
        d.photos = [];
        d.moments = (d.moments || []).filter((m) => m.kind !== 'outing');
        d.traitHistory = [];
        // 固定一份日程，让"离线重放"这件事在测试里是确定性的：
        // 把一段"出门去公园"的行程放进缺席窗口内。
        const c = d.clock;
        const a = Math.max(0.5, c - 5);
        const b = Math.max(a + 1, c - 3);
        d.herPlan = {
          day: Math.floor(c / 24),
          profileId: d.profileId,
          blocks: [
            { start: 0, end: a, placeId: 'home', kind: 'rest', label: '在家' },
            { start: a, end: b, placeId: 'park', kind: 'want', label: '去河滨公园走走' },
            { start: b, end: 24, placeId: 'home', kind: 'rest', label: '在家待着' },
          ],
        };
        const origSet = Storage.prototype.setItem;
        origSet.call(localStorage, k, JSON.stringify(d));
        Storage.prototype.setItem = function () {};
        location.reload();
      })();
    `,
    'rewind-and-reload',
  );
  await sleep(2600);
  // 有存档时会停在"继续上次的日常"，点掉它才能看到完整界面
  await evalJs(send, `document.getElementById('btn-continue')?.click();`, 'continue');
  await sleep(900);

  const offline = await evalJs(
    send,
    `(function(){
      const d = JSON.parse(localStorage.getItem('hearth-boy.save.v1'));
      const logEl = document.getElementById('ui-log');
      return JSON.stringify({
        photos: (d.photos || []).length,
        outings: (d.moments || []).filter((m) => m.kind === 'outing').length,
        hist: (d.traitHistory || []).length,
        clock: Math.round(d.clock * 100) / 100,
        hoursAwayHint: Math.round((Date.now() - d.character.lastSavedAt) / 3600000 * 10) / 10,
        planBlocks: d.herPlan ? d.herPlan.blocks.length : 0,
        planPlaces: d.herPlan ? [...new Set(d.herPlan.blocks.map((b) => b.placeId))].join('+') : '',
        blockRanges: d.herPlan ? d.herPlan.blocks.map((b) => b.start + '-' + b.end + ':' + b.placeId).join(',') : '',
        // 注意用 textContent：innerText 对隐藏元素返回空串，会误判成"没写日志"
        log: (logEl ? logEl.textContent : '').split('\\n').filter((l) => l.includes('小时')).slice(-1)[0] || '',
      });
    })()`,
    'offline-result',
  );
  console.log('离线重放结果:', offline);
  await screenshot(send, join(outDir, '08-offline.png'));

  const off = JSON.parse(offline);
  // 断言看数据，不看日志文本：日志只保留最近 4 条，很容易被后续日志顶掉
  if (off.photos < 1) throw new Error(`离线期间没有补记照片（photos=${off.photos}）`);
  if (off.outings < 1) throw new Error(`离线期间没有补记朋友圈（outings=${off.outings}）`);
  if (off.hist < 1) throw new Error('离线重放没有写进 traits 回溯史');
  if (off.log.includes('一直在等你')) throw new Error('还在用"她一直在等你"的旧文案');

  // 11. 男性角色：Natori 是男性立绘，界面上不能出现"她"
  await evalJs(send, 'location.reload();', 'reload-male');
  await sleep(2600);
  await evalJs(send, `document.querySelector('[data-role="natori"]').click();`, 'pick-natori');
  await sleep(250);
  await evalJs(send, `document.getElementById('btn-new').click();`, 'start-natori');
  await sleep(1400);

  const maleRaw = await evalJs(
    send,
    `(function(){
      const d = JSON.parse(localStorage.getItem('hearth-boy.save.v1'));
      return JSON.stringify({
        gender: d.character.personality.gender,
        drawer: document.getElementById('drawer-phone-label')?.textContent ?? '',
        status: document.getElementById('status-title')?.textContent ?? '',
        memory: document.getElementById('memory-label')?.textContent ?? '',
      });
    })()`,
    'male-labels',
  );
  const male = JSON.parse(maleRaw);
  console.log('男性角色界面:', maleRaw);
  if (male.gender !== 'male') throw new Error(`Natori 的性别应为 male，实际为 ${male.gender}`);
  if (male.drawer !== '他的手机') throw new Error(`抽屉标签应为「他的手机」，实际为「${male.drawer}」`);
  if (male.status !== '他的状态') throw new Error(`状态面板标题应为「他的状态」，实际为「${male.status}」`);
  if (male.memory !== '他记得的事') throw new Error(`记忆面板标题应为「他记得的事」，实际为「${male.memory}」`);
  await screenshot(send, join(outDir, '09-male-character.png'));

  // 12. 女巫必须是"会被遇到的人"：既在 PLACE_PEOPLE 表里，也在每种性格的出行偏好里。
  //     少任何一边，她就只是个地点 + 一份打工 + 一句台词，玩家永远认识不到这个人。
  const witchRaw = await evalJs(
    send,
    `import('/src/core/world.ts').then((m) => JSON.stringify({
      name: m.personAt('witch-workshop')?.name ?? null,
      greet: !!m.personAt('witch-workshop')?.greet,
      inPools: ['sunny', 'gentle', 'cool', 'clingy'].filter((p) =>
        (m.WANT_POOL[p] ?? []).some((w) => w.placeId === 'witch-workshop')).length,
      status: Array.isArray(m.PLACE_STATUS['witch-workshop']),
    }))`,
    'witch-check',
    true,
  );
  const witch = JSON.parse(witchRaw);
  console.log('女巫检查:', witchRaw);
  if (witch.name !== '女巫阿姨') throw new Error(`女巫没有进 PLACE_PEOPLE，personAt 返回 ${witch.name}`);
  if (witch.inPools !== 4) throw new Error(`女巫工坊只在 ${witch.inPools}/4 种性格的出行偏好里，她会去不到`);
  if (!witch.status) throw new Error('女巫工坊没有微信状态，她在那儿发不了状态');

  // 13. 防回归：地图不该再走"弹一次就没"的弹窗，它已经是 7b 验证过的聊天图片消息。
  //     UI 接口上如果又冒出 showMapReveal，说明有人把弹窗加回来了。
  const noModalRaw = await evalJs(
    send,
    `JSON.stringify({ modal: typeof window.game.ui.showMapReveal })`,
    'no-map-modal',
  );
  console.log('地图弹窗是否已移除:', noModalRaw);
  if (JSON.parse(noModalRaw).modal !== 'undefined') {
    throw new Error('UI 上还留着 showMapReveal 弹窗 —— 图片应该作为聊天记录里的一条消息存在');
  }

  proc.kill();

  if (pageErrors.length) throw new Error(`页面共抛出 ${pageErrors.length} 个异常`);
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
