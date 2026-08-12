/**
 * Service Worker：唯一持有 API Key、唯一发起 LLM 请求的上下文。
 * 职责：
 *  - 按 tabId 分队列 + 全局并发调度（≤8，弹幕全量批管道吞吐）
 *  - 改写缓存（sha256 → 结果）
 *  - 429 指数退避（尊重 Retry-After）/ 网络重试 ≤2 / 超时熔断
 *  - 失败率熔断（暂停自动恢复）、401/403 停队（配置变更/测试连接解除）
 *  - 队列镜像持久化到 storage.local，SW 被回收后恢复
 *  - 改写失败详情输出：SW console + KW_FAILURE_LOG 推送页面 console
 *  - KW_TEST_CONNECTION（最小 chat completion）
 */

import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { getApiKeys, getConfig, saveConfig } from '@/lib/config';
import type { KindlyConfig } from '@/lib/config';
import { buildMessages, resolveStyleInstruction } from '@/lib/prompt';
import { cacheGet, cacheSet, cacheSigOf } from '@/lib/cache';
import { classifyFetchError, classifyHttpStatus, extractErrorDetail } from '@/lib/errors';
import { createIncrementalJsonParser, parseRewrites } from '@/lib/response-parser';
import { createSseContentReader, extractSseContent } from '@/lib/sse';
import type { CommentItem, RewriteReason, RuntimeMessage, StatusPayload } from '@/lib/messages';

/**
 * 全局请求并发上限（动态：由配置 dmConcurrency 驱动，用户可选速度预设或自定义；
 * schedule 每次读取配置后更新，首个请求前用默认值）
 */
let maxConcurrency = 16;
/** 最小请求间隔（ms）：并发之外的第二道限流，防持续密集请求触发服务商封禁 */
const MIN_REQUEST_INTERVAL_MS = 50;
/** 瞬时失败（网络/解析）重试次数与基础间隔（ms）：由配置驱动，schedule 每次读配置更新 */
let retryCount = 2;
let retryIntervalMs = 1000;
/** parse 失败立即重试（模型偶发空响应/格式错误，无需等待） */
const PARSE_RETRY_DELAY_MS = 0;
const MAX_CONSECUTIVE_429 = 3;
const CIRCUIT_WINDOW = 20;
const CIRCUIT_FAIL_RATE = 0.6;
const PAUSE_COOLDOWN_MS = 60_000;
const MIRROR_KEY = 'kwQueueMirror';
const MIRROR_DEBOUNCE_MS = 300;

interface PendingItem {
  id: string;
  author: string;
  original: string;
  kind: 'comment' | 'danmaku';
  /** 弹幕批量请求聚合 ID（存在时结果聚合回发而非逐条） */
  requestId?: string;
  /** 评论接口响应顺序索引（结果应用按 seq 定位 DOM） */
  seq?: number;
  /** 评论渲染树定位路径（楼中楼 [顶层 seq, 子索引]；顶层与 seq 等价） */
  path?: number[];
}

/** 弹幕批量聚合状态：全部条目完成（成功或失败）后一次性回发 */
interface BatchAggregate {
  tabId: number;
  results: Map<string, string>;
  remaining: number;
}

interface Batch {
  tabId: number;
  items: PendingItem[];
  /** 网络类失败重试次数 */
  attempts: number;
  /** 连续 429 次数（> MAX 则跳过本批并暂停） */
  consecutive429: number;
  /** 请求元信息（fire 时填充，供失败日志定位） */
  modelName: string;
  baseURL: string;
}

interface MirrorState {
  queues: Record<number, PendingItem[]>;
  authFailed: boolean;
  pausedUntil: number;
  stats: Stats;
}

interface Stats {
  failures: number;
  totalRewritten: number;
  lastError: RewriteReason | null;
  /** 最近 CIRCUIT_WINDOW 次请求结果（1=成功 0=失败），用于失败率熔断 */
  recent: number[];
}

