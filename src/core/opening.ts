/**
 * 开局剧本的**加载器**（类型 + 变量替换 + 索引）。
 *
 * 剧本内容本身在 `drama/opening.json`（仓库根目录的 drama/ 文件夹）——
 * 加节点、改台词只动那个 JSON，不用碰这里的代码。以后新章节往
 * `drama/` 里继续加文件即可。
 *
 * JSON 结构（节点用 id 互相引用，不嵌套，加节点就是加一条）：
 * {
 *   "entry": "root",
 *   "nodes": {
 *     "root": {
 *       "her":    ["她依次发的话", ...],
 *       "neixin": ["玩家的内心话", ...],        // 可省略；多条会依次播出
 *       "options": [{ "label": "快捷回复（也是玩家发出去的那句）", "next": "节点id" }]
 *     },
 *     ...
 *   }
 * }
 *
 * 模板变量（按性格在代码里替换，写在各性格的 PRESET_VARS 里）：
 *   {{herName}} 角色名   {{commute}} 上学路上下班路   {{homework}} 今晚写不下作业/睡不着
 *   {{intro}} 自我介绍后半句   {{farewell}} 道别前的那句
 *
 * 剧情背景：她因想查明外婆悲伤一生的原因，违背遗训添加了一个陌生微信。
 * 她说出口的理由是「做梦梦到了你的微信号」——这是谎：真实目的是想试探
 * 对方知不知道外婆过世的真相，但怕吓到他，好感够了（坦白那一幕）才敢说。
 */

import type { Gender, PersonalityPreset } from './types';
import doc from '../../drama/opening.json';

export interface OpeningChoice {
  /** 快捷回复按钮上的文字（也就是玩家发出去的那句） */
  label: string;
  /** 点完后接着跑的节点 */
  next: OpeningNode;
}

export interface OpeningNode {
  /** 她依次发的话（逐条送达） */
  her: string[];
  /** 她说完时玩家心里的声音（多条会依次播出） */
  neixin?: string | string[];
  /** 发完后等玩家选；没有 = 剧本结束，回到自由聊天 */
  options?: OpeningChoice[];
}

/** 一条"剧情分钟"折算成多少真实毫秒。1 分钟 ≈ 4 秒，像真人在打字。 */
export const OPENING_MS_PER_MIN = 4_000;

/** 层内每条台词的间隔（剧情分钟） */
const BEAT = 0.9;

/** 各性格的模板变量（语气相关的少量差异；剧本主体在 JSON 里共用） */
const PRESET_VARS: Record<PersonalityPreset, Record<string, string>> = {
  sunny: {
    commute: '上学路上',
    homework: '今晚我都写不下去作业了',
    intro: '是个普通的高中生，平时除了上课写作业，最喜欢捣鼓各种吃的和奇奇怪怪的小玩意儿。',
    farewell: '呀，不跟你吹水啦，我得赶快去补今天的作业了……不然明天又要被老师盯上了，惨惨惨！(>_<)',
  },
  gentle: {
    commute: '上学路上',
    homework: '今晚我都写不下去作业了',
    intro: '是个普通的高中生，平时除了上课写作业，最喜欢捣鼓各种吃的和奇奇怪怪的小玩意儿。',
    farewell: '呀，不跟你聊了，我得赶快把今天的作业补完……不然明天又要被老师盯上了。(>_<)',
  },
  cool: {
    commute: '下班路上',
    homework: '今晚我都睡不着了',
    intro: '是个再普通不过的上班族，平时除了上班，最喜欢捣鼓各种吃的和奇奇怪怪的小玩意儿。',
    farewell: '呀，不跟你聊了，我今天还得加个班……不然明天又要被主管盯上了，惨惨！(>_<)',
  },
  clingy: {
    commute: '上学路上',
    homework: '今晚我都写不下去作业了',
    intro: '是个普通的高中生，平时除了上课写作业，最喜欢捣鼓各种吃的和奇奇怪怪的小玩意儿。',
    farewell: '呀，不跟你吹水啦，我得赶快去补今天的作业了……不然明天又要被老师盯上了，惨惨惨！(>_<)',
  },
};

