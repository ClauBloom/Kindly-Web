/**
 * 通用劫持引擎（main world，与页面共享 window）。
 *
 * 与站点无关：评论/弹幕的所有站点差异经由 SiteAdapter 注入
 * （URL 匹配、响应提取/重编码、屏上替换）。本引擎只负责：
 *  - 包装 window.fetch / XMLHttpRequest（document_start 注入，先于页面业务脚本）
 *  - 评论：响应零阻塞放行 + 异步提取改写（items 经桥 → SW）
 *  - 弹幕：先放行 → 全量分批并发改写（DM_BATCH_SIZE/DM_MAX_INFLIGHT 管道）→
 *    屏上替换（adapter 层 DOM 文本匹配为主）+ 缓存重载替换；超时兜底放行原文
 *  - 视频信息（view API）劫持 → 弹幕总量上报 SW（阈值判断）
 *  - 任何异常回退原始请求行为，绝不阻塞/破坏页面
 */

import { listenFromExtension, sendToExtension, sendToExtensionWithResponse } from '@/lib/bridge';
import type { SiteAdapter } from '@/lib/sites/types';
import type { CommentItem } from '@/lib/messages';
import type { KindlyConfig } from '@/lib/config';

/** 弹幕批量改写等待上限（含 SW 排队时间），超时放弃（弹幕保持原文） */
const BATCH_TIMEOUT_MS = 45_000;

/** 弹幕批大小与并发（经桥从配置同步；同步前用默认值） */
let dmBatchSize = 40;
let dmConcurrency = 16;

/** 弹幕改写站点开关（经桥从配置同步；同步前默认开启，与历史行为一致） */
let dmEnabled = true;
/** 弹幕屏上探测是否已启动（仅启用后启动一次，关闭时不启动） */
let dmProbeStarted = false;

/** 改写结果缓存（id → 友善版），供弹幕段重载时直接替换 */
const rewriteCache = new Map<string, string>();
/** 已发送改写的 id（同段去重） */
const pendingIds = new Set<string>();
/** 内存上限：弹幕密集视频 id 可达数十万，超限清空防持续膨胀（重载段退化为重新改写） */
const REWRITE_CACHE_MAX = 20_000;
const PENDING_IDS_MAX = 100_000;

function cacheRewrite(id: string, rewritten: string): void {
  if (rewriteCache.size >= REWRITE_CACHE_MAX) rewriteCache.clear();
  rewriteCache.set(id, rewritten);
}

function markPendingId(id: string): void {
  if (pendingIds.size >= PENDING_IDS_MAX) pendingIds.clear();
  pendingIds.add(id);
}

// ===== 弹幕全量批管道（段内不跳过：全部分批 + 并发处理） =====
/** 段内排队中的弹幕批 */
let dmQueuedBatches: { id: string; text: string }[][] = [];
/** 段内在飞的批数 */
let dmInflight = 0;

/** 全量弹幕分批入队（按当前配置的批大小切批；pendingIds 已过滤） */
function queueDanmakuBatches(elems: { id: string; text: string }[]): void {
  for (let i = 0; i < elems.length; i += dmBatchSize) {
    dmQueuedBatches.push(elems.slice(i, i + dmBatchSize));
  }
  pumpDanmakuBatches();
}

/** 管道泵：在飞批数不足时补发下一批（并发 = 用户配置的并发量） */
function pumpDanmakuBatches(): void {
  while (dmInflight < dmConcurrency && dmQueuedBatches.length > 0) {
    const batch = dmQueuedBatches.shift();
    if (!batch) break;
    dmInflight++;
    void rewriteDanmakuWithText(batch).finally(() => {
      dmInflight--;
      pumpDanmakuBatches();
    });
  }
}

