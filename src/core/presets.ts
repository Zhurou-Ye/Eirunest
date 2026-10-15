import type { Appearance, Personality, PersonalityPreset, Traits } from './types';

/**
 * 角色预设数据。
 * 单独成文件是为了打破 store <-> profile 的循环依赖：
 * 两边都从这里读，谁都不依赖谁。
 */

export const APPEARANCE_PRESETS: Record<string, Appearance> = {
  gentle: {
    hairColor: '#4a3b34',
    hairStyle: 'short',
    eyeColor: '#8a6b4f',
    skinTone: '#f6d9c4',
    outfit: 'sweater',
    height: 1.0,
  },
  cool: {
    hairColor: '#23262e',
    hairStyle: 'messy',
    eyeColor: '#5b7a99',
    skinTone: '#f2d3bd',
    outfit: 'hoodie',
    height: 1.04,
  },
  sunny: {
    hairColor: '#a4622f',
    hairStyle: 'messy',
    eyeColor: '#9c6b3a',
    skinTone: '#f8ddc7',
    outfit: 'sweater',
    height: 0.98,
  },
  clingy: {
    hairColor: '#3b2f3a',
    hairStyle: 'ponytail',
    eyeColor: '#7a5f8a',
    skinTone: '#f7dccb',
    outfit: 'hoodie',
    height: 0.95,
  },
};

export const PERSONALITY_PRESETS: Record<
  PersonalityPreset,
  Omit<Personality, 'name' | 'preset' | 'gender'>
> = {
  gentle: {
    firstPerson: '我',
    playerAddress: '你',
    tone: ['温和', '耐心', '爱照顾人', '说话慢一点'],
    shyThreshold: 0.6,
    initiative: 0.35,
    speechRate: 4.2,
  },
  cool: {
    firstPerson: '我',
    playerAddress: '你',
    tone: ['话少', '毒舌一点点', '但会认真回答', '不主动示弱'],
    shyThreshold: 0.3,
    initiative: 0.2,
    speechRate: 4.8,
  },
  sunny: {
    firstPerson: '我',
    playerAddress: '你',
    tone: ['开朗', '爱笑', '话题多', '喜欢分享日常'],
    shyThreshold: 0.7,
    initiative: 0.6,
    speechRate: 5.4,
  },
  clingy: {
    firstPerson: '我',
    playerAddress: '你',
    tone: ['依赖', '黏人', '容易脸红', '喜欢被在意'],
    shyThreshold: 0.85,
    initiative: 0.5,
    speechRate: 4.4,
  },
};

export const DEFAULT_NAMES: Record<PersonalityPreset, string> = {
  gentle: '林屿',
  cool: '江野',
  sunny: '夏河',
  clingy: '栗川',
};

/**
 * traits 的起始值。
 *
 * 注意这里只是"起点"，不是"设定"：进游戏之后这些数会被经历推动，
 * 同一副预设玩久了也可能跑到别的方向去——这正是我们要的效果。
 */
export const TRAIT_PRESETS: Record<PersonalityPreset, Traits> = {
  gentle: { expressiveness: 0.5, clinginess: 0.5, guardedness: 0.35 },
  cool: { expressiveness: 0.3, clinginess: 0.25, guardedness: 0.6 },
  sunny: { expressiveness: 0.75, clinginess: 0.5, guardedness: 0.3 },
  clingy: { expressiveness: 0.7, clinginess: 0.85, guardedness: 0.5 },
};