const queues = new Map<number, PendingItem[]>();
/** 每 tab 的视频弹幕总量（KW_VIDEO_META 上报；弹幕阈值判断用，无记录 = 不拦截） */
const danmakuTotalByTab = new Map<number, number>();
const inFlight = new Set<Batch>();
const backoffQueue: Batch[] = [];
const aborts = new Map<Batch, AbortController>();
/** 弹幕批量聚合：requestId → 状态（运行时动态集合，用 Map） */
const aggregates = new Map<string, BatchAggregate>();
let pausedUntil = 0;
let authFailed = false;
let stats: Stats = { failures: 0, totalRewritten: 0, lastError: null, recent: [] };
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
let tabPointer = 0;
/** 多 Key 轮询游标（借鉴 kiss-translator keyPick） */
let keyIndex = 0;
/** 上一请求启动时间（最小间隔限流） */
let lastRequestStart = 0;
let rescheduleTimer: ReturnType<typeof setTimeout> | null = null;

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
    switch (msg?.type) {
      case 'KW_REWRITE_COMMENTS':
        handleRewriteRequest(msg.items, sender.tab?.id);
        return false;
      case 'KW_REWRITE_BATCH':
        handleBatchRequest(msg.requestId, msg.items, sender.tab?.id);
        return false;
      case 'KW_SET_ENABLED':
        handleSetEnabled(msg.enabled);
        return false;
      case 'KW_GET_STATUS':
        sendResponse(collectStatus());
        return false;
      case 'KW_GET_CONFIG':
        // main-world 劫持层拉取配置（隐藏原文等 MAIN 侧行为；经桥同步）
        void getConfig().then((config) => sendResponse({ type: 'KW_CONFIG', config }));
        return true;
      case 'KW_TEST_CONNECTION':
        handleTestConnection(sendResponse);
        return true;
      case 'KW_CONFIG_CHANGED':
        handleConfigChanged();
        return false;
      case 'KW_HIJACK_ACTIVE':
        // main-world 劫持脚本 → SW → 广播给 tabs（content script 之间不能直接 runtime.sendMessage）
        void broadcastToTabs(msg);
        return false;
      case 'KW_VIDEO_META':
        // 视频弹幕总量（main-world 劫持 view API 提取）→ 阈值判断用
        if (sender.tab?.id !== undefined) danmakuTotalByTab.set(sender.tab.id, msg.danmakuTotal);
        return false;
      case 'KW_COMMENTS_PENDING':
        // 评论已送改写（main-world 劫持路径）→ 通知同 tab 的 isolated CS（隐藏原文占位）
        if (sender.tab?.id !== undefined) void browser.tabs.sendMessage(sender.tab.id, msg).catch(() => {});
        return false;
      default:
        return false;
    }
  });

  browser.runtime.onStartup.addListener(() => {
    void restore();
  });

  void restore();
});

// ===== 入队与调度 =====

/** 评论/弹幕改写请求入口（逐条回发路径） */
async function handleRewriteRequest(items: CommentItem[], tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  await enqueueItems(items, tabId);
}

/** 弹幕批量请求入口：同批结果聚合后一次性回发（KW_REWRITE_BATCH_RESULT） */
async function handleBatchRequest(requestId: string, items: CommentItem[], tabId: number | undefined): Promise<void> {
  if (tabId === undefined || !requestId) return;
  const valid = items.filter((it) => it?.id && typeof it.original === 'string' && it.original.trim());
  if (valid.length === 0) return;
  // 弹幕处理上限：视频弹幕总量 > 阈值时跳过改写，整批放行原文
  // （弹幕量极大的视频通常引战少；阈值由用户在设置中配置）
  const config = await getConfig();
  const max = config.danmakuMaxTotal;
  const total = danmakuTotalByTab.get(tabId);
  if (max !== null && total !== undefined && total > max) {
    const results = valid.map((it) => ({ id: it.id, rewritten: it.original }));
    void browser.tabs.sendMessage(tabId, {
      type: 'KW_REWRITE_BATCH_RESULT',
      requestId,
      results,
      skipped: true,
    } satisfies Extract<RuntimeMessage, { type: 'KW_REWRITE_BATCH_RESULT' }>);
    return;
  }
  aggregates.set(requestId, { tabId, results: new Map(), remaining: valid.length });
  await enqueueItems(valid.map((it) => ({ ...it, kind: 'danmaku', requestId })), tabId);
}