export function startHijack(adapter: SiteAdapter): void {
  adapterDanmaku = adapter.danmaku ?? null;
  // 弹幕屏上替换探测不在此处启动：danmakuEnabledSites 关闭时不应探测，
  // 延后到 syncMainConfig 拿到配置后按开关启动（桥就绪通常毫秒级，不影响探测重试）
  // B 站新版页面不再请求 view 接口（实测 2026-08）→ 弹幕阈值数据源失效；
  // 从页面内嵌数据轮询读取弹幕总量（main world，document_start 时页面脚本尚未执行）
  if (adapter.videoMeta?.extractDanmakuTotalFromPage) {
    probeSsrVideoMeta(adapter.videoMeta);
  }
  // 注册桥广播监听：处理 isolated 侧的 __bridge_ready 握手（此后 sendToExtension 才直发）。
  // 必须在 startHijack 立即注册，否则评论路径的 sendToExtension 会一直排队（bridgeReady 永不为 true）。
  listenFromExtension((msg) => {
    const m = msg as { type?: string };
    // SW 广播配置变更 → 重拉配置（隐藏原文等 MAIN 侧行为）
    if (m?.type === 'KW_CONFIG_CHANGED') void syncMainConfig(adapter);
  });
  // 拉取初始配置（桥就绪后 sendToExtensionWithResponse 会排队补发）
  void syncMainConfig(adapter);
  hijackFetch(adapter);
  hijackXhr(adapter);
}

/** SSR 弹幕总量探测：300ms 起每 100ms 轮询，5s 超时（页面脚本设置 __INITIAL_STATE__ 需要时间） */
const SSR_PROBE_INITIAL_DELAY_MS = 300;
const SSR_PROBE_INTERVAL_MS = 100;
const SSR_PROBE_MAX_ATTEMPTS = 50;

function probeSsrVideoMeta(videoMeta: NonNullable<SiteAdapter['videoMeta']>): void {
  let attempts = 0;
  const tick = () => {
    // 弹幕关闭后不再上报（阈值只在弹幕管道使用）
    if (!dmEnabled) return;
    try {
      const total = videoMeta.extractDanmakuTotalFromPage?.() ?? null;
      if (total !== null) {
        sendToExtension({ type: 'KW_VIDEO_META', danmakuTotal: total });
        return;
      }
    } catch {
      // 忽略单次异常，继续重试
    }
    if (++attempts < SSR_PROBE_MAX_ATTEMPTS) setTimeout(tick, SSR_PROBE_INTERVAL_MS);
  };
  setTimeout(tick, SSR_PROBE_INITIAL_DELAY_MS);
}

/** MAIN world 侧配置（隔离层经桥同步；供隐藏原文等屏上行为判断） */
let mainConfig: Pick<KindlyConfig, 'hideOriginalComment' | 'hideOriginalDanmaku'> | null = null;

export function shouldHideOriginal(kind: 'comment' | 'danmaku'): boolean {
  return kind === 'danmaku' ? (mainConfig?.hideOriginalDanmaku ?? false) : (mainConfig?.hideOriginalComment ?? false);
}

async function syncMainConfig(adapter: SiteAdapter): Promise<void> {
  try {
    const res = await sendToExtensionWithResponse<{ type: 'KW_CONFIG'; config: KindlyConfig }>({ type: 'KW_GET_CONFIG' });
    if (res?.type === 'KW_CONFIG' && res.config) {
      mainConfig = {
        hideOriginalComment: res.config.hideOriginalComment,
        hideOriginalDanmaku: res.config.hideOriginalDanmaku,
      };
      // 弹幕批大小/并发也由配置驱动（用户可选速度预设或自定义）
      dmBatchSize = res.config.dmBatchSize;
      dmConcurrency = res.config.dmConcurrency;
      // 弹幕站点开关（评论/弹幕分开管理）：关闭则不再劫持/送改写/屏上替换
      dmEnabled = res.config.danmakuEnabledSites.includes(adapter.key);
      if (dmEnabled && !dmProbeStarted) {
        dmProbeStarted = true;
        adapter.danmaku?.startLiveProbe?.();
      }
      // 配置变化后重新同步屏上弹幕占位状态（隐藏开启时把已加载原文替换为占位）
      adapterDanmaku?.onConfigChanged?.(mainConfig.hideOriginalDanmaku);
    }
  } catch {
    // 桥未就绪/失败：保持上次配置
  }
}

// ===== fetch 劫持 =====

