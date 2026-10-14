import type { Activity, Gender, Mood, Personality } from './types';
import type { HerJob, LifeType } from './world';

/**
 * 立绘档案（Character Profile）。
 *
 * 一份档案 = 一个角色 = 人设 + 渲染方式，两者捆绑切换。
 * 「换立绘」必然「换人」，不会出现同一副面孔配另一套性格的割裂感。
 */

export type RendererKind = 'live2d';

export interface RendererSpec {
  kind: RendererKind;
  /** 模型目录名：public/character/<dir>/<Name>.model3.json */
  modelDir: string;
  modelName: string;
  /** 情绪 → 表情名。名字取自模型 model3.json 的 Expressions[].Name（区分大小写） */
  expressionMap: Partial<Record<Mood, string>>;
  /** 活动 → 模型动作组。group 必须与 model3.json 的 Group 字段完全一致（区分大小写） */
  motionMap: Partial<Record<Activity, { group: string; index: number }>>;
  /** 模型缩放与水平/垂直位置。各模型尺寸差异大，必须按模型实机校准 */
  scale: number;
  /** 脚底落在屏幕高度的比例位置（地面线）。配合 live2d.ts 的脚部锚点使用 */
  floorYRatio: number;
  /** 角色水平中心在屏幕宽度的比例位置 */
  xRatio: number;
  /** 人物可见身体高度占屏比例（自动适配用）。缺省 0.76。不同模型原生尺寸差很多，靠它统一大小 */
  bodyHeightRatio?: number;
}

export interface CharacterProfile {
  id: string;
  /** 角色名 */
  name: string;
  /** 角色性别：决定"他/她""少年/少女"等全部措辞 */
  gender: Gender;
  /** 生活类型：学生（跑学校）/ 上班族（跑公司），决定白天的作息与去向 */
  life: LifeType;
  /** TA 自己的兼职。定了就必须去，会进每日日程（缺省=没有兼职） */
  job?: HerJob;
  /** 一句话人设，显示在选人界面 */
  tagline: string;
  /** 详细人设，进 prompt */
  persona: string;
  /** 选人界面用的简介标签 */
  tags: string[];
  personality: Personality;
  renderer: RendererSpec;
  likedGifts: string[];
}

/**
 * 动作组映射。
 *
 * 重要：组名必须与 model3.json 里的 Group 字段完全一致（区分大小写）。
 * 官方样例模型的组名是 "Idle" / "TapBody"（首字母大写），
 * pixi-live2d-display 不会做小写转换，写成 'idle' 会静默失败、人物僵着不动。
 *
 * 三套模型的索引范围：Idle 最少 2 个（0~1）、TapBody 最少 4 个（0~3），
 * 所以这里的索引都压在最小公共范围内，换人不会越界。
 */
const FULL_MOTION_MAP: Partial<Record<Activity, { group: string; index: number }>> = {
  idle: { group: 'Idle', index: 0 },
  resting: { group: 'Idle', index: 1 },
  sleeping: { group: 'Idle', index: 1 },
  stretching: { group: 'TapBody', index: 0 },
  reading: { group: 'TapBody', index: 1 },
  playing_game: { group: 'TapBody', index: 2 },
  cooking: { group: 'TapBody', index: 3 },
  talking: { group: 'Idle', index: 0 },
};

/**
 * 三套人设。
 *
 * 只用有 Head + Body 双 HitArea 的模型，否则「点身体」做不到部位准确。
 * Ren / Mark / Hiyori / Rice 已撤下：Ren 在软件渲染下 shader 超限，
 * Mark 无表情无触点，Hiyori / Rice 只有 Body 一个触点。
 *
 * ⚠️ 模型跑得动的前提是 moc3 版本匹配运行时：public/vendor 里的
 * live2dcubismcore 是 Cubism 4.2 的 Core，只能加载 moc3 v1~v4。
 * 所以 Mao 必须用 CubismWebSamples 的 4-r.7 tag（moc3 v4），不能用 develop
 * 里的 Mao（moc3 v5，会加载失败）。见 scripts/fetch-live2d-models.mjs 的说明。
 *
 * 人设是为「同居养成」重写的，与模型原设无关。
 */
