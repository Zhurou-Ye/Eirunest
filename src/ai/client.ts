import {
  createWorkBuddyCloud,
  type ChatCompletionCreateParamsStreaming,
  type PublicLLMModel,
  type WorkBuddyCloudClient,
} from '@tencent-ai/workbuddy-cloud-sdk';
import type { IntentSchema, SaveData } from '../core/types';
import { formatClock, memoriesFor } from '../core/store';
import { youth } from '../core/gender';
import { CLOUD_CONFIG } from '../cloud.config';
import { extractJson, sanitizeIntent, type SafeIntent } from './mapping';
import { ACTIVITY_CN, buildContext, buildMessages, MOOD_CN } from './prompt';
import { offlineDiary, offlineReply } from './offline';

/**
 * 大模型适配层。优先级：
 *   1) 云端免密钥大模型（WorkBuddy 云服务 cloud.llm）——用户不用自己买 key
 *   2) 本地 OpenAI 兼容接口（用户在设置里填 baseUrl/key）——备选
 *   3) 内置离线规则回复——没有网络/额度时的兜底，保证随时能玩
 *
 * 无论走哪条，模型只能通过 IntentSchema 那几个白名单字段间接影响引擎。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export type ReplyProvider = 'cloud' | 'local' | 'offline';

const CONFIG_KEY = 'hearth-boy.llm.v1';

export function loadConfig(): LlmConfig {
  const fallback: LlmConfig = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.9,
    maxTokens: 220,
  };
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<LlmConfig>) };
  } catch {
    return fallback;
  }
}

export function saveConfig(cfg: LlmConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch (err) {
    console.warn('[llm] 配置保存失败', err);
  }
}

/** 是否配置了本地 OpenAI 兼容接口（备选路径） */
export function isOnline(cfg: LlmConfig): boolean {
  return Boolean(cfg.apiKey && cfg.model && cfg.baseUrl);
}

/** 云端免密钥大模型是否可用（激活过云服务就有 endpoint + publishableKey） */
export function cloudConfigured(): boolean {
  return Boolean(CLOUD_CONFIG.endpoint && CLOUD_CONFIG.publishableKey);
}

// ── 云端客户端（懒加载，只在前端真的要调模型时才建）──────────────
let cloud: WorkBuddyCloudClient | null = null;
function getCloud(): WorkBuddyCloudClient {
  if (!cloud) {
    cloud = createWorkBuddyCloud({
      endpoint: CLOUD_CONFIG.endpoint,
      publishableKey: CLOUD_CONFIG.publishableKey,
    });
  }
  return cloud;
}

let cachedModel: PublicLLMModel | null = null;
let modelResolved = false;

/**
 * 偏好列表：陪伴对话要"快、短、像人"，所以优先选**非推理**的快速对话模型，
 * 避免把 token 烧在思考上导致回复很慢甚至吐不出可见内容（实测 auto 会这样）。
 */
const PREFERRED_MODELS = [
  'hunyuan-chat',
  'glm-5.3-flash',
  'deepseek-v4.1-flash',
  'glm-4.6',
  'minimax-m2.5',
  'kimi-k2.6',
];

function pickModel(list: PublicLLMModel[]): PublicLLMModel | null {
  const ok = list.filter((m) => m.disabled !== true);
  for (const id of PREFERRED_MODELS) {
    const hit = ok.find((m) => m.id === id);
    if (hit) return hit;
  }
  return ok.find((m) => m.isDefault) ?? ok[0] ?? null;
}

/** 拉一次模型清单，挑一个可用模型（空清单是合法结果，返回 null 走兜底）。 */
async function resolveCloudModel(signal?: AbortSignal): Promise<PublicLLMModel | null> {
  if (modelResolved) return cachedModel;
  const list = await getCloud().llm.models.list(signal);
  cachedModel = pickModel(list);
  modelResolved = true;
  return cachedModel;
}

/** 把云端错误转成一句人话，用于 UI 提示（不泄露内部细节）。 */
function describeCloudError(err: unknown): string {
  const e = err as { error?: { code?: string; message?: string }; message?: string };
  const code = e?.error?.code ?? '';
  if (code.startsWith('quota_')) return '云端额度受限，先用离线回复';
  if (code.startsWith('auth_')) return '云端鉴权未通过（本地预览需发布后生效）';
  if (code.startsWith('model_') || code.startsWith('gateway_')) return '云端模型暂不可用';
  return e?.error?.message ?? e?.message ?? '云端调用失败';
}

