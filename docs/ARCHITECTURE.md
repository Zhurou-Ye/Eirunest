# 技术架构

## 一、分层与数据流

```
玩家输入（触摸 / 对话 / 送礼 / 手机）
        │
        ▼
┌──────────────────────────────────────────┐
│ 引擎层 · 确定性代码 · 不含 AI             │
│                                          │
│  Game 主循环（game.ts）                   │
│    ├─ RoomRenderer      场景 / 昼夜 / 阴影 │
│    ├─ Live2DCharacterRenderer  角色与触摸  │
│    ├─ Store             状态 + 存档 + 时钟 │
│    └─ world.ts          日程 / 地点 / 打工 │
└──────────────────────────────────────────┘
        │ 只读快照
        ▼
┌──────────────────────────────────────────┐
│ ai/prompt.ts  组装上下文                  │
│   人设 / 世界状态 / 她此刻在哪 / 记忆检索  │
└──────────────────────────────────────────┘
        │
        ▼
   大模型（云端免密钥 ｜ OpenAI 兼容 ｜ 离线）
        │
        ▼
   { line, emotion, action, intensity, memorable }
        │
        ▼
┌──────────────────────────────────────────┐
│ ai/mapping.ts  白名单映射 ← 唯一出口      │
│   枚举校验 / clamp / 截断 / 作息 / 害羞阈值│
└──────────────────────────────────────────┘
        │
        ▼
   引擎更新状态 → 触发动作与表情 → 台词
```

## 二、模型说了不算

一个角色扮演模型很容易被诱导输出「把亲密度改成 100」。若模型输出直接进状态机，就是一个提权漏洞。

因此模型输出被限制在 5 个字段，每个字段独立校验（`src/ai/mapping.ts`）：

| 字段 | 约束 | 违规时 |
|---|---|---|
| `line` | ≤ 120 字，剥离括号旁白 | 截断 / 兜底台词 |
| `emotion` | 6 值白名单 | 降级 `calm` |
| `action` | 8 值白名单 | 降级 `idle` |
| `intensity` | clamp `[-1, 1]` | 非数值归 0.3 |
| `memorable` | `0 \| 1` | 其他归 0 |

引擎侧还有两道后手：

1. **作息约束**（`reconcileAction`）—— 模型让角色白天睡觉，引擎改掉。
2. **害羞阈值**（`resolveMood`）—— 模型说"开心"，低亲密度时引擎仍可判为害羞。

```bash
npm test    # 26 项：非法枚举、越界数值、万字文本、(旁白) 注入、
            # 非 JSON 返回、__proto__ 原型污染、要求白天睡觉
```

## 三、数据模型

完整定义见 `src/core/types.ts`。一次存档（`SaveData`）里主要有：

| 字段 | 说明 |
|---|---|
| `profileId` | 当前立绘档案（= 当前角色） |
| `character` | 角色状态：心情 / 精力 / 亲密度 / 活动 / 作息阶段 |
| `room` | 房间状态：台灯 / 窗帘 / 整洁度 / 天气 |
| `memories` | 长期记忆，**每条带 `profileId`**（换人不串） |
| `diary` | 她的日记（带 `profileId`） |
| `herPlan` | **她今天的日程**（跨天重建） |
| `photos` / `moments` | 她的相册 / 朋友圈（朋友圈含 `author` 与 `comments`） |
| `threads` | 微信会话（`owner: 'her' \| 'me'`，带 `profileId`） |
| `myDiary` / `myPlan` | 我自己的日记与日程 |
| `clock` / `timeOffset` | 显示时间 = 真实时间 + 偏移 |
| `coins` / `ownedAccessories` / `equippedAccessories` | 经济与配件 |

### 存档兼容

`SAVE_VERSION` 变更或新增字段时，`Store.load()` 会与 `createDefaultSave()` 做浅合并，并**显式补全新加字段**（`photos` / `threads` / `myDiary` / `moments[].comments` 等），避免旧存档渲染时读到 `undefined`。

localStorage 读写失败会降级为内存存档，不阻塞游戏。

## 四、时间与日程

### 时钟

`clock` **始终锚定真实本地时间**，玩家手动设定只改 `timeOffset`：

```ts
d.clock = realHours() + d.timeOffset;
```

于是"设到 08:30"之后时钟会从 08:30 继续走，而不是冻住。`clockToPhase()` 把小时映射成 `morning / noon / evening / night`。

> UI 侧有个坑：时间输入框每帧被回写会让刚选好的值被打回原样。`hud.ts` 用 `timeDirty` 标记解决 —— 用户一改动就停止回写，直到点「设定 / 同步现在」。

### 她的日程

`core/world.ts` 的 `buildHerPlan()`：

```
固定作息（学生跑学校 / 上班族跑公司）
  + 她的兼职（profile.job，定了必须去）
  + 空档里"她自己想去"的地方（按性格加权的候选池）
```

- 用 `hash(profileId#day) → mulberry32` 做**种子随机**：同一天稳定、跨天重建。
- 每个时段是一个 `PlanBlock { start, end, placeId, kind, label }`，`kind` 取 `commit`（必须去）/ `want`（她想去）/ `rest`（在家）。
- `planAt(blocks, hour)` 取某时刻的块 → 决定她在哪、头顶提示什么。
- 出门时会**顺手拍一张照片、发一条朋友圈、给某个联系人发条消息**（同行程去重）。

