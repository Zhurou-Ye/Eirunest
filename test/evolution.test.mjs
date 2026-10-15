/**
 * 演化机制的行为测试。
 *
 * 目的不是"能编译"，而是回答一个具体问题：
 * 同一副人格预设，被回应和被冷落，最后会不会长成两个不同的人？
 * 如果 traits 只是线性漂移、且不影响任何行为参数，这个项目就还是在原地。
 *
 * 做法：用 esbuild 把 src/core/evolution.ts 单独打包出来直接跑，
 * 不依赖浏览器、不依赖 Store。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), 'evo-'));
const bundle = join(out, 'evolution.mjs');

await build({
  entryPoints: [join(root, 'src', 'core', 'evolution.ts')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
});

const evo = await import(pathToFileURL(bundle).href);

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/** 造一个够用的存档存根（只填 evolution 会读到的字段） */
function makeSave(preset = 'gentle') {
  return {
    clock: 100,
    character: {
      mood: 'calm',
      moodValue: 70,
      energyValue: 70,
      affinity: 20,
      personality: {
        preset,
        name: 'X',
        gender: 'female',
        firstPerson: '我',
        playerAddress: '你',
        tone: ['温和'],
        shyThreshold: { gentle: 0.6, cool: 0.3, sunny: 0.7, clingy: 0.85 }[preset],
        initiative: { gentle: 0.35, cool: 0.2, sunny: 0.6, clingy: 0.5 }[preset],
        speechRate: 4.2,
      },
      traits: undefined,
    },
    traitHistory: [],
    herPlan: null,
  };
}

const round = (v) => Math.round(v * 1000) / 1000;

console.log('\n[1] 起点 = 预设值，反复被冷落 → 更黏、更戒备、更少主动');
{
  const s = makeSave('gentle');
  const start = evo.effectiveStats(s);
  for (let i = 0; i < 200; i++) evo.applyExperience(s, 'chat_ignored', s.clock);
  const end = evo.effectiveStats(s);
  check('黏人度上升', end.clinginess > start.clinginess, `${start.clinginess} -> ${end.clinginess}`);
  check('戒备心上升', end.guardedness > start.guardedness, `${start.guardedness} -> ${end.guardedness}`);
  check('表达欲下降', end.expressiveness < start.expressiveness, `${start.expressiveness} -> ${end.expressiveness}`);
  check(
    '主动概率随之下调（行为规则被改写）',
    end.initiative < start.initiative,
    `${round(start.initiative)} -> ${round(end.initiative)}`,
  );
  check('心情衰减变快', end.moodLossPerHour > start.moodLossPerHour);
  check('写下了回溯点', s.traitHistory.length > 0, `${s.traitHistory.length} 条`);
}

console.log('\n[2] 同一预设，反复被回应 → 长出不一样的人（同样是 gentle，结局分流）');
{
  const ignored = makeSave('gentle');
  const replied = makeSave('gentle');
  for (let i = 0; i < 200; i++) {
    evo.applyExperience(ignored, 'chat_ignored', ignored.clock);
    evo.applyExperience(replied, 'chat_reply', replied.clock);
  }
  const a = evo.effectiveStats(ignored);
  const b = evo.effectiveStats(replied);
  check('被回应的那个更会主动开口', b.initiative > a.initiative, `${round(a.initiative)} vs ${round(b.initiative)}`);
  check('被回应的那个更放松', b.guardedness < a.guardedness, `${round(a.guardedness)} vs ${round(b.guardedness)}`);
  check(
    '两人差距已经明显（>0.15）',
    b.initiative - a.initiative > 0.15,
    `差 ${round(b.initiative - a.initiative)}`,
  );
  check('出门偏好也不同', Math.abs(a.outgoingBias - b.outgoingBias) > 0.1);
}

console.log('\n[3] 非线性：戒备高的人，身体接触更难拉近');
{
  const guarded = makeSave('cool'); // 起点戒备 0.6
  const open = makeSave('sunny'); // 起点戒备 0.3
  const g0 = evo.effectiveStats(guarded).guardedness;
  const o0 = evo.effectiveStats(open).guardedness;
  // 只推 10 次：多到能看出斜率差异，又不至于双双撞到下限 0.05 而看不出差别
  for (let i = 0; i < 10; i++) {
    evo.applyExperience(guarded, 'touch', guarded.clock);
    evo.applyExperience(open, 'touch', open.clock);
  }
  const gDrop = g0 - evo.effectiveStats(guarded).guardedness;
  const oDrop = o0 - evo.effectiveStats(open).guardedness;
  check('戒备高者降得更少（非线性生效）', gDrop < oDrop, `高戒备降 ${round(gDrop)} / 低戒备降 ${round(oDrop)}`);
}

console.log('\n[4] 离线重放：你不在时她去过的地点会变成发生过的事');
{
  const s = makeSave('sunny');
  s.clock = 20.5;
  s.herPlan = {
    day: 0,
    profileId: 'haru',
    blocks: [
      { start: 0, end: 7, placeId: 'home', kind: 'rest', label: '在家睡觉' },
      { start: 7, end: 12, placeId: 'school', kind: 'commit', label: '在学校上课' },
      { start: 12, end: 14, placeId: 'cafe', kind: 'want', label: '去咖啡店吃点甜的' },
      { start: 14, end: 18, placeId: 'park', kind: 'want', label: '去河滨公园走走' },
      { start: 18, end: 24, placeId: 'home', kind: 'rest', label: '在家待着' },
    ],
  };
  const events = evo.planOfflineEvents(s, 8);
  check('重放出事件', events.length > 0, `${events.length} 件`);
  check('事件都发生在"外面的"地点', events.every((e) => e.placeId !== 'home'));
  check('事件带去了哪里的信息', events.every((e) => !!e.caption));
  check('事件数量有上限（不会刷屏）', events.length <= 4, `${events.length}`);
}

console.log('\n[5] 离线也会改写 traits，且不越界');
{
  const s = makeSave('gentle');
  s.clock = 20.5;
  s.herPlan = {
    day: 0,
    profileId: 'haru',
    blocks: [
      { start: 0, end: 7, placeId: 'home', kind: 'rest', label: '睡' },
      { start: 7, end: 12, placeId: 'school', kind: 'commit', label: '上课' },
      { start: 12, end: 24, placeId: 'home', kind: 'rest', label: '在家' },
    ],
  };
  const before = evo.effectiveStats(s).clinginess;
  const events = evo.planOfflineEvents(s, 5);
  evo.foldOfflineIntoTraits(s, events, 5);
  check('长时间没人来 → 黏人度上升', evo.effectiveStats(s).clinginess > before);

  const hard = makeSave('gentle');
  for (let i = 0; i < 5000; i++) evo.applyExperience(hard, 'chat_ignored', hard.clock);
  const t = hard.character.traits;
  check(
    'traits 被夹在 [0.05, 0.95] 内',
    t.expressiveness >= 0.05 && t.expressiveness <= 0.95 && t.clinginess <= 0.95 && t.guardedness <= 0.95,
    JSON.stringify(t),
  );
  check('回溯史有上限，不会撑爆存档', hard.traitHistory.length <= 200, `${hard.traitHistory.length}`);
}

rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
