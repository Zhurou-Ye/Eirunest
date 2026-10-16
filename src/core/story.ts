/**
 * 主线推进：所有阶段阈值的**唯一来源**。
 *
 * 之前踩的坑：`interaction.ts` 和 `store.ts` 各写了一套阈值
 * （25 / 50+500金币 与 50 / 80+2000金币），谁先满足谁推进 `phase`，
 * 结果"界面说转换器可以试制了、按钮却要 2000 金币点不动"。
 *
 * 现在只有这里一套数，判定只在 `store.syncStory()` 里发生一次。
 */

import type { StoryPhase, StoryProgress } from './types';

/**
 * 关系进展上限。
 * 剧本的四个节点是 50 / 150 / 350 / 700，所以不能再是 100 ——
 * 之前 `clampNum(..., 0, 100)` 会让 150 之后的节点永远到不了。
 */
export const AFFINITY_MAX = 1000;

/**
 * 单次互动关系变化的下限与上限。
 * 模型（或离线规则）给出她的"真实感受"，引擎再 clamp 到这个区间 ——
 * 下限为负是有意的：**她可以不喜欢你刚才那句话**，关系会掉。
 */
export const AFFINITY_DELTA_MIN = -3;
export const AFFINITY_DELTA_MAX = 6;

/**
 * 调试开关。
 * true  → 阈值整体压低，方便快速走完四幕看效果（**当前是这档**）。
 * false → 回到剧本原值 50 / 150 / 350 / 700。
 * 上线前记得改成 false。
 */
export const DEBUG_STORY = false;

/**
 * 剧本原值（用户给的四个节点）。
 * **这四个数不许改** —— 它们是设计意图。调试想快就压 DEBUG_THRESHOLDS，
 * 别动这里。测试会盯着这一组值不许漂移。
 */
export const SCRIPT_THRESHOLDS = {
  CONFESS: 50,
  GIFT_FUMBLE: 150,
  AWAKEN: 350,
  PHYSICAL: 700,
} as const;

/** 调试值：压低到一眼就能摸到每一幕 */
const DEBUG_THRESHOLDS = {
  CONFESS: 12,
  GIFT_FUMBLE: 30,
  AWAKEN: 55,
  PHYSICAL: 90,
} as const;

/** 主线里程碑（关系进展阈值） */
export const STORY = DEBUG_STORY ? DEBUG_THRESHOLDS : SCRIPT_THRESHOLDS;

/** 买下跨界实体转换器要花的金币（调试期同样压低，否则还得先打 11 次工） */
export const PHYSICAL_COST = DEBUG_STORY ? 500 : 2000;

export type Milestone = 'confess' | 'giftFumble' | 'awaken' | 'physical';

/** 关系进展落在哪个阶段（"实体买了没有"是另一回事，看 hasPhysical） */
export function phaseFor(affinity: number): StoryPhase {
  if (affinity >= STORY.PHYSICAL) return 2;
  if (affinity >= STORY.AWAKEN) return 1;
  return 0;
}

/**
 * 下一个"够格了但还没触发"的一次性里程碑。
 * 一次只返回一个，保证剧情按顺序播，不会因为跳级而漏掉中间那幕。
 */
export function dueMilestone(
  affinity: number,
  coins: number,
  story: StoryProgress,
): Milestone | null {
  if (!story.confessionAt && affinity >= STORY.CONFESS) return 'confess';
  if (!story.giftFumbleAt && affinity >= STORY.GIFT_FUMBLE) return 'giftFumble';
  if (!story.awakenedAt && affinity >= STORY.AWAKEN) return 'awaken';
  if (!story.physicalAt && affinity >= STORY.PHYSICAL && coins >= PHYSICAL_COST) return 'physical';
  return null;
}