`herPlaceAt()` 是早期的纯时间表实现，已被日程取代（保留作兜底）。

### 打工

`JOBS` 里每份工带 `open: [开始, 结束)` 与可选的 `days`。`isJobOpen()` 决定按钮是否可点；`startJob()` 也会二次校验，非营业时间直接拦下并提示营业时间。

## 五、两台手机 / 微信

`ui/hud.ts` 的 `createPhone(owner)` 是同一个组件，`owner` 决定视角：

| | 她的手机 | 我的手机 |
|---|---|---|
| 会话 | 她和同学 / 同事 / 家人 | 我和她 |
| 输入框 | 无（只读，不能替她发） | 有 |
| 我的页面 | 相册 / 日记 / 日程（只读） | 相册 / 写日记 / 排日程 |
| 朋友圈 | 只能看、点赞 | 还能**发布**，她会回评 |

底部是微信式四页：**微信 / 通讯录 / 发现 / 我**，子页（聊天、朋友圈、相册、日记、日程）带返回栏，返回会回到进入时的那个 tab。

### 一份记录，两台手机

你和她只有**一份**对话记录，存在 `threads` 里（`owner: 'me'`、`contactId: 'her'`）。渲染时按"这台手机是不是记录的主人"决定气泡在哪边：

```ts
function isMineMsg(msg, threadOwner) {
  // 同一台手机内：'owner' 是机主；跨手机镜像查看时，'her' 才是机主
  return threadOwner === owner ? msg.from === 'owner' : msg.from === 'her';
}
```

好处：头顶气泡、桌面聊天框、手机微信三处永远一致，而且**对话会存档**（此前聊天记录只存在内存里）。

未读角标只在"她不在家（= 在给你发消息）"时累加 —— 当面说话不算消息。

## 六、Live2D 接入

`src/render/live2d.ts` 是唯一个案，引擎其余部分不认识 Live2D。

| 能力 | 做法 |
|---|---|
| 精确触摸 | `renderer.extract.canvas(model)` 读 alpha 求真实轮廓 → 归一化成 `silhouette`，再按人体比例分带映射到头 / 脸 / 躯干 / 腿 |
| 站立不悬空 | **脚部锚点** `anchor.set(0.5, silhouette.b)`，把脚钉在地面线；`room.ts` 在脚下画接触阴影 |
| 换模型不掉大小 | 按"人物可见高度占屏比例"自动反推 `scale`，任何模型都缩放到同一屏幕身高 |
| 配件贴脸 | 读 `internalModel.hitAreas.Head` 的 drawable **实时包围盒**，经 `localTransform → worldTransform` 映射到屏幕，配件逐帧跟随 |
| 动作组 | 组名区分大小写（`Idle` / `TapBody`），播放前按 `motionManager.definitions` **夹取索引**，避免越界后静默失败 |

### moc3 版本约束（重要）

`public/vendor/` 的 `live2dcubismcore@1.0.2` 是 **Cubism 4.2** 的 Core，只能加载 moc3 **v1~v4**。

- Haru / Natori：moc3 v1 ✅
- `develop` 分支的 Mao：moc3 **v5** ❌（`createCoreModel` 直接报错）
- `develop` 分支的 Ren：moc3 **v6** ❌

所以 `scripts/fetch-live2d-models.mjs` 钉死在 **`4-r.7`**（最后一个 Cubism 4 发布），它的 Mao 是 moc3 v4。换 tag 前务必确认目标模型的 moc3 版本 ≤ 4。

## 七、UI 结构

`ui/hud.ts` 用原生 DOM 组织，没有框架：

```
stage
├─ canvas.layer      room / live2d  (+ .acc 配件叠加层)
├─ away-note         她出门时的提示卡
├─ hud
│   ├─ topbar        名字 / 时钟 / 金币 / 亲密 / 精力
│   ├─ bubble + log
│   ├─ ☰ drawer      对话 / 状态 / 记忆 / 互动 / 送礼 / 商城 / 地图 / 她的手机 / 我的手机
│   ├─ panel[...]    各浮层
│   └─ phone (×2)    createPhone('her') / createPhone('me')
└─ boot              选主控 + 选人设
```

刷新策略：面板只在"打开着"且**内容指纹变化**时重绘（`sigFor()`），避免每帧重建 DOM、也避免输入框被打断。

## 八、扩展点

| 想做什么 | 改哪里 |
|---|---|
| 加新地点 | `world.ts` 的 `PLACES`（含小地图归一化坐标 `mx/my`） |
| 加她的兼职 | `profile.ts` 里给档案加 `job` |
| 改日程规则 | `world.ts` 的 `buildHerPlan()` |
| 加打工 | `world.ts` 的 `JOBS`（含营业时间） |
| 加微信页面 | `hud.ts` 的 `createPhone()` → `bodyFor()` / `TITLES` |
| 加联系人 | `world.ts` 的 `herContacts()` / `myContacts()` |
| 换大模型 | `ai/client.ts` 的 `requestReply / requestDiary / requestMomentComment` |
| 接向量记忆 | 只改 `ai/prompt.ts` 的记忆检索函数 |
| 换渲染方式 | 实现 `render/renderer.ts` 的 `CharacterRenderer`，在 `game.ts` 换实例 |
| 加新动作 / 表情 | `types.ts` 的 `ACTIONS` / `EMOTIONS` + `profile.ts` 的动作映射 |