function hijackFetch(adapter: SiteAdapter): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    try {
      if (adapter.matchReplyUrl(url)) return await handleReplyFetch(origFetch, input, init, adapter);
      if (adapter.danmaku?.matchUrl(url) && dmEnabled) return await handleDanmakuFetch(origFetch, input, init, adapter);
      if (adapter.videoMeta?.matchUrl(url)) {
        const res = await origFetch(input, init);
        void res
          .clone()
          .json()
          .then((data: unknown) => {
            const total = adapter.videoMeta!.extractDanmakuTotal(data);
            if (total !== null) sendToExtension({ type: 'KW_VIDEO_META', danmakuTotal: total });
          })
          .catch(() => {});
        return res;
      }
    } catch {
      // 劫持处理异常绝不影响页面请求：回退原始行为
    }
    return origFetch(input, init);
  };
}

/** 评论：原样放行 + 异步提取改写（零阻塞） */
async function handleReplyFetch(
  origFetch: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  adapter: SiteAdapter,
): Promise<Response> {
  const res = await origFetch(input, init);
  void res
    .clone()
    .json()
    .then((data: unknown) => {
      const items = adapter.extractReplies(data, String(input));
      if (items.length > 0) {
        notifyHijackActive();
        sendToExtension({ type: 'KW_REWRITE_COMMENTS', items });
        // 通知 isolated：这批评论已送改写（隐藏原文模式在渲染后显示"重写中"占位）
        sendToExtension({
          type: 'KW_COMMENTS_PENDING',
          items: items.map((i) => ({ id: i.id, seq: i.seq, path: i.path })),
        });
      }
    })
    .catch(() => {});
  return res;
}

/** 弹幕：先放行原文，异步改写后屏上替换 + 缓存 */
async function handleDanmakuFetch(
  origFetch: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  adapter: SiteAdapter,
): Promise<Response> {
  const danmaku = adapter.danmaku!;
  const res = await origFetch(input, init);
  if (!res.ok) return res;
  const headers = new Headers(res.headers);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0) return res;

  const elems = danmaku.parseResponse(buf);
  if (elems.length === 0) return res; // 纯指令/空响应，不动

  // 缓存命中（此前改写完成）→ 直接替换响应
  const cachedReplacements = new Map<string, string>();
  for (const e of elems) {
    const hit = rewriteCache.get(e.id);
    if (hit !== undefined && hit !== e.text) cachedReplacements.set(e.id, hit);
  }
  // 弹幕全量送改写（阴阳怪气交由 LLM 判断；同段按 id 去重）：
  // 全量分批 + 并发管道（DM_MAX_INFLIGHT 批在飞），不设单段条数上限
  const fresh = elems.filter((e) => !pendingIds.has(e.id));
  if (fresh.length > 0) {
    queueDanmakuBatches(fresh);
  }
  if (cachedReplacements.size > 0) {
    const modified = danmaku.rebuildResponse(buf, cachedReplacements);
    if (modified) return new Response(modified, { status: res.status, statusText: res.statusText, headers });
  }
  return new Response(buf, { status: res.status, statusText: res.statusText, headers });
}

// ===== XHR 劫持 =====

function hijackXhr(adapter: SiteAdapter): void {
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function open(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    (this as XMLHttpRequest & { __kwUrl?: string }).__kwUrl = String(url);
    // lib.dom 的 open 类型把 async 声明为必选，运行时 undefined 等价于 true（默认异步），
    // 用 as never 透传保持字节级语义
    return origOpen.apply(this, [method, url, async, username, password] as never);
  };
  XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, body?: XMLHttpRequestBodyInit | Document | null) {
    const url = (this as XMLHttpRequest & { __kwUrl?: string }).__kwUrl ?? '';
    origSend.call(this, body);
    if (adapter.matchReplyUrl(url)) {
      this.addEventListener('load', () => {
        try {
          const items = adapter.extractReplies(JSON.parse(this.responseText), url);
          if (items.length > 0) {
            notifyHijackActive();
            sendToExtension({ type: 'KW_REWRITE_COMMENTS', items });
            sendToExtension({
              type: 'KW_COMMENTS_PENDING',
              items: items.map((i) => ({ id: i.id, seq: i.seq, path: i.path })),
            });
          }
        } catch {
          // 非 JSON 响应，忽略
        }
      });
    } else if (adapter.danmaku?.matchUrl(url) && dmEnabled) {
      this.addEventListener('load', () => {
        // 只读提取：响应已由页面消费（放行），改写结果走屏上替换路径
        const raw = this.response;
        let data: Uint8Array;
        if (raw instanceof ArrayBuffer) {
          data = new Uint8Array(raw);
        } else if (typeof raw === 'string') {
          data = new TextEncoder().encode(raw);
        } else {
          return;
        }
        const elems = adapter.danmaku!.parseResponse(data);
        // 弹幕全量送改写（分批并发，不设单段条数上限）
        const fresh = elems.filter((e) => !pendingIds.has(e.id));
        if (fresh.length > 0) queueDanmakuBatches(fresh);
      });
    }
  };
}

