/**
 * 开局固定对话剧本（分支树，不耗 token）。
 *
 * 剧情背景：
 * 她因想查明外婆悲伤一生的原因，违背遗训添加了一个陌生微信。
 * 她说出口的理由是「做梦梦到了你的微信号」——这是谎：真实目的是想试探
 * 对方知不知道外婆过世的真相，但怕吓到他，好感够了（坦白那一幕）才敢说。
 *
 * 剧本结构（2026-10-16 用户给定）：
 *   系统提示（好友验证通过）→ 她澄清不是骗子 → 分支1（调侃/反诈）
 *   → 讲梦 → 分支2（玄学/考试答案·彩票）→ 汇合 → 分支3（缘分/看戏）
 *   → 自我介绍 → 固定收尾 → 她道别 → 自由聊天
 *
 * 设计约束：
 *   - 每一"层"她说完就停，等玩家从快捷回复里选一句；选完才播下一层。
 *   - 玩家直接打字（不走快捷回复）= 放弃剧本：取消未播的台词，交给模型自由聊。
 *   - 刷新页面后从聊天记录重建进度（最后一条她的台词能定位到当前节点）。
 */

import type { Gender, PersonalityPreset } from './types';

export interface OpeningChoice {
  /** 快捷回复按钮上的文字（也就是玩家发出去的那句） */
  label: string;
  /** 点完后接着跑的节点 */
  next: OpeningNode;
}

export interface OpeningNode {
  /** 她依次发的话（逐条送达） */
  her: string[];
  /** 她说完时玩家心里的声音（OS，大字呈现） */
  os?: string;
  /** 发完后等玩家选；没有 = 剧本结束，回到自由聊天 */
  options?: OpeningChoice[];
}

/** 一条"剧情分钟"折算成多少真实毫秒。1 分钟 ≈ 4 秒，像真人在打字。 */
export const OPENING_MS_PER_MIN = 4_000;

/** 层内每条台词的间隔（剧情分钟） */
const BEAT = 0.9;

function beats(lines: string[]): Array<{ text: string; delayMin: number }> {
  return lines.map((text, i) => ({ text, delayMin: i * BEAT }));
}

/** 第三层汇合后的两个态度选项（调侃/反诈两条路都汇到这儿）。
 *  自我介绍 + 结尾固定对话连成一层，最后只问一次"请多指教"。 */
function warmChoices(herName: string, student: boolean): OpeningChoice[] {
  const intro = student
    ? `我叫${herName}，是个普通的高中生，平时除了上课写作业，最喜欢捣鼓各种吃的和奇奇怪怪的小玩意儿。`
    : `我叫${herName}，是个再普通不过的上班族，平时除了上班，最喜欢捣鼓各种吃的和奇奇怪怪的小玩意儿。`;
  return [
    {
      label: '删啥呀，多好玩啊，四舍五入算咱俩有玄学缘分了~',
      next: {
        her: [
          '嘿嘿，太好了！感觉你这个人好好玩、也很好说话呢！（心里松了一口气）',
          '那……既然都打扰到你了，自我介绍一下吧！',
          intro,
          '虽然这个开头有点莫名其妙……但既然能凭着梦里的数字搜到你，感觉真的很神奇！',
          '那……以后我们可以顺其自然地做个朋友吗？(๑•̀ㅂ•́)و',
        ],
        os: '嗯……不像坏人。还挺有意思一人。',
        options: [
          {
            label: '行啊，那就请多指教啦，神秘的「梦中友人」~',
            next: goodbye(student),
          },
        ],
      },
    },
    {
      label: '不删不删，我还等着看这个「梦里蹦出来的微信号」后续有啥新剧情呢（搬砖观影）',
      next: {
        her: [
          '哈哈哈哈你居然还带看戏的！不过你性格真好，一点都不凶！',
          '那……既然都打扰到你了，自我介绍一下吧！',
          intro,
          '虽然这个开头有点莫名其妙……但既然能凭着梦里的数字搜到你，感觉真的很神奇！',
          '那……以后我们可以顺其自然地做个朋友吗？(๑•̀ㅂ•́)و',
        ],
        os: '噗……这人有点意思。',
        options: [
          {
            label: '行啊，那就请多指教啦，神秘的「梦中友人」~',
            next: goodbye(student),
          },
        ],
      },
    },
  ];
}

