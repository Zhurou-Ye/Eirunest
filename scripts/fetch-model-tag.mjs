/**
 * 从指定 tag/branch 下载单个 Live2D 样例模型到 public/character/<name>。
 * 用法：node scripts/fetch-model-tag.mjs <TAG> <MODEL>
 *   例：node scripts/fetch-model-tag.mjs 4-r.7 Mao
 */
import { writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REPO = 'Live2D/CubismWebSamples';
const REF = process.argv[2];
const MODEL = process.argv[3];
if (!REF || !MODEL) {
  console.error('用法：node scripts/fetch-model-tag.mjs <TAG> <MODEL>');
  process.exit(1);
}
const OUT = join(process.cwd(), 'public', 'character', MODEL);
const API = `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`;
const CDN = `https://cdn.jsdelivr.net/gh/${REPO}@${REF}`;

async function download(url, dest, retries = 5) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('空文件');
      await mkdirSync(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      return buf.length;
    } catch (err) {
      if (i === retries) { console.log(`    x ${url.split('/').pop()} - ${err.message}`); return 0; }
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  return 0;
}

const res = await fetch(API, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) { console.error(`GitHub API ${res.status}`); process.exit(1); }
const data = await res.json();
const prefix = `Samples/Resources/${MODEL}/`;
const files = (data.tree || []).filter((t) => t.type === 'blob' && t.path.startsWith(prefix) && t.size > 0);
if (!files.length) { console.log(`! ${MODEL}: ${REF} 下没找到，跳过`); process.exit(0); }

let ok = 0, bytes = 0;
for (const f of files) {
  const rel = f.path.slice(prefix.length);
  const dest = join(OUT, rel);
  if (existsSync(dest) && statSync(dest).size === f.size) { ok++; bytes += f.size; continue; }
  const n = await download(`${CDN}/${f.path}`, dest);
  if (n > 0) { ok++; bytes += n; }
}
console.log(`  ${ok === files.length ? 'OK' : '!!'} ${MODEL}@${REF}: ${ok}/${files.length} 文件，${(bytes / 1024 / 1024).toFixed(1)} MB`);