// ===== 弹幕异步改写管道 =====

async function rewriteDanmakuWithText(entries: { id: string; text: string }[]): Promise<void> {
  for (const e of entries) markPendingId(e.id);
  // 屏上标记"处理中"（adapter 层按原文打灰"改"角标）
  adapterDanmaku?.onBatchSent?.(entries);
  const items: CommentItem[] = entries.map((e) => ({
    id: e.id,
    author: '',
    original: e.text,
    status: 'pending',
    kind: 'danmaku',
  }));
  const requestId = crypto.randomUUID();
  const res = await sendBatch(requestId, items);
  if (!res) {
    // 超时兜底：整批失败（保持原文），屏上标记"失败" + 页面 console 日志
    console.log(`[Kindly Web] 改写失败 · 弹幕 · 原因: timeout`, {
      时间: new Date().toISOString(),
      条目: entries.map((e) => ({ id: e.id, 原文: e.text })),
      说明: '45s 内未收到改写结果（SW 队列拥塞或网络异常）',
    });
    adapterDanmaku?.onBatchFailed?.(
      entries.map((e) => e.id),
      '改写超时，已保持原文',
    );
    return;
  }
  if (res.skipped) {
    // 阈值跳过（弹幕总量超过上限）：非失败，保持原文并打"跳过"标识
    adapterDanmaku?.onBatchSkipped?.(
      entries.map((e) => e.id),
      '弹幕总量超过处理上限，已跳过改写',
    );
    return;
  }
  const replacements = new Map<string, string>();
  const failedIds: string[] = [];
  for (const r of res.results) {
    if (r.rewritten !== '') {
      replacements.set(r.id, r.rewritten);
      cacheRewrite(r.id, r.rewritten);
    } else {
      failedIds.push(r.id);
    }
  }
  if (failedIds.length > 0) {
    adapterDanmaku?.onBatchFailed?.(failedIds, '改写失败，已保持原文');
  }
  if (replacements.size > 0) {
    // 屏上替换：adapter 层按原文文本匹配替换已渲染弹幕（DOM 元素为主，内存列表回退）
    adapterDanmaku?.applyLiveRewrites?.(replacements);
  }
}

interface BatchOutcome {
  results: { id: string; rewritten: string }[];
  skipped?: boolean;
}

function sendBatch(requestId: string, items: CommentItem[]): Promise<BatchOutcome | null> {
  const { promise, resolve } = Promise.withResolvers<BatchOutcome | null>();
  let settled = false;
  const finish = (value: BatchOutcome | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    resolve(value);
  };
  const timer = setTimeout(() => finish(null), BATCH_TIMEOUT_MS);
  const unsubscribe = listenFromExtension((msg) => {
    const m = msg as {
      type?: string;
      requestId?: string;
      results?: { id: string; rewritten: string }[];
      skipped?: boolean;
    };
    if (m?.type === 'KW_REWRITE_BATCH_RESULT' && m.requestId === requestId) {
      finish({ results: m.results ?? [], skipped: m.skipped });
    }
  });
  sendToExtension({ type: 'KW_REWRITE_BATCH', requestId, kind: 'danmaku', items });
  return promise;
}

function notifyHijackActive(): void {
  // 经消息桥 → SW → 广播给同 tab 的 isolated CS（content script 之间不能直接 runtime.sendMessage）
  sendToExtension({ type: 'KW_HIJACK_ACTIVE' });
}

// 弹幕屏上替换需要 adapter 引用（rewriteDanmakuWithText 使用）
let adapterDanmaku: SiteAdapter['danmaku'] | null = null;