async function enqueueItems(items: CommentItem[], tabId: number): Promise<void> {
  await restore(); // SW 刚被唤醒时先恢复镜像
  const config = await getConfig();
  if (!config.enabled) return;

  const fresh: PendingItem[] = [];
  for (const item of items) {
    const kind = item.kind ?? 'comment';
    const sig = cacheSigOf(
      config.baseURL,
      config.modelName,
      config.intensity,
      config.includeAuthor,
      kind,
      resolveStyleInstruction(config),
      config.enableThinking,
      config.emojiToKaomoji,
    );
    const cached = await cacheGet(item.original, sig);
    if (cached !== null) {
      stats.totalRewritten++;
      deliverResult(tabId, item, cached);
      continue;
    }
    fresh.push({
      id: item.id,
      author: item.author,
      original: item.original,
      kind,
      requestId: item.requestId,
      seq: item.seq,
      path: item.path,
    });
  }
  if (fresh.length === 0) return;

  const queue = queues.get(tabId) ?? [];
  queue.push(...fresh);
  queues.set(tabId, queue);
  persistMirror();
  void schedule();
}

/** 单条结果投递：弹幕批 → 聚合；评论 → 逐条消息 */
function deliverResult(tabId: number, item: PendingItem | CommentItem, rewritten: string): void {
  if (item.requestId) {
    const agg = aggregates.get(item.requestId);
    if (agg) {
      // 幂等：同一 id 重复交付（缓存命中/重试路径）不重复计数，
      // 否则 remaining 提前归零会丢失未完成条目的结果
      if (!agg.results.has(item.id)) {
        agg.results.set(item.id, rewritten);
        agg.remaining--;
      }
      if (agg.remaining <= 0) {
        aggregates.delete(item.requestId);
        void browser.tabs.sendMessage(tabId, {
          type: 'KW_REWRITE_BATCH_RESULT',
          requestId: item.requestId,
          results: [...agg.results.entries()].map(([id, text]) => ({ id, rewritten: text })),
        } satisfies Extract<RuntimeMessage, { type: 'KW_REWRITE_BATCH_RESULT' }>);
      }
    }
    return;
  }
  void notifyTab(tabId, {
    type: 'KW_REWRITE_RESULT',
    id: item.id,
    rewritten,
    seq: item.seq,
    path: item.path,
    original: item.original,
  });
}

function nextBatch(config: KindlyConfig): Batch | null {
  if (inFlight.size >= maxConcurrency || authFailed || Date.now() < pausedUntil) return null;
  const tabIds = [...queues.keys()];
  if (tabIds.length === 0) return null;
  for (let i = 0; i < tabIds.length; i++) {
    tabPointer = (tabPointer + 1) % tabIds.length;
    const tabId = tabIds[tabPointer];
    if (tabId === undefined) continue;
    const queue = queues.get(tabId);
    if (!queue || queue.length === 0) continue;
    const batch: Batch = {
      tabId,
      items: queue.splice(0, config.batchSize),
      attempts: 0,
      consecutive429: 0,
      modelName: config.modelName,
      baseURL: config.baseURL,
    };
    if (queue.length === 0) queues.delete(tabId);
    return batch;
  }
  return null;
}