/** 结尾道别（试探成功，初步信任建立）→ 剧本结束，回到自由聊天 */
function goodbye(student: boolean): OpeningNode {
  return {
    her: [
      '收到！请多指教！',
      student
        ? '呀，不跟你吹水啦，我得赶快去补今天的作业了……不然明天又要被老师盯上了，惨惨惨！(>_<)'
        : '呀，不跟你聊了，我今天还得加个班……不然明天又要被主管盯上了，惨惨！(>_<)',
      '那先这样啦，等我有空或者又做了什么奇怪的梦再来找你玩！拜拜~',
    ],
    os: '神秘的梦中友人……哼，行吧。',
  };
}

/** 子分支 1（玄学/同桌号码）的后续：两条路共用，仅细节不同 */
function skepticNext(extra: string, warm: OpeningChoice[]): OpeningNode {
  return {
    her: [
      '我也怀疑过！但我翻遍了班级群通讯录，真的没这个人！',
      `按理说梦里的数字醒了就该忘的，${extra}`,
      '突然加你真的挺冒昧的，如果你觉得怪怪的，随时把我删掉也没关系的！',
    ],
    os: '做梦梦到的？！这展开怎么跟轻小说一样……',
    options: warm,
  };
}

export interface OpeningScript {
  root: OpeningNode;
  /** 最后一条她的台词 → 该节点（所有节点，供刷新后重建进度 / 播 OS） */
  nodeByLastLine: Map<string, OpeningNode>;
}

/**
 * 生成某个性格的开局剧本。
 * sunny（Haru）按用户原稿；其余性格同结构、换语气。
 */
