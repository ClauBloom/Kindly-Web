/**
 * 通用劫持引擎（main world，与页面共享 window）。
 *
 * 与站点无关：评论/弹幕的所有站点差异经由 SiteAdapter 注入
 * （URL 匹配、响应提取/重编码、屏上替换）。本引擎只负责：
 *  - 包装 window.fetch / XMLHttpRequest（document_start 注入，先于页面业务脚本）
 *  - 评论：响应零阻塞放行 + 异步提取改写
 *  - 弹幕：先放行 → 本地过滤器 → 批量改写（12s 超时兜底）→ 屏上替换 + 缓存重载替换
 *  - 任何异常回退原始请求行为，绝不阻塞/破坏页面
 */

import { isSuspiciousDanmaku } from '@/lib/badwords';
import { listenFromExtension, sendToExtension } from '@/lib/bridge';
import type { SiteAdapter } from '@/lib/sites/types';
import type { CommentItem } from '@/lib/messages';

/** 弹幕批量改写等待上限：超时直接放弃（弹幕保持原文） */
const BATCH_TIMEOUT_MS = 12_000;
/** 单段最多送改写的弹幕条数（防单段命中过多拖慢管道） */
const MAX_SUSPICIOUS_PER_SEGMENT = 40;

/** 改写结果缓存（id → 友善版），供弹幕段重载时直接替换 */
const rewriteCache = new Map<string, string>();
/** 已发送改写的 id（同段去重） */
const pendingIds = new Set<string>();

export function startHijack(adapter: SiteAdapter): void {
  adapterDanmaku = adapter.danmaku ?? null;
  adapter.danmaku?.startLiveProbe?.();
  // 注册桥广播监听：处理 isolated 侧的 __bridge_ready 握手（此后 sendToExtension 才直发）。
  // 必须在 startHijack 立即注册，否则评论路径的 sendToExtension 会一直排队（bridgeReady 永不为 true）。
  listenFromExtension(() => {});
  hijackFetch(adapter);
  hijackXhr(adapter);
}

// ===== fetch 劫持 =====

function hijackFetch(adapter: SiteAdapter): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    try {
      if (adapter.matchReplyUrl(url)) return await handleReplyFetch(origFetch, input, init, adapter);
      if (adapter.danmaku?.matchUrl(url)) return await handleDanmakuFetch(origFetch, input, init, adapter);
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
  // 新可疑弹幕 → 异步改写（不阻塞本次响应）
  const suspicious = elems
    .filter((e) => !pendingIds.has(e.id) && isSuspiciousDanmaku(e.text))
    .slice(0, MAX_SUSPICIOUS_PER_SEGMENT);
  if (suspicious.length > 0) {
    void rewriteDanmakuWithText(suspicious);
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
          }
        } catch {
          // 非 JSON 响应，忽略
        }
      });
    } else if (adapter.danmaku?.matchUrl(url)) {
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
        const suspicious = elems
          .filter((e) => !pendingIds.has(e.id) && isSuspiciousDanmaku(e.text))
          .slice(0, MAX_SUSPICIOUS_PER_SEGMENT);
        if (suspicious.length > 0) void rewriteDanmakuWithText(suspicious);
      });
    }
  };
}

// ===== 弹幕异步改写管道 =====

async function rewriteDanmakuWithText(entries: { id: string; text: string }[]): Promise<void> {
  for (const e of entries) pendingIds.add(e.id);
  const items: CommentItem[] = entries.map((e) => ({
    id: e.id,
    author: '',
    original: e.text,
    status: 'pending',
    kind: 'danmaku',
  }));
  const requestId = crypto.randomUUID();
  const results = await sendBatch(requestId, items);
  if (!results) return;
  const replacements = new Map<string, string>();
  for (const r of results) {
    if (r.rewritten !== '') {
      replacements.set(r.id, r.rewritten);
      rewriteCache.set(r.id, r.rewritten);
    }
  }
  if (replacements.size > 0) {
    // 屏上替换（尽力而为）：播放器内存列表 → canvas 下一帧重绘
    adapterDanmaku?.applyLiveRewrites?.(replacements);
  }
}

function sendBatch(requestId: string, items: CommentItem[]): Promise<{ id: string; rewritten: string }[] | null> {
  const { promise, resolve } = Promise.withResolvers<{ id: string; rewritten: string }[] | null>();
  let settled = false;
  const finish = (value: { id: string; rewritten: string }[] | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    resolve(value);
  };
  const timer = setTimeout(() => finish(null), BATCH_TIMEOUT_MS);
  const unsubscribe = listenFromExtension((msg) => {
    const m = msg as { type?: string; requestId?: string; results?: { id: string; rewritten: string }[] };
    if (m?.type === 'KW_REWRITE_BATCH_RESULT' && m.requestId === requestId) {
      finish(m.results ?? []);
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