async function schedule(): Promise<void> {
  if (authFailed) return;
  if (Date.now() < pausedUntil) {
    // 熔断/限流暂停：安排恢复后自动重试，避免队列永久挂起（无新消息触发时）
    if (!rescheduleTimer) {
      rescheduleTimer = setTimeout(() => {
        rescheduleTimer = null;
        void schedule();
      }, pausedUntil - Date.now() + 100);
    }
    return;
  }
  // 最小请求间隔（借鉴 kiss-translator TaskPool 的 interval 限流）
  const wait = lastRequestStart + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) {
    if (!rescheduleTimer) {
      rescheduleTimer = setTimeout(() => {
        rescheduleTimer = null;
        void schedule();
      }, wait);
    }
    return;
  }
  const config = await getConfig();
  maxConcurrency = Math.min(128, Math.max(1, config.dmConcurrency));
  retryCount = Math.min(5, Math.max(0, config.retryCount));
  retryIntervalMs = Math.min(30_000, Math.max(0, config.retryIntervalSec * 1000));
  void drainBackoff(Date.now());
  while (inFlight.size < maxConcurrency) {
    const batch = nextBatch(config);
    if (!batch) break;
    void fire(batch);
  }
}

/** 退避队列：到期（backoffUntil 字段由调用方在放回时记录在对象上）直接重发原批
 * （保留 attempts 计数——放回队列再重建会重置 attempts，导致重试无限循环） */
async function drainBackoff(now: number): Promise<void> {
  for (let i = backoffQueue.length - 1; i >= 0 && inFlight.size < maxConcurrency; i--) {
    const batch = backoffQueue[i];
    if (!batch) continue;
    const until = (batch as Batch & { backoffUntil?: number }).backoffUntil ?? 0;
    if (now >= until) {
      backoffQueue.splice(i, 1);
      void fire(batch);
    }
  }
}

// ===== 请求执行 =====

