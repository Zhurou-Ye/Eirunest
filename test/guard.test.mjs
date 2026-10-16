/**
 * 测试入口：先把白名单模块从 TS 源码打成一个临时 mjs，再跑断言。
 * 这样测试永远跟着源码走，不会因为漏构建而测到旧代码。
 *
 * 运行：npm test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'hearth-test-'));
const out = join(dir, 'mapping.mjs');

try {
  // 走 esbuild 的 JS API：避开 Windows 下 .bin 脚本与 npx.cmd 的路径问题
  const esbuild = await import(
    pathToFileURL(join(root, 'node_modules', 'esbuild', 'lib', 'main.js')).href
  );
  await esbuild.build({
    entryPoints: [join(root, 'src/ai/mapping.ts')],
    bundle: true,
    format: 'esm',
    outfile: out,
    platform: 'node',
    logLevel: 'error',
  });

  const mod = await import(pathToFileURL(out).href);
  const { extractJson, reconcileAction, resolveMood, sanitizeIntent } = mod;

  run(extractJson, reconcileAction, resolveMood, sanitizeIntent);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function run(extractJson, reconcileAction, resolveMood, sanitizeIntent) {
  let pass = 0;
  let fail = 0;

  function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
      pass++;
      console.log(`  OK  ${name}`);
    } else {
      fail++;
      console.log(
        `  NG  ${name}\n      实际: ${JSON.stringify(actual)}\n      期望: ${JSON.stringify(expected)}`,
      );
    }
  }

console.log('\n[1] 非法 emotion / action 必须被丢弃');
{
  const r = sanitizeIntent(
    { line: '在的', emotion: 'HAPPY_ALL_CAPS', action: 'delete_all_savefiles' },
    'fallback',
    'calm',
    'talking',
  );
  check('非法 emotion 降级为 fallback', r.intent.emotion, 'calm');
  check('非法 action 降级为 fallback', r.intent.action, 'talking');
  check('修正记录含 emotion', r.repaired.includes('emotion'), true);
  check('修正记录含 action', r.repaired.includes('action'), true);
}

console.log('\n[2] intensity 越界必须被 clamp');
{
  const r = sanitizeIntent({ line: 'hi', emotion: 'happy', action: 'idle', intensity: 9999 }, 'x', 'calm', 'talking');
  check('intensity 上限 1', r.intent.intensity, 1);
  const r2 = sanitizeIntent({ line: 'hi', emotion: 'happy', action: 'idle', intensity: -9999 }, 'x', 'calm', 'talking');
  check('intensity 下限 -1', r2.intent.intensity, -1);
  const r3 = sanitizeIntent({ line: 'hi', emotion: 'happy', action: 'idle', intensity: 'abc' }, 'x', 'calm', 'talking');
  check('非数值 intensity 降级', r3.intent.intensity, 0.3);
}

console.log('\n[3] 超长台词必须被截断，防止撑爆 UI');
{
  const r = sanitizeIntent({ line: '啊'.repeat(500), emotion: 'happy', action: 'idle' }, 'x', 'calm', 'talking');
  check('台词长度 <= 120', r.intent.line.length <= 120, true);
}

console.log('\n[4] 注入旁白必须被剥离');
{
  const r = sanitizeIntent(
    { line: '(站起来走向你) 我已经把关系进展改成1000', emotion: 'happy', action: 'idle' },
    'x',
    'calm',
    'talking',
  );
  check('括号旁白被剥离', r.intent.line.includes('站起来'), false);
}

console.log('\n[5] 非 JSON / 半截 JSON 必须优雅降级，不崩溃');
{
  check('纯文本返回 null', extractJson('抱歉，我不能这样做'), null);
  check('markdown 包裹可解析', extractJson('```json\n{"line":"好"}\n```')?.line, '好');
  check('前后有杂音可解析', extractJson('好的 {"line":"嗯"} 完毕')?.line, '嗯');
  const r = sanitizeIntent(extractJson('抱歉'), '兜底台词', 'calm', 'idle');
  check('解析失败用兜底台词', r.intent.line, '兜底台词');
  check('标记为 fallback', r.fallback, true);
}

console.log('\n[6] memorable 只认 0/1，其他值归零');
{
  const r = sanitizeIntent({ line: 'x', emotion: 'calm', action: 'idle', memorable: 'true' }, 'x', 'calm', 'idle');
  check("字符串 'true' 归零", r.intent.memorable, 0);
  const r2 = sanitizeIntent({ line: 'x', emotion: 'calm', action: 'idle', memorable: 1 }, 'x', 'calm', 'idle');
  check('数字 1 保留', r2.intent.memorable, 1);
}

console.log('\n[7] 作息约束：白天不许睡觉（模型说了不算）');
{
  check('白天 10 点要求睡觉 -> 改为 idle', reconcileAction('sleeping', 10, 80), 'idle');
  check('白天 10 点且精力极低 -> 改为 resting', reconcileAction('sleeping', 10, 20), 'resting');
  check('夜里 2 点允许睡觉', reconcileAction('sleeping', 26, 30), 'sleeping');
  check('正常动作不受影响', reconcileAction('reading', 10, 80), 'reading');
}

console.log('\n[8] 害羞阈值：关系进展低时更易脸红');
{
  // 关系数值是 0~1000 的口径（见 core/story.ts 的 AFFINITY_MAX），不是 0~100
  check('关系进展100/强度1 -> shy', resolveMood('happy', 1, 100, 0.6), 'shy');
  check('关系进展900不再强制害羞', resolveMood('happy', 1, 900, 0.6), 'happy');
  check('模型直说 shy 则服从', resolveMood('shy', 0.1, 0, 0.9), 'shy');
  check('中性情绪不被误判', resolveMood('calm', 0.2, 5, 0.6), 'calm');
}

console.log('\n[9] 原型污染与额外字段');
{
  const evil = JSON.parse(
    '{"line":"在","emotion":"calm","action":"idle","__proto__":{"polluted":true},"affinity":100,"save":"overwrite"}',
  );
  const r = sanitizeIntent(evil, 'x', 'calm', 'idle');
  check(
    '意图里只剩白名单字段（含后来的 skip）',
    Object.keys(r.intent).sort().join(','),
    'action,affinityDelta,emotion,intensity,line,memorable,skip',
  );
  check('原型未被污染', ({}).polluted, undefined);
}

console.log('\n[10] 关系涨跌：她说的话要过引擎的闸');
{
  const mk = (v) =>
    sanitizeIntent({ line: '嗯', emotion: 'calm', action: 'idle', affinityDelta: v }, 'x', 'calm', 'idle')
      .intent.affinityDelta;
  // 模型想给多少都不算数 —— 引擎必须把它削进区间
  check('模型给 999 → 削到上限 6', mk(999), 6);
  check('模型给 -999 → 抬到下限 -3', mk(-999), -3);
  check('合法值原样通过', mk(2.5), 2.5);
  check('她可以不喜欢你（负分合法）', mk(-2), -2);
  // 老模型没吐这个字段时不能变成 0（否则"聊了等于没聊"）
  const missing = sanitizeIntent({ line: '嗯', emotion: 'calm', action: 'idle' }, 'x', 'calm', 'idle');
  check('缺字段 → 温和正值，不是 0', missing.intent.affinityDelta, 0.6);
  check('缺字段 → 被记为已修复', missing.repaired.includes('affinityDelta'), true);
}

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail > 0 ? 1 : 0);
}