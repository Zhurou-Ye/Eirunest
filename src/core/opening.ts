/**
 * 开场固定对话（不耗 token）。
 *
 * 剧情背景：
 * 她因想查明外婆悲伤一生的原因，违背遗训添加了一个陌生微信。
 * 真相在后续聊天中逐步揭开，开场不主动提及遗物。
 *
 * 她说出口的理由是「做梦梦到了你的微信号」——这是谎：真实目的是想试探
 * 对方知不知道外婆过世的真相，但怕吓到他，好感够了（坦白那一幕）才敢说。
 * 所以每种性格的开场都要把这句轻喜剧版本的谎说圆，并且**不能剧透**。
 *
 * 结尾一律是"邀请继续聊"，不能是道别——道别句会和模型接下来的回复撞成
 * 精分（她说"下次见"，下一句又问"你在吗"）。
 */

import type { Gender, PersonalityPreset } from './types';

export interface OpeningLine {
  text: string;
  /** 发送时间偏移（"剧情分钟"），从接受好友申请算起 */
  delayMin: number;
}

/**
 * 一条"剧情分钟"折算成多少真实毫秒。
 * 1 分钟 ≈ 4 秒，于是整段开场白会在约 35 秒里一条条慢慢展开，
 * 像真人一个字一个字打完发出来，而不是一秒钟全砸出来。
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
  // 玩家没填名字时 store 会兜底成"你"。直接把"你"塞进句子里会读成
  // "嗯……你对吧" 这种怪话，所以没真名时改用不喊名字的说法。
  const who = playerName && playerName !== '你' ? playerName : '';

  // 前三句所有性格共用：打招呼 → 铺垫 → 把"梦"说出口。
  const base: OpeningLine[] = [
    {
      delayMin: 0,
      text: '你好！谢谢你通过好友申请。',
    },
    {
      delayMin: 1.2,
      text: `我叫${herName}。……接下来的事，你可能觉得离谱。`,
    },
    {
      delayMin: 2.8,
      text: '我做梦梦到了你的微信号。醒来还记得，一个数字都不差。',
    },
  ];

  // 中段按性格微调：都在给"梦"找补，并留下"其实还有别的事，但现在不敢说"的引子
  const mid: OpeningLine[] = [];
  let end: OpeningLine;
  if (preset === 'sunny') {
    mid.push(
      who
        ? { delayMin: 4.6, text: `${who}！很像是轻小说开局吧！我自己都吓了一跳！` }
        : { delayMin: 4.6, text: '很像是轻小说开局吧！我自己都吓了一跳！' },
    );
    mid.push({
      delayMin: 6.6,
      text: '其实梦里还乱糟糟的，有些东西我现在不敢讲……怕把你笑到。',
    });
    end = { delayMin: 8.6, text: '总之以后请多指教啦！我们慢慢聊。' };
  } else if (preset === 'gentle') {
    mid.push(
      who
        ? { delayMin: 4.6, text: `${who}……嗯，我知道很难信。可以先不把我当正常人。` }
        : { delayMin: 4.6, text: '……嗯，我知道很难信。可以先不把我当正常人。' },
    );
    mid.push({
      delayMin: 6.6,
      text: '其实我还有些事想问你。不过不着急，可以慢慢来吗？',
    });
    end = { delayMin: 8.6, text: '那……从今天开始，请多指教。' };
  } else if (preset === 'cool') {
    mid.push(
      who
        ? { delayMin: 4.6, text: `……${who}，对吧。别笑，我自己知道很荒唐。` }
        : { delayMin: 4.6, text: '……别笑，我自己知道很荒唐。' },
    );
    mid.push({
      delayMin: 6.6,
      text: '加都加了。反正只是个梦……而已。',
    });
    end = { delayMin: 8.6, text: '嗯。……总之，以后有事就说。' };
  } else {
    // clingy
    mid.push(
      who
        ? { delayMin: 4.6, text: `${who}！你居然真的通过了……谢谢你！` }
        : { delayMin: 4.6, text: '你居然真的通过了……谢谢你！' },
    );
    mid.push({
      delayMin: 6.6,
      text: '我、我还有点紧张……但梦的事是真的哦，我保证！',
    });
    end = { delayMin: 8.6, text: '那、那我们慢慢聊！我会尽量不吵到你的……' };
  }

  return [...base, ...mid, end];
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