async function fire(batch: Batch): Promise<void> {
  inFlight.add(batch);
  const controller = new AbortController();
  aborts.set(batch, controller);
  persistMirror();

  const config = await getConfig();
  const apiKeys = await getApiKeys();
  if (apiKeys.length === 0) {
    finishBatch(batch, 'auth');
    return;
  }
  // 多 Key 轮询（借鉴 kiss-translator keyPick）
  const apiKey = apiKeys[keyIndex % apiKeys.length];
  keyIndex++;

  lastRequestStart = Date.now();
  const kind = batch.items[0]?.kind ?? 'comment';
  const sig = cacheSigOf(
    config.baseURL,
    config.modelName,
    config.intensity,
    config.includeAuthor,
    kind,
    resolveStyleInstruction(config),
    config.enableThinking,
    config.emojiToKaomoji,
  );
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  // 重试前缓存过滤：已改写成功的条目直接交付，不再重复请求 LLM
  // （网络/parse 重试路径的 batch 未经过 enqueueItems 的缓存检查）
  if (batch.attempts > 0) {
    const freshItems: PendingItem[] = [];
    for (const item of batch.items) {
      const cached = await cacheGet(item.original, sig);
      if (cached !== null) {
        stats.totalRewritten++;
        deliverResult(batch.tabId, item, cached);
      } else {
        freshItems.push(item);
      }
    }
    if (freshItems.length === 0) {
      recordOutcome(1);
      clearTimeout(timer);
      inFlight.delete(batch);
      aborts.delete(batch);
      persistMirror();
      void schedule();
      return;
    }
    batch.items = freshItems;
  }
  const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const chatBody: Record<string, unknown> = {
    model: config.modelName,
    messages: buildMessages(config, batch.items, kind),
    temperature: 0.6,
    max_tokens: kind === 'danmaku' ? 1024 : 2048,
    stream: true,
    ...thinkingDisabledParam(config),
  };
  const requestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal: controller.signal,
  };
  let res: Response;
  try {
    res = await fetch(url, { ...requestInit, body: JSON.stringify(chatBody) });
  } catch (err) {
    // 请求本身失败（未建立连接/网络错误）：无任何交付，按瞬时失败重试
    handleTransientFailure(batch, classifyFetchError(err));
    clearTimeout(timer);
    inFlight.delete(batch);
    aborts.delete(batch);
    persistMirror();
    void schedule();
    return;
  }

  // ===== 思考禁用参数降级 =====
  // 端点不认识 thinking 字段（参数类 400/422）→ 不带该参数重试一次并记住，
  // 之后该端点不再附加（负缓存，每 SW 会话一次失败请求，不影响改写）
  if (!res.ok && (res.status === 400 || res.status === 422) && 'thinking' in chatBody) {
    thinkingUnsupportedFor = config.baseURL;
    try {
      res = await fetch(url, { ...requestInit, body: JSON.stringify({ ...chatBody, thinking: undefined }) });
    } catch (err) {
      handleTransientFailure(batch, classifyFetchError(err));
      clearTimeout(timer);
      inFlight.delete(batch);
      aborts.delete(batch);
      persistMirror();
      void schedule();
      return;
    }
  }

  if (res.status === 401 || res.status === 403) {
    finishBatch(batch, 'auth', await extractErrorDetail(res));
    clearTimeout(timer);
    inFlight.delete(batch);
    aborts.delete(batch);
    persistMirror();
    void schedule();
    return;
  }
  if (res.status === 429) {
    handleRateLimited(batch, res, await extractErrorDetail(res));
    clearTimeout(timer);
    inFlight.delete(batch);
    aborts.delete(batch);
    persistMirror();
    void schedule();
    return;
  }
  if (!res.ok) {
    handleTransientFailure(batch, classifyHttpStatus(res.status), await extractErrorDetail(res));
    clearTimeout(timer);
    inFlight.delete(batch);
    aborts.delete(batch);
    persistMirror();
    void schedule();
    return;
  }

  // ===== 流式读取 + 增量交付（首条结果到达即应用，无需等整批）=====
  const delivered = new Set<string>();
  const sseReader = createSseContentReader();
  const incremental = createIncrementalJsonParser();
  let sseText = '';
  let streamError: RewriteReason | null = null;
  try {
    if (!res.body) throw new Error('响应无 body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      sseText += chunk;
      // 本块到达的 content 增量（SSE 行缓冲跨 chunk 处理）→ 增量 JSON 解析
      const delta = sseReader.push(chunk);
      for (const [id, valueText] of incremental.push(delta)) {
        if (delivered.has(id)) continue;
        const item = batch.items.find((it) => it.id === id);
        if (!item) continue;
        delivered.add(id);
        // 空输出视作"无意义改写"→ 交付原文（与 handleSuccess 语义一致）
        const rewritten = valueText.trim() === '' ? item.original : valueText.trim();
        void cacheSet(item.original, sig, rewritten);
        stats.totalRewritten++;
        deliverResult(batch.tabId, item, rewritten);
      }
    }
    sseText += decoder.decode();
  } catch (err) {
    streamError = classifyFetchError(err);
  }

  const missing = batch.items.filter((it) => !delivered.has(it.id));
  if (missing.length > 0 && streamError === null) {
    // 流正常结束但有条目未增量交付：整批解析兜底（兼容非标准输出形态）
    const content = extractSseContent(sseText);
    if (content.trim() !== '') {
      const map = parseRewrites(content, batch.items);
      if (map) {
        for (const item of missing) {
          const r = map.get(item.id);
          if (typeof r === 'string' && r.trim() !== '') {
            delivered.add(item.id);
            void cacheSet(item.original, sig, r.trim());
            stats.totalRewritten++;
            deliverResult(batch.tabId, item, r.trim());
          }
        }
      }
    }
  }
  const stillMissing = batch.items.filter((it) => !delivered.has(it.id));
  if (stillMissing.length > 0) {
    if (streamError !== null && delivered.size === 0) {
      // 完全无交付的流中断：视为网络级失败，走瞬时重试
      handleTransientFailure(batch, streamError);
    } else {
      // 部分交付成功 / 流正常结束但解析失败：未交付条目按失败处理（已交付保持）
      const detail = streamError === null ? extractSseContent(sseText).slice(0, 200) : undefined;
      for (const item of stillMissing) {
        stats.failures++;
        if (item.requestId) deliverResult(batch.tabId, item, item.original);
        else
          void notifyTab(batch.tabId, {
            type: 'KW_REWRITE_ERROR',
            id: item.id,
            reason: streamError ?? 'parse',
            detail,
            seq: item.seq,
            path: item.path,
          });
      }
      recordOutcome(delivered.size > 0 ? 1 : 0);
    }
  } else if (streamError === null) {
    recordOutcome(1);
  }
  clearTimeout(timer);
  inFlight.delete(batch);
  aborts.delete(batch);
  persistMirror();
  void schedule();
}

