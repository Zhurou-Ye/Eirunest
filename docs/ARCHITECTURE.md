# 技术架构文档

## 一、分层与数据流

```
玩家输入（触摸 / 对话 / 送礼）
        │
        ▼
┌─────────────────────────────────────┐
│ 引擎层 · 确定性代码 · 无 AI 参与     │
│                                     │
│  Game 主循环（game.ts）              │
│    ├─ RoomRenderer   场景与昼夜光照  │
│    ├─ CharacterRenderer 角色绘制     │
│    ├─ Animator       动画状态机      │
│    └─ Store          世界状态与存档  │
└─────────────────────────────────────┘
        │ 只读快照
        ▼
┌─────────────────────────────────────┐
│ ai/prompt.ts  组装上下文             │
│   - 性格卡（预设 + 自定义）          │
│   - 当前世界状态（时间/心情/精力）   │
│   - 检索出的长期记忆                 │
└─────────────────────────────────────┘
        │
        ▼
   大模型 API（OpenAI 兼容，可替换）
        │
        ▼
   { line, emotion, action, intensity, memorable }
        │
        ▼
┌─────────────────────────────────────┐
│ ai/mapping.ts  白名单映射 ← 唯一出口 │
│   枚举校验 / 数值 clamp / 文本截断   │
│   作息约束 / 害羞阈值                │
└─────────────────────────────────────┘
        │ 合法的 IntentSchema
        ▼
   引擎更新状态 + 触发动画 + 显示台词
```

## 二、为什么模型不能直接控制游戏

一个角色扮演模型很容易被诱导输出「我现在把亲密度改成 100」这类内容。如果模型输出直接进状态机，这就是一个提权漏洞。

所以模型输出被限制在 5 个字段里，且每个字段都有独立约束：

| 字段 | 类型 | 约束 | 违规时 |
|---|---|---|---|
| `line` | string | 长度 ≤ 120，剥离括号旁白 | 截断 / 用兜底台词 |
| `emotion` | enum | 6 个值白名单 | 降级为 `calm` |
| `action` | enum | 8 个值白名单 | 降级为 `idle` |
| `intensity` | number | clamp 到 [-1, 1] | 非数值则 0.3 |
| `memorable` | 0 \| 1 | 严格 | 其他值归 0 |

引擎侧还有两道后手：

1. **作息约束**（`reconcileAction`）：模型让角色白天睡觉，引擎会改掉。
2. **害羞阈值**（`resolveMood`）：模型说「开心」，低亲密度时引擎仍可判为害羞。

这两道都写在 `ai/mapping.ts`，属于「模型说了不算」的范畴。

### 验证

```bash
npm test
```

26 项测试，全部用真实攻击性输入：非法枚举、越界数值、万字文本、`(旁白)` 注入、非 JSON 返回、`__proto__` 原型污染、要求白天睡觉。

## 三、核心数据模型

完整定义见 `src/core/types.ts`。

### CharacterState — 角色状态

```ts
interface CharacterState {
  appearance: {
    hairColor, hairStyle, eyeColor, skinTone, outfit, height
  }
  personality: {
    preset, name, firstPerson, playerAddress,
    tone: string[],        // 进 prompt 的语调关键词
    shyThreshold: number,  // 越低越容易害羞
    initiative: number,    // 主动搭话概率
    speechRate: number     // 影响打字机与口型
  }
  mood: Mood              // 6 态：happy/calm/shy/sleepy/sulky/excited
  energy: Energy          // 4 态：fresh/okay/tired/exhausted
  moodValue: number       // 0~100，实际驱动 mood
  energyValue: number     // 0~100
  affinity: number        // 0~100 亲密度，核心长期指标
  activity: Activity      // 8 种当前动作
  phase: DayPhase         // 作息阶段
  likedGifts: string[]
  interactionCount: number
  lastSavedAt: number
  traits: {                // 会被经历改写的倾向，见第七节
    expressiveness         // 表达欲
    clinginess             // 黏人度
    guardedness            // 戒备心
  }
}
```

