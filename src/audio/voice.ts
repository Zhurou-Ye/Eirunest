/**
 * 语音模块（浏览器免费 TTS）。
 *
 * 用 Web Speech API 的 speechSynthesis，零成本、零依赖、离线可用。
 * 缺点是音色机械、各平台表现不一，所以做成可开关的，
 * 以后接真 TTS 服务时只替换 speak() 内部即可。
 */

import type { Gender } from '../core/types';

export interface VoiceOptions {
  /** 语速 0.1~10 */
  rate: number;
  /** 音高 0~2 */
  pitch: number;
  /** 音量 0~1 */
  volume: number;
  enabled: boolean;
}

const DEFAULTS: VoiceOptions = {
  rate: 1.05,
  pitch: 1.25,
  volume: 0.9,
  enabled: true,
};

/** 不同性格用不同音高：傲娇偏低，元气偏高 */
const PRESET_PITCH: Record<string, number> = {
  sunny: 1.35,
  gentle: 1.15,
  cool: 0.9,
  clingy: 1.3,
};

/** 挑音色时用来匹配名字的关键词。各平台命名不统一，只能模糊匹配。 */
const FEMALE_HINTS = /female|女|晓|雅|莹|婷|mei|xiaoxiao|huihui|xiaoyi/i;
const MALE_HINTS = /male|男|云|阳|康|博|yang|yunxi|yunjian|kangkang|liang|zhiyu/i;

class Voice {
  private opts: VoiceOptions = { ...DEFAULTS };
  /** 浏览器要求用户交互后才能播放，第一次调用会失败 */
  private unlocked = false;
  private voices: SpeechSynthesisVoice[] = [];

  get available(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  get options(): VoiceOptions {
    return this.opts;
  }

  constructor() {
    if (!this.available) return;
    // 语音列表是异步加载的，且不同平台差异很大
    const load = () => {
      this.voices = window.speechSynthesis.getVoices();
    };
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
  }

  setEnabled(on: boolean): void {
    this.opts.enabled = on;
    if (!on) this.stop();
  }

  /** 在用户第一次真实点击时调用，解锁自动播放限制 */
  unlock(): void {
    if (!this.available || this.unlocked) return;
    this.unlocked = true;
    try {
      window.speechSynthesis.resume();
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 说一句话。
   * @param text 台词
   * @param preset 性格预设，用来选音高
   * @param gender 角色性别。必须传，否则男性角色会拿到女声 ——
   *               浏览器语音库里中文本地音色基本只有女声一档，
   *               不按性别挑就会全员同一个声音。
   */
  speak(text: string, preset?: string, gender: Gender = 'female'): void {
    if (!this.available || !this.opts.enabled) return;
    this.stop();

    const clean = text.replace(/[（(][^）)]{0,20}[）)]/g, '').trim();
    if (!clean) return;

    try {
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = 'zh-CN';
      u.rate = this.opts.rate;
      const basePitch = (preset && PRESET_PITCH[preset]) || this.opts.pitch;
      // 男性角色整体压低一档，和音色选择一起生效
      u.pitch = Math.max(0.1, Math.min(2, gender === 'male' ? basePitch * 0.78 : basePitch));
      u.volume = this.opts.volume;

      // 先挑中文音色，再按性别挑；挑不到就退回第一个中文音色，
      // 至少保证是中文发音，不会冒出英文腔。
      const zh = this.voices.filter(
        (v) => v.lang.toLowerCase().startsWith('zh') || /chinese|中文|普通话/i.test(v.name),
      );
      const hints = gender === 'male' ? MALE_HINTS : FEMALE_HINTS;
      const preferred = zh.find((v) => hints.test(v.name)) ?? zh[0];
      if (preferred) u.voice = preferred;

      window.speechSynthesis.speak(u);
    } catch (err) {
      console.warn('[voice] 播放失败', err);
    }
  }

  stop(): void {
    if (!this.available) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* 忽略 */
    }

  }
}

export const voice = new Voice();