function handleTransientFailure(batch: Batch, reason: RewriteReason, detail?: string): void {
  const retryable = (reason === 'network' || reason === 'parse') && batch.attempts < retryCount;
  if (retryable) {
    batch.attempts++;
    // network：retryInterval × 2^(次数-1) 指数退避（默认 1s/2s）；parse（空响应/格式错误）：立即重试
    const delay = reason === 'parse' ? PARSE_RETRY_DELAY_MS : retryIntervalMs * 2 ** (batch.attempts - 1);
    (batch as Batch & { backoffUntil?: number }).backoffUntil = Date.now() + delay;
    backoffQueue.push(batch);
    return;
  }
  finishBatch(batch, reason, detail);
}

function handleRateLimited(batch: Batch, res: Response, detail?: string): void {
  batch.consecutive429++;
  const retryAfter = parseRetryAfter(res);
  const delay = Math.min(retryAfter ?? 1000 * 2 ** (batch.consecutive429 - 1), 60_000);
  if (batch.consecutive429 >= MAX_CONSECUTIVE_429) {
    // 连续 3 次退避 → 跳过本批并暂停
    pausedUntil = Date.now() + PAUSE_COOLDOWN_MS;
    finishBatch(batch, 'rate_limited', detail);
    return;
  }
  (batch as Batch & { backoffUntil?: number }).backoffUntil = Date.now() + delay;
  backoffQueue.push(batch);
}

/**
 * SW 控制台输出改写失败详情（区分评论/弹幕，面向开发者定位）：
 *  - 原文：id + 原文完整映射（不只是文本）
 *  - 请求返回内容：LLM 响应原文 / HTTP 错误体（截断 2000）
 *  - 元信息：重试次数、接口、模型、时间戳
 */
function logRewriteFailure(batch: Batch, reason: RewriteReason, detail?: string): void {
  const kindLabel = batch.items[0]?.kind === 'danmaku' ? '弹幕' : '评论';
  const snippet = detail && detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail;
  console.log(
    `[Kindly Web] 改写失败 · ${kindLabel} · 原因: ${reason} · 重试: ${batch.attempts}次 · 时间: ${new Date().toISOString()} · 接口: ${batch.baseURL} · 模型: ${batch.modelName}`,
    {
      条目: batch.items.map((i) => ({ id: i.id, 原文: i.original })),
      请求返回内容: snippet,
    },
  );
  // 同步推送到页面（isolated world console 显示在页面 DevTools，用户可见）
  void notifyTab(batch.tabId, {
    type: 'KW_FAILURE_LOG',
    kind: batch.items[0]?.kind === 'danmaku' ? 'danmaku' : 'comment',
    reason,
    ids: batch.items.map((i) => i.id),
    originals: batch.items.map((i) => i.original),
    attempts: batch.attempts,
    modelName: batch.modelName,
    baseURL: batch.baseURL,
    detail,
  });
}

