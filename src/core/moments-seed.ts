/**
 * 她"过去"的朋友圈（历史动态）加载器。
 *
 * 内容在 `drama/her-moments.json`——改文案、加动态只动那个 JSON。
 * 这里只负责在开局时把它们变成带**真实日期**的 moment：
 *   iso = 注册那一刻的真实时间 - daysAgo 天
 * 所以显示出来是「昨天 / 3天前 / 1周前 / 2.5个月前」这种相对日期，
 * 而不是写死的机械日期。
 */
import doc from '../../drama/her-moments.json';

export interface SeedMoment {
  id: string;
  /** 距今多少天（真实日期往前推） */
  daysAgo: number;
  /** 当天发布时刻（本地时间，HH:mm） */
  time: string;
  text: string;
  /** 配图说明（alt 文案），图片本身由 img 指 */
  caption?: string;
  /** 配图路径；空 = 不配图 */
  img?: string;
}

const DOC = doc as unknown as { moments: SeedMoment[] };

export const SEED_MOMENTS: SeedMoment[] = DOC.moments ?? [];
