/**
 * 主线阈值与推进的测试。
 *
 * 重点不是"函数能跑"，而是防住一个已经踩过的坑：
 * 阶段阈值曾经在 `interaction.ts` 和 `store.ts` 各写了一套（25/50+500 与 50/80+2000），
 * 谁先满足谁推进，于是出现"界面说转换器可以试制了、按钮却要 2000 金币点不动"。
 * 所以这里除了行为断言，还有几条**结构性断言**，专门防止阈值再次分家。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), 'story-'));
const bundle = join(out, 'story.mjs');

await build({
  entryPoints: [join(root, 'src', 'core', 'story.ts')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
});

const S = await import(pathToFileURL(bundle).href);

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

const emptyStory = () => ({
  phase: 0,
  confessionAt: null,
  giftFumbleAt: null,
  awakenedAt: null,
  physicalAt: null,
  hasPhysical: false,
});

console.log('\n[1] 阈值口径');
check('关系进展上限 1000', S.AFFINITY_MAX === 1000, String(S.AFFINITY_MAX));
// 剧本原值**不许漂移**。调试想快就压 DEBUG_THRESHOLDS，但这四个数是设计意图。
check('剧本原值 坦白 50', S.SCRIPT_THRESHOLDS.CONFESS === 50);
check('剧本原值 寄件失败 150', S.SCRIPT_THRESHOLDS.GIFT_FUMBLE === 150);
check('剧本原值 视界重叠 350', S.SCRIPT_THRESHOLDS.AWAKEN === 350);
check('剧本原值 实体破壁 700', S.SCRIPT_THRESHOLDS.PHYSICAL === 700);
{
  // 档位必须自洽：切到调试档就该用压低的值和压低的价格，别只改一半
  const expected = S.DEBUG_STORY ? 500 : 2000;
  check(`实体价格与档位匹配（${expected}）`, S.PHYSICAL_COST === expected, String(S.PHYSICAL_COST));
  if (S.DEBUG_STORY) {
    console.log('  ⚠ 当前是**调试档**（阈值已压低）。上线前把 story.ts 的 DEBUG_STORY 改成 false。');
  }
}
check(
  '当前生效阈值必须严格递增，否则后一幕永远到不了',
  S.STORY.CONFESS < S.STORY.GIFT_FUMBLE &&
    S.STORY.GIFT_FUMBLE < S.STORY.AWAKEN &&
    S.STORY.AWAKEN < S.STORY.PHYSICAL,
  JSON.stringify(S.STORY),
);
check(
  '上限必须大于最高的那个节点，否则后面的阶段永远到不了',
  S.AFFINITY_MAX > S.STORY.PHYSICAL,
  `${S.AFFINITY_MAX} vs ${S.STORY.PHYSICAL}`,
);
console.log(`  （当前生效阈值 ${JSON.stringify(S.STORY)}，实体价格 ${S.PHYSICAL_COST}）`);

console.log('\n[2] 阶段由关系进展派生');
{
  const A = S.STORY.AWAKEN;
  const P = S.STORY.PHYSICAL;
  check('0 → phase 0', S.phaseFor(0) === 0);
  check(`${A - 1} → phase 0（还没到觉醒）`, S.phaseFor(A - 1) === 0);
  check(`${A} → phase 1`, S.phaseFor(A) === 1);
  check(`${P - 1} → 仍是 phase 1`, S.phaseFor(P - 1) === 1);
  check(`${P} → phase 2`, S.phaseFor(P) === 2);
}

console.log('\n[3] 里程碑必须按顺序来，不能跳级');
{
  // 关系进展一次冲到顶（比如塞了很多礼物），也只该先返回最前面那个没播过的
  const hi = S.STORY.PHYSICAL + 100;
  const s = emptyStory();
  check('先给「坦白」', S.dueMilestone(hi, 99999, s) === 'confess');
  s.confessionAt = 1;
  check('再给「寄件失败」', S.dueMilestone(hi, 99999, s) === 'giftFumble');
  s.giftFumbleAt = 1;
  check('再给「视界重叠」', S.dueMilestone(hi, 99999, s) === 'awaken');
  s.awakenedAt = 1;
  check('最后才是「实体破壁」', S.dueMilestone(hi, 99999, s) === 'physical');
  s.physicalAt = 1;
  check('全播完了就不再有', S.dueMilestone(S.AFFINITY_MAX, 99999, s) === null);
}

console.log('\n[4] 实体那一步还要求金币到位');
{
  const s = emptyStory();
  s.confessionAt = 1;
  s.giftFumbleAt = 1;
  s.awakenedAt = 1;
  const need = S.STORY.PHYSICAL;
  const cost = S.PHYSICAL_COST;
  check('关系够了但钱不够 → 不给', S.dueMilestone(need, cost - 1, s) === null);
  check('钱够了才给', S.dueMilestone(need, cost, s) === 'physical');
}

console.log('\n[5] 结构性防回归：阈值不许再有第二套');
{
  const read = (p) => readFileSync(join(root, 'src', p), 'utf8');
  const storeSrc = read('core/store.ts');
  const interSrc = read('core/interaction.ts');
  const hudSrc = read('ui/hud.ts');

  const all = ['core/store.ts', 'core/interaction.ts', 'ui/hud.ts', 'game.ts', 'ai/prompt.ts', 'ai/offline.ts', 'ai/mapping.ts']
    .map(read)
    .join('\n');

  check('旧的 checkStoryProgress 已不存在', !all.includes('checkStoryProgress'));
  check(
    'interaction.applyGain 不再碰 story（阈值搬走了）',
    !/save\.story/.test(interSrc),
  );
  check('game.ts 只在主循环里调一次 syncStory', (read('game.ts').match(/syncStory\(/g) ?? []).length === 1);
  check('store.addCoins 不再顺手推进剧情', !/addCoins[\s\S]{0,200}syncStory/.test(storeSrc));
  check(
    '阈值数字不再散落在界面层',
    !/affinity\s*>=\s*(18|25|50|80)\b/.test(hudSrc) && !/coins\s*>=\s*2000/.test(hudSrc),
  );
  check('界面用的是 PHYSICAL_COST 而不是写死 2000', hudSrc.includes('PHYSICAL_COST'));
}

rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
