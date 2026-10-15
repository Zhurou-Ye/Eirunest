/**
 * 下载 Live2D 官方免费样例模型。
 *
 * 走 jsdelivr CDN：raw.githubusercontent.com 在 Windows 下传大文件不稳。
 * 文件清单从 GitHub API 取（CDN 列目录不方便）。
 *
 * 用法：node scripts/fetch-live2d-models.mjs [模型名...]
 *   不带参数时下载 MODELS 里列出的全部。
 */
import { writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REPO = 'Live2D/CubismWebSamples';

/**
 * 关键：必须钉在 Cubism 4 的 tag（4-r.7），不能用 develop。
 *
 * develop 分支已经换成 Cubism 5 时代的模型：Mao 的 moc3 版本是 v5、Ren 是 v6。
 * 而本项目里的运行时 live2dcubismcore@1.0.2 是 Cubism 4.2 的 Core，
 * 只能加载 moc3 v1~v4。用 develop 拉下来的 Mao 会在 createCoreModel 处报错、
 * 模型加载失败（Haru/Natori 恰好还是 v1，所以没暴露问题）。
 *
 * 4-r.7 是最后一个 Cubism 4.x 发布，其 Mao 是 moc3 v4，与现有运行时匹配。
 * 所以这里固定 4-r.7 —— 换 tag 前务必确认目标模型的 moc3 版本 <= 4。
 */
const BRANCH = '4-r.7';
const OUT = join(process.cwd(), 'public', 'character');
const API = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
const CDN = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}`;

// 全部官方免费样例：女性 4 + 男性 3 + 狗 1 —— 4-r.7 里实际存在的是下面这些
// 只留能用的三套：都有 Head+Body 双 HitArea、且 moc3 版本 ≤ 4。
// Hiyori 只有 Body 一个触点，Mark 无表情无触点，Ren 在软件渲染下 shader 超限——都已撤下。
const MODELS = ['Haru', 'Mao', 'Natori'];

const wanted = process.argv.slice(2);
const list = wanted.length ? wanted : MODELS;

/** 带重试的下载。CDN 偶发 5xx，退避重试通常就好。 */
async function download(url, dest, retries = 5) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('空文件');
      await mkdirSync(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      return buf.length;
    } catch (err) {
      if (i === retries) {
        console.log(`    x ${url.split('/').pop()} - ${err.message}`);
        return 0;
      }
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  return 0;
}

async function tree() {
  const res = await fetch(API, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.tree)) throw new Error('GitHub API 返回异常');
  return data.tree;
}

console.log(`下载 Live2D 官方样例模型 -> public/character/`);
const files = await tree();
let total = 0;

for (const m of list) {
  const prefix = `Samples/Resources/${m}/`;
  const own = files.filter((t) => t.type === 'blob' && t.path.startsWith(prefix) && t.size > 0);
  if (own.length === 0) {
    console.log(`  ! ${m}: 仓库里没找到，跳过`);
    continue;
  }

  let bytes = 0;
  let ok = 0;
  for (const f of own) {
    const rel = f.path.slice(prefix.length);
    const dest = join(OUT, m, rel);
    if (existsSync(dest) && statSync(dest).size === f.size) {
      ok++;
      bytes += f.size;
      continue;
    }
    const n = await download(`${CDN}/${f.path}`, dest);
    if (n > 0) {
      ok++;
      bytes += n;
    }
  }
  total += bytes;
  console.log(`  ${ok === own.length ? 'OK' : '!!'} ${m}: ${ok}/${own.length} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

console.log(`\n合计 ${(total / 1024 / 1024).toFixed(1)} MB`);
console.log('这些模型遵循 Live2D 免费素材许可协议：');
console.log('https://www.live2d.jp/en/terms/live2d-free-material-license-agreement/');