export const PROFILES: CharacterProfile[] = [
  {
    id: 'haru',
    name: 'Haru',
    gender: 'female',
    life: 'student',
    // 周末在咖啡店打零工——定了就必须去
    job: { name: '咖啡店帮工', emoji: '☕', placeId: 'cafe', days: [0, 6], start: 13, end: 17 },
    tagline: '元气但粗心，总把"没事"挂在嘴边',
    persona:
      'Haru 是个看着就很有精神的少女。平时话多，遇到有意思的事会讲一大堆，' +
      '但粗心大意，经常丢三落四，被你发现后会嘴硬说"本来就没想带"。' +
      '其实心思很细，你情绪不对的时候她会第一个察觉，然后故意讲笑话逗你。' +
      '被夸会得意忘形，被摸头会愣一下然后说"别把我当小孩子"。',
    tags: ['元气', '粗心', '嘴硬'],
    personality: {
      preset: 'sunny',
      name: 'Haru',
      gender: 'female',
      firstPerson: '我',
      playerAddress: '你',
      tone: ['元气', '话多', '粗心', '嘴硬但心细'],
      shyThreshold: 0.7,
      initiative: 0.65,
      speechRate: 5.2,
    },
    renderer: {
      kind: 'live2d',
      modelDir: 'Haru',
      modelName: 'Haru',
      // F05 笑眼 / F02 惊讶张嘴 / F04 平静 / F01 微笑 / F08 低落
      expressionMap: {
        happy: 'F05',
        excited: 'F02',
        calm: 'F04',
        shy: 'F01',
        sleepy: 'F04',
        sulky: 'F08',
      },
      motionMap: FULL_MOTION_MAP,
      scale: 0.17,
      floorYRatio: 0.86,
      xRatio: 0.42,
    },
    likedGifts: ['cake', 'game', 'tea'],
  },
  {
    id: 'mao',
    name: 'Mao',
    gender: 'female',
    life: 'student',
    // 工作日在便利店上晚班——定了就必须去
    job: { name: '便利店店员', emoji: '🏪', placeId: 'store', days: [1, 2, 3, 4, 5], start: 17.5, end: 21 },
    tagline: '文静好学，安静待着也很自在',
    persona:
      'Mao 是个安静的女孩，话不多，但每句都想好了才说。喜欢看书，' +
      '你说话的时候会认真听完再回应，不会打断你。' +
      '不太会主动要求什么，但你送她东西她会记很久，' +
      '之后某天突然拿出来说"这个我很喜欢"。被夸会脸红着低头。',
    tags: ['文静', '认真', '害羞'],
    personality: {
      preset: 'gentle',
      name: 'Mao',
      gender: 'female',
      firstPerson: '我',
      playerAddress: '你',
      tone: ['安静', '温柔', '认真', '不擅表达'],
      shyThreshold: 0.82,
      initiative: 0.3,
      speechRate: 3.8,
    },
    renderer: {
      kind: 'live2d',
      modelDir: 'Mao',
      modelName: 'Mao',
      // Mao 有 ParamCheek，exp_06 是带腮红的害羞
      expressionMap: {
        happy: 'exp_02',
        excited: 'exp_04',
        calm: 'exp_05',
        shy: 'exp_06',
        sleepy: 'exp_03',
        sulky: 'exp_08',
      },
      motionMap: FULL_MOTION_MAP,
      scale: 0.16,
      floorYRatio: 0.86,
      xRatio: 0.42,
    },
    likedGifts: ['book', 'tea', 'scarf'],
  },
  {
    id: 'natori',
    name: 'Natori',
    gender: 'male',
    life: 'worker',
    tagline: '嘴硬傲娇，嫌你烦却哪都在',
    persona:
      'Natori 是个话里带刺的少年，动不动就"别碰我""你好烦"，' +
      '但你真走开他又会跟过来。嫌弃你送的礼物，转头就收进柜子里。' +
      '被夸会装作没听见，然后一整天心情都挺好。' +
      '其实很在意你怎么看他，只是打死不承认。',
    tags: ['傲娇', '嘴硬', '心软'],
    personality: {
      preset: 'cool',
      name: 'Natori',
      gender: 'male',
      firstPerson: '我',
      playerAddress: '你',
      tone: ['傲娇', '嘴硬', '爱嫌弃人', '心软'],
      shyThreshold: 0.45,
      initiative: 0.22,
      speechRate: 4.6,
    },
    renderer: {
      kind: 'live2d',
      modelDir: 'Natori',
      modelName: 'Natori',
      expressionMap: {
        happy: 'Smile',
        excited: 'Surprised',
        calm: 'Normal',
        shy: 'Blushing',
        sleepy: 'Normal',
        sulky: 'Sad',
      },
      motionMap: FULL_MOTION_MAP,
      scale: 0.15,
      floorYRatio: 0.86,
      xRatio: 0.42,
    },
    likedGifts: ['game', 'cake', 'scarf'],
  },
];

export const DEFAULT_PROFILE_ID = 'haru';

export function getProfile(id: string | undefined | null): CharacterProfile {
  if (!id) return PROFILES[0];
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0];
}

/** 把档案应用到存档里的角色状态。 */
export function applyProfile(
  profile: CharacterProfile,
  target: {
    character: { personality: Personality; likedGifts: string[] };
    profileId: string;
  },
): void {
  target.character.personality = { ...profile.personality };
  target.character.likedGifts = [...profile.likedGifts];
  target.profileId = profile.id;
}

/** 情绪 → 表情名。没有映射时返回 undefined，渲染器应清空表情。 */
export function expressionFor(profile: CharacterProfile, mood: Mood): string | undefined {
  return profile.renderer.expressionMap[mood];
}

/** 活动 → 模型动作组。 */
export function motionFor(
  profile: CharacterProfile,
  activity: Activity,
): { group: string; index: number } | undefined {
  return profile.renderer.motionMap[activity] ?? profile.renderer.motionMap.idle;
}
