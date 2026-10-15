/**
 * 开场固定对话（不耗 token）。
 *
 * 剧情背景：
 * 她因想查明外婆悲伤一生的原因，违背遗训添加了一个陌生微信。
 * 真相在后续聊天中逐步揭开，开场不主动提及遗物。
 *
 * 这一段对话每个角色有不同版本（性格 + 性别）。
 */

import type { Gender, PersonalityPreset } from './types';

export interface OpeningLine {
  text: string;
  /** 发送时间偏移（"剧情分钟"），从接受好友申请算起 */
  delayMin: number;
}

/**
 * 一条"剧情分钟"折算成多少真实毫秒。
 * 1 分钟 ≈ 4 秒，于是整段开场白（最长 10.8 分钟）会在约 43 秒里
 * 一条条慢慢展开，像真人一个字一个字打完发出来，而不是一秒钟全砸出来。
 */
export const OPENING_MS_PER_MIN = 4_000;

/**
 * 接受好友申请后，她会发过来的开场白。
 * 一次性写多句，她一条条按 delayMin 发。
 */
export function buildOpening(
  preset: PersonalityPreset,
  _gender: Gender,
  herName: string,
  playerName: string,
): OpeningLine[] {
  // 通用骨架
  // 玩家没填名字时 store 会兜底成"你"。直接把"你"塞进句子里会读成
  // "嗯……你对吧" 这种怪话，所以没真名时改用不喊名字的说法。
  const who = playerName && playerName !== '你' ? playerName : '';
  const base: OpeningLine[] = [
    {
      delayMin: 0,
      text: '你好！谢谢你通过好友申请。',
    },
    {
      delayMin: 1.5,
      text: `先自我介绍一下吧，我叫${herName}。`,
    },
    {
      delayMin: 2.4,
      text: '其实我也不知道该怎么开场……先打个招呼好了。',
    },
  ];

  // 按性格微调
  if (preset === 'gentle') {
    base.push({
      delayMin: 7.0,
      text: who ? `你叫${who}对吧？希望申请消息没吓到你。` : '希望申请消息没吓到你。',
    });
    base.push({
      delayMin: 8.5,
      text: '嗯……如果你想问我为什么加你，我可以慢慢说。',
    });
    base.push({
      delayMin: 9.6,
      text: '最近总觉得，好像在哪里见过你的名字。',
    });
  } else if (preset === 'sunny') {
    base.push({
      delayMin: 7.0,
      text: who ? `你叫${who}对吧！` : '很高兴认识你！',
    });
    base.push({
      delayMin: 7.5,
      text: '其实是做梦梦到你的微信号，醒来就记住了。听起来很离谱吧？',
    });
    base.push({
      delayMin: 9.0,
      text: '我也觉得像轻小说情节……可能只是巧合！',
    });
    base.push({
      delayMin: 10.5,
      text: '好了，先不聊这个。你最近在忙什么？',
    });
  } else if (preset === 'cool') {
    base.push({
      delayMin: 7.0,
      text: who ? `……${who}，对吧。` : '……很高兴认识你。',
    });
    base.push({
      delayMin: 8.0,
      text: '其实我做梦梦到过你的微信号。听起来很荒唐，所以先没敢说。',
    });
    base.push({
      delayMin: 9.0,
      text: '别误会，我只是做了个梦。嗯，就这样。',
    });
    base.push({
      delayMin: 10.5,
      text: '我没当回事。结果……加到了。',
    });
  } else {
    base.push({
      delayMin: 7.0,
      text: who ? `嗯……${who}对吧。` : '嗯……很高兴认识你。',
    });
    base.push({
      delayMin: 8.0,
      text: '你平时喜欢什么？我有点不太会找话题。',
    });
    base.push({
      delayMin: 9.5,
      text: '现在我也不懂。但既然到了，就先认识一下？',
    });
  }

  // 收尾一句都一样的希望
  base.push({
    delayMin: base[base.length - 1].delayMin + 2.0,
    text: '那我们先聊聊吧。下次见。',
  });

  return base;
}

/**
 * 把开场白排成"一条条送达"的队列项。
 * 落在"我的手机 / 和她"的会话里（owner='me', contactId='her'）。
 * dueAt 用墙钟毫秒，所以关掉页面再回来也接得上。
 */
export function scheduleOpening(
  lines: OpeningLine[],
  baseNowMs = Date.now(),
  msPerMin = OPENING_MS_PER_MIN,
): Array<{ owner: 'me'; contactId: 'her'; from: 'her'; text: string; dueAt: number }> {
  return lines.map((l) => ({
    owner: 'me' as const,
    contactId: 'her' as const,
    from: 'her' as const,
    text: l.text,
    dueAt: baseNowMs + l.delayMin * msPerMin,
  }));
}