export function buildOpeningScript(
  preset: PersonalityPreset,
  _gender: Gender,
  herName: string,
  _playerName: string,
): OpeningScript {
  const student = preset !== 'cool'; // Natori 是上班族
  const school = student ? '上学路上' : '下班路上';
  const homework = student ? '今晚我都写不下去作业了' : '今晚我都睡不着了';

  // ── 第一层：澄清 + 分支 1 ──
  const root: OpeningNode = {
    her: [
      '那个！你好呀！非常抱歉打扰了！(>_<)',
      '先澄清一下，我真的不是推销的，也不是骗子！我也不是什么奇怪的怪人！',
    ],
    os: '……啊？有人加我微信？我这号码除了我妈没人知道啊。',
    options: [],
  };

  // 分支 A：玩家调侃（卖茶叶）
  const dreamAfterTease: OpeningNode = {
    her: [
      '噗哈哈哈！那你这茶叶推销员也太不专业了吧！',
      '呼……愿意理我太好了（拍胸口），我还以为会被直接拉黑掉呢。',
      '事情是这样的……说出来你可能觉得我在编故事，我昨晚做了一个超级奇奇怪怪的梦。',
      '梦里有个声音一直在念一串数字，说是很重要的联系方式。我今天' +
        school +
        '脑子一抽，就顺手在微信搜了一下……结果居然真搜出来一个人！',
      '当时手比脑子快，直接点了申请……（捂脸）',
      '我真不是故意冒犯你的！',
    ],
    os: '做梦梦到的？！这展开怎么跟轻小说一样……',
    options: [],
  };

  // 分支 B：玩家反诈
  const dreamAfterAntiFraud: OpeningNode = {
    her: [
      '哇，好敏锐的反诈意识！但我真的不是啦！',
      '事情是这样的……说出来你可能觉得我在编故事，我昨晚做了一个超级奇奇怪怪的梦。',
      '梦里有个声音一直在念一串数字，说是很重要的联系方式。我醒了之后居然还清清楚楚地记得！',
      '然后今天' + school + '脑子一抽，就抱着「试试看」的心态搜了一下……结果居然真的搜到了一个活生生的人！',
      '当时手比脑子快，直接点了申请……（捂脸）',
    ],
    os: '做梦梦到的？！这展开怎么跟轻小说一样……',
    options: [],
  };

  // ── 汇合点：删不删 ──
  const warm = warmChoices(herName, student);

  // 子分支：考试大题答案
  const examJoke: OpeningNode = {
    her: [
      '呜呜要是念了答案，我现在肯定已经在狂背步骤了，哪还会在这儿瑟瑟发抖地发微信啊！',
      '不过说真的，我也觉得超级不可思议……',
      '突然加你真的挺冒昧的，如果你觉得怪怪的，随时把我删掉也没关系的！',
    ],
    os: '她居然真的在认真解释……',
    options: warm,
  };

  // 子分支：彩票中奖号
  const lottoJoke: OpeningNode = {
    her: [
      '噗，要是念了彩票中奖号，我现在肯定已经在快乐选零食了，哪还会在这儿瑟瑟发抖地发微信啊哈哈！',
      '不过说真的，我也觉得超级不可思议……',
      `这串数字今天一整天都在我脑子里转，感觉不发个验证，${homework}。`,
      '突然加你真的挺冒昧的，如果你觉得怪怪的，随时把我删掉也没关系的！',
    ],
    os: '她居然真的在认真解释……',
    options: warm,
  };

  const skepticA = skepticNext('但今天晚自习的时候这串数字一直在脑子里循环播放……感觉不发个验证，我今天连作业都写不进去了。', warm);
  const skepticB = skepticNext(`但今天一整天我都在想这件事，感觉不发个验证，${homework}。`, warm);

  dreamAfterTease.options = [
    { label: '这也太玄学了吧……你确定不是把你同桌手机号给梦到了？', next: skepticA },
    { label: '那你梦里那个声音，顺便念下周考试的最后一道大题答案了吗？', next: examJoke },
  ];
  dreamAfterAntiFraud.options = [
    { label: '这也太玄学了吧……你确定不是把你同桌手机号给梦到了？', next: skepticB },
    { label: '梦里念手机号？那顺便念彩票中奖号码了吗，带我一个？', next: lottoJoke },
  ];

  root.options = [
    { label: '巧了，我刚想说我是卖茶叶的（狗头）', next: dreamAfterTease },
    { label: '反诈中心提醒您：开口就强调自己不是骗子的，先怀疑三分！', next: dreamAfterAntiFraud },
  ];

  // 收集「最后一条台词 → 选项」，供刷新后重建进度
  const nodeByLastLine = new Map<string, OpeningNode>();
  const seen = new Set<OpeningNode>();
  const walk = (n: OpeningNode): void => {
    if (seen.has(n)) return;
    seen.add(n);
    nodeByLastLine.set(n.her[n.her.length - 1], n);
    n.options?.forEach((o) => walk(o.next));
  };
  walk(root);

  return { root, nodeByLastLine };
}

/** 系统提示：通过好友验证后微信自动发的那条灰字（真微信原文） */
export const FRIEND_VERIFIED_SYS =
  '我通过了你的朋友验证请求，现在我们可以开始聊天了';

/**
 * 把剧本某一层的台词排成"一条条送达"的队列项。
 * 落在"我的手机 / 和她"的会话里（owner='me', contactId='her'）。
 * dueAt 用墙钟毫秒，所以关掉页面再回来也接得上。
 */
export function scheduleNode(
  node: OpeningNode,
  baseNowMs = Date.now(),
  msPerMin = OPENING_MS_PER_MIN,
): Array<{ owner: 'me'; contactId: 'her'; from: 'her'; text: string; dueAt: number }> {
  return beats(node.her).map((l) => ({
    owner: 'me' as const,
    contactId: 'her' as const,
    from: 'her' as const,
    text: l.text,
    dueAt: baseNowMs + l.delayMin * msPerMin,
  }));
}