export interface OpeningScript {
  root: OpeningNode;
  /** 最后一条她的台词 → 该节点（所有节点，供刷新后重建进度 / 播内心） */
  nodeByLastLine: Map<string, OpeningNode>;
}

/** JSON 里的原始节点结构（next 还是 id 字符串） */
interface DocNode {
  her: string[];
  neixin?: string | string[];
  options?: Array<{ label: string; next: string }>;
}
interface Doc {
  entry: string;
  nodes: Record<string, DocNode>;
}

const DOC = doc as unknown as Doc;

/** 把 {{var}} 替换成当前性格/角色的值 */
function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => vars[key] ?? m);
}

/**
 * 生成某个性格的开局剧本（从 JSON 构建节点树 + 索引）。
 * 换立绘 = 换人：变量表跟着性格走，剧本主体共用一份。
 */
export function buildOpeningScript(
  preset: PersonalityPreset,
  _gender: Gender,
  herName: string,
  _playerName: string,
): OpeningScript {
  const vars: Record<string, string> = {
    ...(PRESET_VARS[preset] ?? PRESET_VARS.sunny),
    herName,
  };

  const built = new Map<string, OpeningNode>();
  const build = (id: string): OpeningNode => {
    const cached = built.get(id);
    if (cached) return cached;
    const raw = DOC.nodes[id];
    if (!raw) throw new Error(`drama/opening.json 里没有节点「${id}」`);
    const node: OpeningNode = {
      her: raw.her.map((t) => fill(t, vars)),
      neixin: Array.isArray(raw.neixin)
        ? raw.neixin.map((t) => fill(t, vars))
        : raw.neixin === undefined
          ? undefined
          : fill(raw.neixin, vars),
    };
    // 先占位再填 options，防止节点互相引用时无限递归
    built.set(id, node);
    if (raw.options?.length) {
      node.options = raw.options.map((o) => ({ label: fill(o.label, vars), next: build(o.next) }));
    }
    return node;
  };

  const root = build(DOC.entry);

  // 索引：最后一条台词 → 节点（刷新页面后靠它重建进度）
  const nodeByLastLine = new Map<string, OpeningNode>();
  const seen = new Set<OpeningNode>();
  const walk = (n: OpeningNode): void => {
    if (seen.has(n)) return;
    seen.add(n);
    nodeByLastLine.set(n.her[n.her.length - 1], n);
    n.options?.forEach((o) => walk(o.next));
  };
  walk(root);

  return { root, nodeByLastLine };
}

/**
 * 系统提示：通过好友验证后微信自动补的那条灰字。
 * 真微信 8.0.59+ 的文案（**通过方视角**）：对方发出申请、你在这边点了通过，
 * 你看到的应该正是「你已添加了 XXX，现在可以开始聊天了」。
 */
export function friendVerifiedSys(name: string): string {
  return `你已添加了${name}，现在可以开始聊天了`;
}

/** 她发来的"打招呼内容"播完后，微信补的那条灰色分隔提示（真微信原文） */
export const GREETING_DIVIDER = '以上是打招呼的内容';

/**
 * 把剧本某一层的台词排成"一条条送达"的队列项。
 * 落在"我的手机 / 和她"的会话里（owner='me', contactId='her'）。
 * dueAt 用墙钟毫秒，所以关掉页面再回来也接得上。
 */
export function scheduleNode(
  node: OpeningNode,
  baseNowMs = Date.now(),
  msPerMin = OPENING_MS_PER_MIN,
  leadBeats = 0,
): Array<{ owner: 'me'; contactId: 'her'; from: 'her' | 'sys'; text: string; dueAt: number }> {
  return node.her.map((text, i) => ({
    owner: 'me' as const,
    contactId: 'her' as const,
    from: 'her' as const,
    text,
    // leadBeats：她"接话"之前先停一拍。玩家点了快捷回复后，她的第一句若 dueAt
    // 正好等于 now，就会和玩家刚发的那句同时冒出来（用户反馈的现象）。
    dueAt: baseNowMs + (i + leadBeats) * BEAT * msPerMin,
  }));
}