export interface ReplyResult {
  safe: SafeIntent;
  usedModel: boolean;
  provider: ReplyProvider;
  error?: string;
  latencyMs: number;
}

export async function requestReply(
  save: SaveData,
  userText: string,
  cfg: LlmConfig,
  signal?: AbortSignal,
  placeLine = '',
): Promise<ReplyResult> {
  const t0 = performance.now();

  // 1) 云端免密钥大模型
  if (cloudConfigured()) {
    try {
      const model = await resolveCloudModel(signal);
      if (model) {
        const ctx = buildContext(save, userText, placeLine);
        const messages = buildMessages(ctx, userText);
        const params: ChatCompletionCreateParamsStreaming = {
          model: model.id,
          // 契约要求 messages[0] 是应用自带的 system 提示；buildMessages 已保证
          messages: messages as unknown as ChatCompletionCreateParamsStreaming['messages'],
          stream: true,
          temperature: cfg.temperature,
          // 输出上限给足：回复本身很短，但推理模型会把思考也算在里面
          max_tokens: Math.max(cfg.maxTokens, 600),
          signal,
        };
        // 推理模型：把思考压到最小，别把 token 烧在思考上导致吐不出可见内容
        if (model.supportsReasoning === true) params.reasoning_effort = 'minimal';

        let text = '';
        let reasoning = '';
        let chunks = 0;
        for await (const chunk of getCloud().llm.chat.completions.create(params)) {
          chunks++;
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) text += delta.content;
          if (delta?.reasoning_content) reasoning += delta.reasoning_content;
        }
        // 调试：把原始返回暴露出来，便于排查"接通但空内容"
        if (typeof window !== 'undefined') {
          (window as unknown as { __llmLast?: unknown }).__llmLast = {
            model: model.id,
            chunks,
            raw: text,
            reasoning: reasoning.slice(0, 200),
          };
        }
        const parsed = extractJson(text);
        const fallbackText =
          parsed && typeof (parsed as IntentSchema).line === 'string'
            ? ((parsed as IntentSchema).line as string)
            : text.trim().slice(0, 80) || '……';
        return {
          safe: sanitizeIntent(parsed, fallbackText, 'calm', 'talking'),
          usedModel: true,
          provider: 'cloud',
          latencyMs: performance.now() - t0,
        };
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      const msg = describeCloudError(err);
      console.warn('[llm] 云端失败，尝试本地/离线：', msg);
      // 云端不可用 → 继续往下走本地/离线
      const local = await tryLocal(save, userText, cfg, signal, t0, placeLine);
      if (local) return local;
      const intent = offlineReply(save, userText);
      return {
        safe: sanitizeIntent(intent, intent.line, intent.emotion, intent.action),
        usedModel: false,
        provider: 'offline',
        error: msg,
        latencyMs: performance.now() - t0,
      };
    }
  }

  // 2) 本地 OpenAI 兼容
  const local = await tryLocal(save, userText, cfg, signal, t0, placeLine);
  if (local) return local;

  // 3) 离线兜底
  const intent = offlineReply(save, userText);
  return {
    safe: sanitizeIntent(intent, intent.line, intent.emotion, intent.action),
    usedModel: false,
    provider: 'offline',
    latencyMs: performance.now() - t0,
  };
}

/**
 * 生成一篇日记（第一人称、一句感受）。不走 IntentSchema，直接要正文。
 * 云端不可用时退回离线模板，保证"她每天都有日记"这件事不空。
 */
