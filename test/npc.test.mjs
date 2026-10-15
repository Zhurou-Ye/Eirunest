/**
 * NPC agent 的门控测试。
 *
 * 这里测的不是"NPC 会不会说话"，而是**它能不能保证不说漏嘴**。
 * 因为"不剧透"是这个角色设计的全部张力所在（她知道，但答应过不说），
 * 一旦漏一句，那一幕就废了 —— 所以它必须是引擎侧的硬门，不能指望提示词。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), 'npc-'));
const bundle = join(out, 'npc.mjs');

await build({
  entryPoints: [join(root, 'src', 'core', 'npc.ts')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
});

const N = await import(pathToFileURL(bundle).href);

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

const story = (over = {}) => ({
  phase: 0,
  confessionAt: null,
  giftFumbleAt: null,
  awakenedAt: null,
  physicalAt: null,
  hasPhysical: false,
  ...over,
});
const npcState = (over = {}) => ({
  id: 'p-witch',
  trust: 0.4,
  knowsContact: false,
  secretlyOpened: false,
  revealed: false,
  ...over,
});

console.log('\n[1] 门随剧情开合');
{
  const early = N.forbiddenWords({ story: story(), npc: npcState() });
  check('还没坦白 → 外婆的事是禁词', early.includes('外婆') && early.includes('遗物'));
  check('还没承认 → "打通/通道"是禁词', early.includes('打通') && early.includes('通道'));
  check('还没到实体节点 → "转换器"是禁词', early.includes('转换器'));

  const afterConfess = N.forbiddenWords({ story: story({ confessionAt: 1 }), npc: npcState() });
  check('坦白之后 → 外婆不再是禁词', !afterConfess.includes('外婆'));

  const afterReveal = N.forbiddenWords({
    story: story({ confessionAt: 1, physicalAt: 1 }),
    npc: npcState({ revealed: true }),
  });
  check('她亲口承认过之后 → 禁词全开', afterReveal.length === 0, afterReveal.join(','));
}

console.log('\n[2] 命中禁词必须整句丢弃（不能截断放行）');
{
  const f = N.forbiddenWords({ story: story(), npc: npcState() });
  const r = N.sanitizeNpcLine('你外婆当年也来过这儿。', f);
  check('整句被拦下', r.safe === false);
  check('台词被清空，不会留下半句', r.line === '', `实际：${r.line}`);
  check('留下了原因，便于排查', r.repaired.length > 0 && r.repaired[0].includes('外婆'), r.repaired.join(';'));
}

console.log('\n[3] 该放的必须放，别把正常台词也拦了');
{
  const f = N.forbiddenWords({ story: story(), npc: npcState() });
  const ok = N.sanitizeNpcLine('东西在里面响，自己听。', f);
  check('正常台词放行', ok.safe === true, ok.repaired.join(';'));
  check('内容保持原样', ok.line === '东西在里面响，自己听。');

  // 女巫的名言里带"魔法"，不该被误伤
  const motto = N.sanitizeNpcLine('虽然女巫提倡用爱发光，但在这个时代，高科技才是第一生产力！', f);
  check('她的名言能说出来', motto.safe === true, motto.repaired.join(';'));
}

console.log('\n[4] 输出格式兜底：旁白要剥、超长要截');
{
  const f = N.forbiddenWords({ story: story({ confessionAt: 1, physicalAt: 1 }), npc: npcState({ revealed: true }) });
  const r = N.sanitizeNpcLine('（她头也不抬地擦着仪器）别乱碰。', f);
  check('括号旁白被剥掉', !r.line.includes('头也不抬'), r.line);
  const long = N.sanitizeNpcLine('一'.repeat(200), f);
  check('超长被截到 60 字内', long.line.length <= 60, String(long.line.length));
  const empty = N.sanitizeNpcLine('   ', f);
  check('空台词判定为不安全', empty.safe === false);
}

console.log('\n[5] 上下文白名单：不该知道的事实根本不写进去');
{
  const saveEarly = { story: story(), npcs: {} };
  const factsEarly = N.npcFacts(saveEarly, npcState());
  check('一开始不知道遗物的事', !factsEarly.join('').includes('遗物'));

  const saveOpened = { story: story({ confessionAt: 1 }), npcs: {} };
  const factsOpened = N.npcFacts(saveOpened, npcState({ secretlyOpened: true }));
  const joined = factsOpened.join('');
  check('坦白后才带遗物这条', joined.includes('遗物'));
  check('偷偷打通之后才有这条事实', joined.includes('通道'));

  const factsNotOpened = N.npcFacts(saveOpened, npcState());
  check('没做过就不该出现"通道"', !factsNotOpened.join('').includes('通道'));
}

console.log('\n[6] 兜底台词齐全（离线也要能演）');
{
  for (const sit of ['idle', 'hint', 'afterOpen', 'device']) {
    const line = N.fallbackLine(N.WITCH, sit);
    check(`情境「${sit}」有兜底台词`, typeof line === 'string' && line.length > 0);
  }
  check('女巫有口癖/名言锚点', N.WITCH.catchphrases.length > 0 && N.WITCH.catchphrases.join('').includes('第一生产力'));
  check('女巫 id 与 PLACE_PEOPLE 一致', N.WITCH_ID === 'p-witch');
}

rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
