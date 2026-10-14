import type { Gender } from './types';

/**
 * 性别措辞唯一来源。
 * 所有面向玩家 / 面向模型的文案都必须经过这里产出，避免"她/他"、"少年/少女"写死导致错配。
 */

export function pronoun(g: Gender): '他' | '她' {
  return g === 'male' ? '他' : '她';
}

export function youth(g: Gender): '少年' | '少女' {
  return g === 'male' ? '少年' : '少女';
}

export function genderCn(g: Gender): '男生' | '女生' {
  return g === 'male' ? '男生' : '女生';
}