function finishBatch(batch: Batch, reason: RewriteReason, detail?: string): void {
  logRewriteFailure(batch, reason, detail);
  stats.failures += batch.items.length;
  stats.lastError = reason;
  if (reason === 'auth') {
    authFailed = true;
    // 清空所有队列：评论条目报 auth 错误；弹幕批条目回原文（保底显示）
    for (const [tabId, queue] of queues) {
      for (const item of queue) {
        if (item.requestId) deliverResult(tabId, item, item.original);
        else
          void notifyTab(tabId, {
            type: 'KW_REWRITE_ERROR',
            id: item.id,
            reason: 'auth',
            detail,
            seq: item.seq,
            path: item.path,
          });
      }
      queues.delete(tabId);
    }
  }
  for (const item of batch.items) {
    // 弹幕改写失败 → 保持原文（聚合回发）；评论 → 逐条错误消息
    if (item.requestId) deliverResult(batch.tabId, item, item.original);
    else
      void notifyTab(batch.tabId, {
        type: 'KW_REWRITE_ERROR',
        id: item.id,
        reason,
        detail,
        seq: item.seq,
        path: item.path,
      });
  }
  recordOutcome(0);
  broadcastStatus();
}

function recordOutcome(ok: 0 | 1): void {
  stats.recent.push(ok);
  if (stats.recent.length > CIRCUIT_WINDOW) stats.recent.splice(0, stats.recent.length - CIRCUIT_WINDOW);
  if (stats.recent.length >= CIRCUIT_WINDOW) {
    const failures = stats.recent.filter((r) => r === 0).length;
    if (failures / stats.recent.length >= CIRCUIT_FAIL_RATE && !authFailed) {
      pausedUntil = Date.now() + PAUSE_COOLDOWN_MS;
    }
  }
  broadcastStatus();
}

// ===== 开关 / 配置变化 =====

async function handleSetEnabled(enabled: boolean): Promise<void> {
  await saveConfig({ enabled });
  if (!enabled) {
    // 中断所有在飞请求 + 清空队列
    for (const controller of aborts.values()) controller.abort();
    aborts.clear();
    inFlight.clear();
    backoffQueue.length = 0;
    queues.clear();
    aggregates.clear();
    pausedUntil = 0;
    authFailed = false;
    persistMirror();
  }
  await broadcastToTabs({ type: 'KW_SET_ENABLED', enabled });
  broadcastStatus();
}

async function handleConfigChanged(): Promise<void> {
  // 用户修改了 Key / 服务商：解除 auth 停摆与熔断
  authFailed = false;
  pausedUntil = 0;
  keyIndex = 0;
  await broadcastToTabs({ type: 'KW_CONFIG_CHANGED' });
  broadcastStatus();
  void schedule();
}

// ===== 测试连接（安全：必须走 SW）=====

/**
 * 思考模式禁用参数（对所有 OpenAI 兼容接口生效，不限于某家服务商）：
 * 开关关闭时显式附加 thinking:{type:'disabled'}，避免模型推理拖慢改写。
 * - reasoner 等推理专用模型排除：思考是模型固有行为，禁用参数不受支持
 * - 端点已确认不支持该参数（400/422 降级重试成功）时不再附加（thinkingUnsupportedFor）
 * 开启思考模式时不附加任何参数（由服务商/模型默认决定）。
 */
function thinkingDisabledParam(config: KindlyConfig): { thinking?: { type: 'disabled' } } {
  if (
    !config.enableThinking &&
    !config.modelName.toLowerCase().includes('reasoner') &&
    thinkingUnsupportedFor !== config.baseURL
  ) {
    return { thinking: { type: 'disabled' } };
  }
  return {};
}

/** 已确认不支持 thinking 参数的端点 baseURL（降级重试成功后置位，SW 会话内有效） */
let thinkingUnsupportedFor = '';

