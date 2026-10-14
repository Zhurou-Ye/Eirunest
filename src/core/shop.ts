/**
 * 商城 / 配件目录。
 *
 * 配件是"叠加在角色身上的贴图"：一张去背景的 PNG，按部位锚点摆到头/脸/脖/手上。
 * 之所以走叠加而不是改 Live2D 本体：Live2D 把衣服烘进贴图并绑了骨骼，
 * 外部生成的图片没法随身体形变；而配饰多在头/手，叠加后影响很小、体验也自然。
 */

export type AccessorySlot = 'hat' | 'glasses' | 'scarf' | 'hairpin' | 'handheld';

/** 部位 → 角色锚点类型 */
export const SLOT_ANCHOR: Record<AccessorySlot, 'head' | 'face' | 'neck' | 'hand'> = {
  hat: 'head',
  hairpin: 'head',
  glasses: 'face',
  scarf: 'neck',
  handheld: 'hand',
};

export const SLOT_LABEL: Record<AccessorySlot, string> = {
  hat: '头饰',
  hairpin: '发饰',
  glasses: '眼镜',
  scarf: '围巾',
  handheld: '手持',
};

export interface Accessory {
  id: string;
  name: string;
  slot: AccessorySlot;
  price: number;
  /** 叠加图（public/accessories/<id>.png，透明背景） */
  asset: string;
  /** 展示用 emoji（列表缩略图兜底/装饰） */
  emoji: string;
  /** 宽度 = width × 角色实测头宽（各模型按头自动缩放） */
  width: number;
  /** 相对锚点的偏移（× 头宽；正=右/下） */
  offsetX: number;
  offsetY: number;
  desc: string;
}

export const ACCESSORIES: Accessory[] = [
  {
    id: 'beret',
    name: '奶油贝雷帽',
    slot: 'hat',
    price: 120,
    asset: '/accessories/beret.png',
    emoji: '🎩',
    width: 0.8,
    offsetX: 0,
    offsetY: 0,
    desc: '软软的，压一压会很开心。',
  },
  {
    id: 'glasses',
    name: '圆框眼镜',
    slot: 'glasses',
    price: 80,
    asset: '/accessories/glasses.png',
    emoji: '👓',
    width: 0.68,
    offsetX: 0,
    offsetY: 0,
    desc: '戴上会显得认真一点。',
  },
  {
    id: 'hairpin',
    name: '星星发夹',
    slot: 'hairpin',
    price: 60,
    asset: '/accessories/hairpin.png',
    emoji: '⭐',
    width: 0.32,
    offsetX: 0.32,
    offsetY: 0.02,
    desc: '一闪一闪的小星星。',
  },
  {
    id: 'flower',
    name: '小雏菊',
    slot: 'handheld',
    price: 90,
    asset: '/accessories/flower.png',
    emoji: '🌼',
    width: 0.55,
    offsetX: 0.04,
    offsetY: 0.02,
    desc: '路边摘的，想递给谁。',
  },
];

export function getAccessory(id: string): Accessory | undefined {
  return ACCESSORIES.find((a) => a.id === id);
}