export async function requestDiary(
  save: SaveData,
  focus?: string,
  signal?: AbortSignal,
): Promise<{ text: string; provider: ReplyProvider }> {
  const name = save.character.personality.name;
  const you = save.playerName;
  const sys =
    `你是${name}，一个和「${you}」一起住的${youth(save.character.personality.gender)}。现在你在自己的日记本上写今天的一两句话。\n` +
    `要求：\n` +
    `1. 用你自己的第一人称（"我……"）来写；写的是——你对「${you}」的看法、今天你和 TA 之间发生了什么、你自己的心情；\n` +
    `2. 像真人在本子上随手写，口语、有点私人、偶尔带点小情绪，不要写成总结报告或旁白；\n` +
    `3. 不要标题、不要引号、不要日期、不要括号描写；\n` +
    `4. 1~2 句，不超过 45 字。只输出日记正文。`;
  const recent =
    memoriesFor(save)
      .slice(-6)
      .map((m) => m.summary)
      .join('；') || '（今天没什么特别的）';
  const user =
    `现在是${formatClock(save.clock)}。你今天心情${MOOD_CN[save.character.mood] ?? ''}，` +
    `在家${ACTIVITY_CN[save.character.activity] ?? '待着'}。\n` +
    (focus ? `今天最想记下来的一件事：${focus}。\n` : '') +
    `（最近的背景：${recent}）\n` +
    `写一句你今天的日记（记得是"我"对「${you}」的视角与感受）。`;

  if (cloudConfigured()) {
    try {
      const model = await resolveCloudModel(signal);
      if (model) {
        const params: ChatCompletionCreateParamsStreaming = {
          model: model.id,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user },
          ] as unknown as ChatCompletionCreateParamsStreaming['messages'],
          stream: true,
          temperature: 1,
          max_tokens: 300,
          signal,
        };
        if (model.supportsReasoning === true) params.reasoning_effort = 'minimal';
        let text = '';
        for await (const chunk of getCloud().llm.chat.completions.create(params)) {
          const d = chunk.choices[0]?.delta?.content;
          if (d) text += d;
        }
        const clean = text.replace(/["“”「」]/g, '').replace(/^\s*\d+\s*[.、]?\s*/, '').trim().slice(0, 80);
        if (clean) return { text: clean, provider: 'cloud' };
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      console.warn('[diary] 云端失败，用离线日记：', (err as Error).message);
    }
  }
  return { text: offlineDiary(save), provider: 'offline' };
}

/** 我在朋友圈发了条动态 → 她来评论一句。云端不可用时退回离线模板。 */
export async function requestMomentComment(
  save: SaveData,
  post: string,
  signal?: AbortSignal,
): Promise<{ text: string; provider: ReplyProvider }> {
  const name = save.character.personality.name;
  const you = save.playerName;
  const sys =
    `你是${name}，正在刷朋友圈，看到「${you}」刚发的一条动态。\n` +
    `要求：\n` +
    `1. 用你自己的语气留一条评论，就像在别人朋友圈下面回帖；\n` +
    `2. 口语、短，可以带一点情绪或者调侃，符合你的性格；\n` +
    `3. 不要引号、不要表情符号、不要"评论："这类前缀；\n` +
    `4. 不超过 20 字。只输出评论正文。`;
  const user = `「${you}」发的动态：「${post}」。留一条评论。`;

  if (cloudConfigured()) {
    try {
      const model = await resolveCloudModel(signal);
      if (model) {
        const params: ChatCompletionCreateParamsStreaming = {
          model: model.id,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user },
          ] as unknown as ChatCompletionCreateParamsStreaming['messages'],
          stream: true,
          temperature: 1,
          max_tokens: 200,
          signal,
        };
        if (model.supportsReasoning === true) params.reasoning_effort = 'minimal';
        let text = '';
        for await (const chunk of getCloud().llm.chat.completions.create(params)) {
          const d = chunk.choices[0]?.delta?.content;
          if (d) text += d;
        }
        const clean = text.replace(/["“”「」]/g, '').trim().slice(0, 40);
        if (clean) return { text: clean, provider: 'cloud' };
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      console.warn('[moment] 云端失败，用离线评论：', (err as Error).message);
    }
  }
  const offline = [
    '看见了。',
    '……你怎么发这个。',
    '我点了个赞。',
    '哦。',
    '下次带上我。',
  ];
  return { text: offline[Math.floor(Math.random() * offline.length)], provider: 'offline' };
}

/** 本地 OpenAI 兼容接口（仅在用户填了 key 时启用）。返回 null 表示未启用或失败。 */
async function tryLocal(
  save: SaveData,
  userText: string,
  cfg: LlmConfig,
  signal: AbortSignal | undefined,
  t0: number,
  placeLine = '',
): Promise<ReplyResult | null> {
  if (!isOnline(cfg)) return null;
  try {
    const ctx = buildContext(save, userText, placeLine);
    const messages = buildMessages(ctx, userText);
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson(content);
    const fallbackText =
      parsed && typeof (parsed as IntentSchema).line === 'string'
        ? ((parsed as IntentSchema).line as string)
        : content.slice(0, 80) || '……';
    return {
      safe: sanitizeIntent(parsed, fallbackText, 'calm', 'talking'),
      usedModel: true,
      provider: 'local',
      latencyMs: performance.now() - t0,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    console.warn('[llm] 本地接口失败：', (err as Error).message);
    return null;
  }
}