`mood` 是标签，`moodValue` 是数值 —— 引擎按数值算完再落成标签，避免手改标签造成状态不一致。

### RoomState — 房间状态

```ts
interface RoomState {
  lampOn: boolean        // 台灯：夜间影响心情与照明
  curtainOpen: boolean   // 窗帘：关窗帘降精力
  tidiness: number       // 0~100，杂乱轻微压低心情
  weather: Weather       // sunny/cloudy/rain/snow
  furniture: string[]
  props: string[]
}
```

### MemoryEntry — 长期记忆

```ts
interface MemoryEntry {
  id: string
  at: number        // 游戏内小时数，用于「多久以前」
  iso: string       // 真实时间
  kind: 'dialogue' | 'gift' | 'touch' | 'event' | 'milestone'
  summary: string   // 一句话，注入 prompt
  weight: number    // 1~5 重要度，影响检索排序
  tags: string[]    // 用于关键词匹配
}
```

记忆上限 200 条，超出丢弃最旧的，避免存档无限膨胀。

**检索**（`retrieveMemories`）按三个维度打分：重要度 × 2 + 时间接近度 + 关键词重合度。这是纯本地实现，攒到一定量级换成向量检索时，只需改这一个函数。

### SaveData — 存档

```ts
interface SaveData {
  version: number
  character: CharacterState
  room: RoomState
  memories: MemoryEntry[]
  timeline: RelationshipLog[]   // 按天聚合的关系曲线
  clock: number                 // 累计游戏内小时数
  playerName: string
}
```

存 localStorage，读失败降级为内存存档不阻塞游戏。版本号变更时合并默认值，防止旧存档缺字段。

## 四、动画系统

动画分两层，**都不认识 Live2D 的存在**。

### RigPose — 骨骼参数

`anim/rig.ts` 定义了 22 个参数，构成「姿势」的抽象描述：

```
身体: bodyOffsetY, torsoTilt, scale
头部: headPitch, headYaw
四肢: armL/R, elbowL/R, legL/R
面部: eyeOpen, browRaise, browAngle, gazeX/Y,
      mouthOpen, mouthSmile, blush
```

### Animator — 状态机

`anim/animator.ts` 每帧做的事：

1. **眨眼**：独立计时器，闭 70ms + 开 90ms，与说话口型叠加
2. **视线**：追踪触摸点，600ms 到位（模拟脖子惯性）；2.6 秒无输入后游移
3. **姿态合成**：`moodFace()` + `activityPose()` + 说话口型
4. **呼吸**：正弦波驱动身体起伏与躯干布料收放
5. **反应叠加**：摸头/惊讶/害羞/收礼的一次性动作曲线
6. **平滑逼近**：指数插值，避免姿态突跳

### CharacterRenderer — 渲染接口

```ts
interface CharacterRenderer {
  mount(canvas): void
  resize(w, h): void
  draw(pose, appearance, mood, timeSec): void
  hitTest(x, y): BodyPart | null
  dispose(): void
}
```

当前实现 `VectorCharacterRenderer`：用 Canvas 路径按骨骼参数逐帧绘制。呼吸、眨眼、视线偏移、嘴型开合、手臂抬起都是真实计算，不是贴图。

`Live2DCharacterRenderer` 已写好适配层但**未启用** —— 没有模型素材时启用只会得到空白画面。启用只需在 `game.ts` 换一行，引擎代码不动。

## 五、时间与作息

游戏内时间流速：**1 现实秒 = 1 游戏分钟**，即 1 现实分钟 = 1 游戏小时。

阶段划分（`clockToPhase`）：夜间 0-5 / 早晨 5-11 / 白天 11-17 / 傍晚 17-22 / 夜间 22-24。

作息自动换动作（`phaseDefaultActivity`）：

| 阶段 | 动作 |
|---|---|
| 夜间（精力 < 40） | 睡觉 |
| 夜间 | 休息 |
| 早晨 | 伸展 |
| 白天（精力 < 45） | 休息 |
| 白天 | 打游戏 |
| 傍晚 | 看书 |

