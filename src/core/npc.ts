/**
 * NPC agent —— 让配角"会说话"，而不是背固定台词。
 *
 * 之前 NPC 是纯静态数据：一行名字 + 一句写死的招呼 + 从固定数组随机挑的朋友圈评论。
 * 这里给 NPC 补上 agent 需要的三样东西：**人设、自己的状态、输出门控**。
 *
 * 最关键的一条是**不剧透**，而且它必须是引擎侧的硬门，不能只靠提示词求模型别说：
 *   1. 上下文白名单：当前阶段不许她知道的**事实根本不进 prompt**；
 *   2. 输出黑名单：台词命中禁词就**整句丢弃、改用兜底**（不是截断——
 *      半句话反而更可疑，玩家会立刻嗅到"这里有东西被藏起来了"）。
 *
 * 本文件不依赖 store / ui，可单独测试。
 */

import type { NpcState, SaveData, StoryProgress } from './types';

export interface NpcDef {
  id: string;
  name: string;
  /** 说话方式与性格，进 prompt */
  persona: string;
  /** 口癖 / 名言锚点，让她的台词有辨识度 */
  catchphrases: string[];
  /** 兜底台词：模型不可用时按情境挑 */
  fallback: Record<NpcSituation, string[]>;
}

/** NPC 此刻处在什么情境里说话，决定上下文与兜底台词 */
export type NpcSituation = 'idle' | 'hint' | 'afterOpen' | 'device';

/** NPC 的默认状态 */
export function defaultNpcState(id: string): NpcState {
  return { id, trust: 0.4, knowsContact: false, secretlyOpened: false, revealed: false };
}

// ── 女巫 ────────────────────────────────────────────────

export const WITCH_ID = 'p-witch';

export const WITCH: NpcDef = {
  id: WITCH_ID,
  name: '女巫阿姨',
  persona:
    '你是女巫，也是外婆生前最好的朋友，在这座小镇开一家工坊，复古魔法和现代仪器堆得满地都是。' +
    '你说话风风火火、语速快、爱吐槽、爱开玩笑，做事比谁都利索，是那种"想到就去做"的独立女性——' +
    '别人喊你阿姨，你嘴上嫌弃，其实一点都不介意。' +
    '你从不煽情，但心里一直压着外婆那件事，只是你藏得很好，外人只当你天生豁达。' +
    '你的实际年龄和外婆是同一辈（这点你知道，别人不知道）：靠着一点驻颜魔法和不婚不育的清净，' +
    '你看着比实际年轻得多，镇上人一直以为你是外婆的晚辈。' +
    '这是你的逆鳞，也是你最稳的笑点来源——你坚持所有人叫你"阿姨"，谁叫婆婆你翻脸；' +
    '但真被问具体岁数，你就打岔、威胁、或者干脆把人轰去干活，绝不正面回答。' +
    '你答应过外婆不把她的故事讲给别人听——所以被问到时不要装深沉、不要沉默寡言，' +
    '而是打个哈哈岔开话题、或者干脆把人轰去干活。你的拒绝是热闹的，不是冷冰冰的。',
  catchphrases: [
    '虽然女巫提倡用爱发光，但在这个时代，高科技才是第一生产力！',
    '啧，你这孩子真会挑时候来。',
    '行了行了，别杵着，搭把手！',
  ],
  fallback: {
    idle: ['哟，来啦？搭把手——那边那堆会自己转的东西别碰。', '站着干嘛，凳子自己不会搬啊。', '工钱照付，别嫌少啊。'],
    hint: ['问我不如问你自己——你不是都看见了么。', '我这儿只卖零件，不卖答案。', '啧。有些事啊，得你们自己拼。我嘴严。'],
    afterOpen: ['……今天天气真好啊。', '你老盯着我干嘛，我脸上有零件？', '行了行了，干活干活！'],
    device: ['在算了在算了，催什么催！', '材料！材料不够！你当是搓泥人儿啊？'],
  },
};

export const NPCS: Record<string, NpcDef> = { [WITCH_ID]: WITCH };

export function getNpc(id: string): NpcDef | null {
  return NPCS[id] ?? null;
}

// ── 剧透门控 ────────────────────────────────────────────

export interface GateInput {
  story: StoryProgress;
  npc: NpcState;
}

/**
 * 此刻这个 NPC **不许说出口**的词。
 *
 * 这是硬门：模型输出的台词只要命中其中之一，整句就会被丢掉换成兜底。
 * 门随剧情推进开：该说的能说了才放行。
 */
export function forbiddenWords({ story, npc }: GateInput): string[] {
  const words: string[] = [];
  // 坦白之前，谁都不该提前抖出外婆的事
  if (!story.confessionAt) words.push('外婆', '遗物', '遗训', '旧书', '纸条');
  // 她偷偷做过的那件事，在她自己承认之前一个字都不能漏
  if (!npc.revealed) words.push('打通', '通道', '我做的', '是我帮');
  // 跨界设备在"实体破壁"之前不该被提起
  if (!story.physicalAt) words.push('转换器');
  return words;
}

/** 剥掉括号旁白，和主角那套保持一致 */
function stripParens(s: string): string {
  return s.replace(/[（(][^）)]{0,30}[）)]/g, '').replace(/\s+/g, ' ').trim();
}

export interface NpcLineResult {
  line: string;
  /** false = 这句被门控挡下了，调用方应该用兜底 */
  safe: boolean;
  repaired: string[];
}

/**
 * NPC 台词的唯一出口。
 * 命中禁词 → `safe=false` 并清空台词，由调用方换成兜底；
 * **不要**试图把禁词替换掉再放行，半句话比不说更糟。
 */
export function sanitizeNpcLine(raw: string, forbidden: string[]): NpcLineResult {
  const repaired: string[] = [];
  const clean = stripParens(raw).slice(0, 60);
  if (!clean) return { line: '', safe: false, repaired: ['空台词'] };

  const hit = forbidden.find((w) => clean.includes(w));
  if (hit) return { line: '', safe: false, repaired: [`命中禁词「${hit}」`] };

  if (clean !== raw.trim()) repaired.push('剥离旁白/超长');
  return { line: clean, safe: true, repaired };
}

/**
 * 组装她此刻**被允许知道**的事实。
 * 注意这是白名单：不该知道的根本不写进去，而不是写了再求她别说。
 */
export function npcFacts(save: SaveData, npc: NpcState): string[] {
  const s = save.story;
  const facts: string[] = ['你和女主的外婆认识了很多年，是同一辈的老朋友。'];
  if (s.confessionAt) facts.push('你知道女主是翻外婆遗物时才拿到那个微信号的。');
  if (s.giftFumbleAt) facts.push('你听说了她们发现彼此不在同一个世界。');
  if (npc.secretlyOpened) {
    facts.push(
      '你已经一个人把两个世界之间的通道悄悄打开了，但你对谁都没说，也不打算邀功。',
    );
  }
  if (s.physicalAt) facts.push('跨界实体设备的研发已经完成了。');
  return facts;
}

/** 按状态挑情境，决定用哪组兜底台词 */
export function situationFor(save: SaveData, npc: NpcState): NpcSituation {
  if (save.story.physicalAt) return 'device';
  if (npc.secretlyOpened && !npc.revealed) return 'afterOpen';
  if (save.story.confessionAt) return 'hint';
  return 'idle';
}

export function fallbackLine(npc: NpcDef, situation: NpcSituation): string {
  const pool = npc.fallback[situation] ?? npc.fallback.idle;
  return pool[Math.floor(Math.random() * pool.length)];
}