async function handleTestConnection(sendResponse: (r: unknown) => void): Promise<void> {
  const config = await getConfig();
  const apiKeys = await getApiKeys();
  if (apiKeys.length === 0) {
    sendResponse({ type: 'KW_TEST_RESULT', ok: false, error: 'auth' });
    return;
  }
  const apiKey = apiKeys[0]; // 测试连接仅验证第一个 Key
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const t0 = performance.now();
  try {
    const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const chatBody: Record<string, unknown> = {
      model: config.modelName,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
      ...thinkingDisabledParam(config),
    };
    const requestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    };
    let res = await fetch(url, { ...requestInit, body: JSON.stringify(chatBody) });
    // 思考禁用参数降级（同 fire）：端点不支持 thinking 字段 → 不带参数重试一次
    if (!res.ok && (res.status === 400 || res.status === 422) && 'thinking' in chatBody) {
      thinkingUnsupportedFor = config.baseURL;
      res = await fetch(url, { ...requestInit, body: JSON.stringify({ ...chatBody, thinking: undefined }) });
    }
    if (res.status === 401 || res.status === 403) {
      authFailed = true;
      broadcastStatus();
      sendResponse({ type: 'KW_TEST_RESULT', ok: false, error: 'auth' });
      return;
    }
    if (res.status === 429) {
      sendResponse({ type: 'KW_TEST_RESULT', ok: false, error: 'rate_limited' });
      return;
    }
    if (!res.ok) {
      sendResponse({ type: 'KW_TEST_RESULT', ok: false, error: 'network' });
      return;
    }
    const data: unknown = await res.json().catch(() => null);
    const content = extractContent(data);
    if (typeof content !== 'string') {
      sendResponse({ type: 'KW_TEST_RESULT', ok: false, error: 'parse' });
      return;
    }
    // 测试成功即证明 Key 有效：解除 auth 停摆
    authFailed = false;
    pausedUntil = 0;
    broadcastStatus();
    void schedule();
    sendResponse({
      type: 'KW_TEST_RESULT',
      ok: true,
      model: (data as { model?: unknown })?.model ? String((data as { model?: unknown }).model) : config.modelName,
      latencyMs: Math.round(performance.now() - t0),
    });
  } catch (err) {
    sendResponse({ type: 'KW_TEST_RESULT', ok: false, error: classifyFetchError(err) });
  } finally {
    clearTimeout(timer);
  }
}

// ===== 镜像持久化（SW 回收恢复）=====

function persistMirror(): void {
  if (mirrorTimer) clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    const mirror: MirrorState = {
      queues: Object.fromEntries(queues.entries()),
      authFailed,
      pausedUntil,
      stats,
    };
    void browser.storage.local.set({ [MIRROR_KEY]: mirror });
  }, MIRROR_DEBOUNCE_MS);
}

async function restore(): Promise<void> {
  const stored = await browser.storage.local.get(MIRROR_KEY);
  const mirror = stored[MIRROR_KEY] as MirrorState | undefined;
  if (!mirror) return;
  queues.clear();
  for (const [tabId, items] of Object.entries(mirror.queues ?? {})) {
    if (items.length > 0) queues.set(Number(tabId), items);
  }
  authFailed = mirror.authFailed ?? false;
  pausedUntil = mirror.pausedUntil ?? 0;
  stats = { ...stats, ...mirror.stats };
}

// ===== 工具函数 =====

function collectStatus(): StatusPayload {
  return {
    type: 'KW_STATUS',
    queueLength: [...queues.values()].reduce((n, q) => n + q.length, 0),
    inFlight: inFlight.size,
    failures: stats.failures,
    totalRewritten: stats.totalRewritten,
    paused: Date.now() < pausedUntil,
    authFailed,
    lastError: stats.lastError,
  };
}

function broadcastStatus(): void {
  void browser.runtime.sendMessage(collectStatus()).catch(() => {});
}

async function broadcastToTabs(msg: RuntimeMessage): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs.map((tab) => (tab.id !== undefined ? browser.tabs.sendMessage(tab.id, msg).catch(() => {}) : undefined)),
  );
}

function notifyTab(tabId: number, msg: RuntimeMessage): void {
  void browser.tabs.sendMessage(tabId, msg).catch(() => {
    // 标签页已关闭或 CS 未注入：静默丢弃
  });
}

function extractContent(data: unknown): string | null {
  const choices = (data as { choices?: unknown[] } | null)?.choices;
  const content = choices?.[0] && (choices[0] as { message?: { content?: unknown } }).message?.content;
  return typeof content === 'string' ? content : null;
}

function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