玩家操作后会锁 3.5~9 秒，期间不自动切换，避免刚点完"一起做饭"就被系统改回看书。

**离线结算**：重新打开时按真实离开时长结算精力与心情，最多算 12 小时 —— 不封顶的话几天不玩回来直接角色枯竭，体验很差。

## 六、数值设计原则

亲密度是唯一的长期指标，刻意做得很轻：

- 同样的互动在低亲密度时收益更高，随亲密度递减（软上限 70 后开始收敛）
- 亲密度 > 90 后所有互动收益 × 0.35，防止后期数值爆炸
- 亲密度低时**更容易害羞**，与亲密度的心理预期一致

数值不是玩法主体。优先级永远低于「角色像不像一个活人」。

## 七、人格演化（`core/evolution.ts`）

这是整个项目里唯一属于**二阶变化**的部分：别的模块改的是"现在是多少"，它改的是"以后按什么规则变"。

```
一次经历（被回应 / 被冷落 / 被靠近 / 收到礼物 / 自己出门 / 你很久没来）
        │
        ▼
   traits：表达欲 / 黏人度 / 戒备心        ← 每次推动千分之几，攒出来的
        │
        ▼
   派生行为参数（effectiveStats）
   ├─ initiative      主动搭话概率（替代原来写死的 personality.initiative）
   ├─ shyThreshold    害羞阈值（喂给 resolveMood）
   ├─ outgoingBias    日程里"今天想出门"的概率倍率
   └─ moodLossPerHour 你不在时心情每小时掉多少
```

两条**故意做进去的非线性**，没有它们就只是线性漂移（那是统计，不是性格）：

- 戒备心越高，身体接触越难降低它：`scale = 1 - guardedness * 0.8`
- 越黏人，被冷落时黏人度涨得越快：`scale = 0.6 + clinginess * 0.9`

每次变动都写一条 `TraitPoint`（含可读原因），状态面板据此显示"最近是什么事让她变了一点"，所以"她变了"是**可回溯**的，不是黑箱。

### 离场期间的事件重演

`planOfflineEvents()` 把缺席窗口和她的日程块求交集，把"这段时间她去过哪"变成真实的照片、朋友圈与记忆；`foldOfflineIntoTraits()` 再让这一段回头影响 traits。

两个实现要点，都是踩过的坑：

- 按**日程块求交集**，不要按整点采样——她 20:30 才去的公园，逐整点采样会完全漏掉。
- 时钟锚定真实时间，所以回来后拿到的不是"重新算了一遍课表"，而是"按这段窗口重演发生过的事"。

### 测试

```bash
npm run test:evolution
```

18 项。核心的一条是：**同一个预设，被回应 200 次和被冷落 200 次，主动概率会拉开 0.15 以上**——如果这条不成立，"人格由机制长期积累"就只是说法。

## 八、扩展点

| 想做什么 | 改哪里 |
|---|---|
| 换 Live2D / 分层立绘 | 实现 `CharacterRenderer`，在 `game.ts` 换实例 |
| 加新动作 | `types.ts` 的 `Activity` + `rig.ts` 的 `activityPose()` |
| 加新表情 | `types.ts` 的 `EMOTIONS` + `rig.ts` 的 `moodFace()` |
| 加新房间/场景 | 新建 Renderer，参考 `room.ts` |
| 接向量记忆 | 只改 `ai/prompt.ts` 的 `retrieveMemories` |
| 接云存档 | 只改 `core/store.ts` 的 `Store` 读写方法 |
| 换模型服务 | `ai/client.ts` 的 `requestReply`，协议兼容即可 |
| 加语音 | `game.ts` 的 `say()` 里接入音频队列 |
| 加一类新经历 | `evolution.ts` 的 `ExperienceKind` + `EFFECTS` 表，再在触发点调 `applyExperience()` |
| 让新行为受人格影响 | 在 `effectiveStats()` 里加派生参数，再去消费它的地方读 |