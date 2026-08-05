/**
 * Service Worker：唯一持有 API Key、唯一发起 LLM 请求的上下文。
 * 职责（docs/ARCHITECTURE.md §4）：
 *  - 按 tabId 分队列 + 全局并发调度（≤5）
 *  - 改写缓存（sha256 → 结果）
 *  - 429 指数退避（尊重 Retry-After）/ 网络重试 ≤2 / 超时熔断
 *  - 失败率熔断、401/403 停队
 *  - 队列镜像持久化到 storage.local，SW 被回收后恢复
 *  - KW_TEST_CONNECTION（最小 chat completion）
 */

import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { getApiKeys, getConfig, saveConfig } from '@/lib/config';
import type { KindlyConfig } from '@/lib/config';
import { buildMessages } from '@/lib/prompt';
import { cacheGet, cacheSet, cacheSigOf } from '@/lib/cache';
import { classifyFetchError, classifyHttpStatus, extractErrorDetail } from '@/lib/errors';
import { parseRewrites } from '@/lib/response-parser';
import type { CommentItem, RewriteReason, RuntimeMessage, StatusPayload } from '@/lib/messages';

const MAX_CONCURRENCY = 5;
/** 最小请求间隔（ms）：并发之外的第二道限流，防持续密集请求触发服务商封禁 */
const MIN_REQUEST_INTERVAL_MS = 250;
const MAX_NETWORK_RETRIES = 2;
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
    const sig = cacheSigOf(config.baseURL, config.modelName, config.intensity, config.includeAuthor, kind);
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
      agg.results.set(item.id, rewritten);
      agg.remaining--;
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
  void notifyTab(tabId, { type: 'KW_REWRITE_RESULT', id: item.id, rewritten, seq: item.seq });
}

function nextBatch(config: KindlyConfig): Batch | null {
  if (inFlight.size >= MAX_CONCURRENCY || authFailed || Date.now() < pausedUntil) return null;
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
    };
    if (queue.length === 0) queues.delete(tabId);
    return batch;
  }
  return null;
}

async function schedule(): Promise<void> {
  if (authFailed || Date.now() < pausedUntil) return;
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
  void drainBackoff(Date.now());
  while (inFlight.size < MAX_CONCURRENCY) {
    const batch = nextBatch(config);
    if (!batch) break;
    void fire(batch);
  }
}

/** 退避队列：到期（backoffUntil 字段由调用方在放回时记录在对象上） */
async function drainBackoff(now: number): Promise<void> {
  for (let i = backoffQueue.length - 1; i >= 0; i--) {
    const batch = backoffQueue[i];
    if (!batch) continue;
    const until = (batch as Batch & { backoffUntil?: number }).backoffUntil ?? 0;
    if (now >= until) {
      backoffQueue.splice(i, 1);
      const queue = queues.get(batch.tabId) ?? [];
      queue.unshift(...batch.items);
      queues.set(batch.tabId, queue);
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
  const sig = cacheSigOf(config.baseURL, config.modelName, config.intensity, config.includeAuthor, kind);
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(`${config.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.modelName,
        messages: buildMessages(config, batch.items, kind),
        temperature: 0.6,
        max_tokens: kind === 'danmaku' ? 1024 : 2048,
      }),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      finishBatch(batch, 'auth', await extractErrorDetail(res));
      return;
    }
    if (res.status === 429) {
      handleRateLimited(batch, res, await extractErrorDetail(res));
      return;
    }
    if (!res.ok) {
      handleTransientFailure(batch, classifyHttpStatus(res.status), await extractErrorDetail(res));
      return;
    }

    const data: unknown = await res.json().catch(() => null);
    const content = extractContent(data);
    if (typeof content !== 'string' || content.trim() === '') {
      handleTransientFailure(batch, 'parse');
      return;
    }
    const rewrittenMap = parseRewrites(content, batch.items);
    if (!rewrittenMap) {
      handleTransientFailure(batch, 'parse');
      return;
    }
    await handleSuccess(batch, rewrittenMap, sig);
  } catch (err) {
    handleTransientFailure(batch, classifyFetchError(err));
  } finally {
    clearTimeout(timer);
    inFlight.delete(batch);
    aborts.delete(batch);
    persistMirror();
    void schedule();
  }
}

function handleSuccess(batch: Batch, map: Map<string, string>, sig: string): Promise<void> {
  return (async () => {
    for (const item of batch.items) {
      let rewritten = map.get(item.id);
      if (typeof rewritten !== 'string' || rewritten.trim() === '') {
        rewritten = item.original; // 空内容/无意义改写 → 保留原文
      }
      rewritten = rewritten.trim();
      void cacheSet(item.original, sig, rewritten);
      stats.totalRewritten++;
      deliverResult(batch.tabId, item, rewritten);
    }
    recordOutcome(1);
  })();
}

function handleTransientFailure(batch: Batch, reason: RewriteReason, detail?: string): void {
  if (reason === 'network' && batch.attempts < MAX_NETWORK_RETRIES) {
    batch.attempts++;
    const delay = 1000 * 2 ** (batch.attempts - 1); // 1s / 2s
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

function finishBatch(batch: Batch, reason: RewriteReason, detail?: string): void {
  stats.failures += batch.items.length;
  stats.lastError = reason;
  if (reason === 'auth') {
    authFailed = true;
    // 清空所有队列：评论条目报 auth 错误；弹幕批条目回原文（保底显示）
    for (const [tabId, queue] of queues) {
      for (const item of queue) {
        if (item.requestId) deliverResult(tabId, item, item.original);
        else void notifyTab(tabId, { type: 'KW_REWRITE_ERROR', id: item.id, reason: 'auth', detail, seq: item.seq });
      }
      queues.delete(tabId);
    }
  }
  for (const item of batch.items) {
    // 弹幕改写失败 → 保持原文（聚合回发）；评论 → 逐条错误消息
    if (item.requestId) deliverResult(batch.tabId, item, item.original);
    else void notifyTab(batch.tabId, { type: 'KW_REWRITE_ERROR', id: item.id, reason, detail, seq: item.seq });
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
    const res = await fetch(`${config.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.modelName,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
      }),
      signal: controller.signal,
    });
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
