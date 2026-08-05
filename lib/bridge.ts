/**
 * MAIN world ↔ 扩展 消息桥。
 *
 * 背景：Chrome 137+ 的 Self-XSS 防护不再向 MAIN world 内容脚本暴露
 * chrome.runtime（实测 chrome.runtime 为 undefined），main-world 劫持层
 * 无法直接与 SW 通信。解法：main world 与 isolated world 共享 DOM window，
 * 经 window.postMessage 桥接 —— isolated 侧的 rewrite-ui 启动桥，
 * 负责把 MAIN 发来的消息转发给 SW、把 SW 回发（tabs.sendMessage）转发回 MAIN。
 *
 * 消息格式（带 __kwBridge 标记避免与页面消息冲突）：
 *  - MAIN → 桥：{ __kwBridge, kind:'to-ext', id, wantResponse, msg }
 *  - 桥 → MAIN：{ __kwBridge, kind:'to-page', id, msg }（id 为空 = SW 广播）
 */

const MARK = '__kwBridge';

import { browser } from 'wxt/browser';

// ===== MAIN world 侧 =====

/** 桥就绪标志（isolated 侧 startBridge 后发 ready 握手） */
let bridgeReady = false;
/** 桥未就绪期间的消息队列（页面脚本先于 isolated CS 执行时会丢失消息） */
const pendingQueue: unknown[] = [];

/** 发送消息给扩展（fire-and-forget，无响应；桥未就绪时排队，就绪后补发） */
export function sendToExtension(msg: unknown): void {
  if (!bridgeReady) {
    pendingQueue.push(msg);
    return;
  }
  window.postMessage({ [MARK]: true, kind: 'to-ext', wantResponse: false, id: '', msg }, '*');
}

/** 发送消息并等待扩展同步响应（popup 式 sendResponse） */
export function sendToExtensionWithResponse<T = unknown>(msg: unknown): Promise<T> {
  return new Promise<T>((resolve) => {
    const id = crypto.randomUUID();
    const handler = (e: MessageEvent) => {
      const d = e.data as { [MARK]?: boolean; kind?: string; id?: string; msg?: unknown };
      if (d?.[MARK] === true && d.kind === 'to-page' && d.id === id) {
        window.removeEventListener('message', handler);
        resolve(d.msg as T);
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ [MARK]: true, kind: 'to-ext', wantResponse: true, id, msg }, '*');
  });
}

/** 监听扩展回发（SW 广播，如 KW_REWRITE_BATCH_RESULT）；返回退订函数 */
export function listenFromExtension(listener: (msg: unknown) => void): () => void {
  const handler = (e: MessageEvent) => {
    const d = e.data as { [MARK]?: boolean; kind?: string; id?: string; msg?: unknown };
    if (d?.[MARK] !== true || d.kind !== 'to-page') return;
    if (d.id === '__bridge_ready') {
      // isolated 桥就绪握手：补发排队消息
      if (!bridgeReady) {
        bridgeReady = true;
        for (const msg of pendingQueue.splice(0)) {
          window.postMessage({ [MARK]: true, kind: 'to-ext', wantResponse: false, id: '', msg }, '*');
        }
      }
      return;
    }
    if (d.id === '') listener(d.msg);
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

// ===== isolated world 侧 =====

/** 启动桥（isolated world 调用一次）：双向转发 */
export function startBridge(): void {
  // MAIN → SW
  window.addEventListener('message', (e) => {
    const d = e.data as {
      [MARK]?: boolean;
      kind?: string;
      wantResponse?: boolean;
      id?: string;
      msg?: unknown;
    };
    if (d?.[MARK] !== true || d.kind !== 'to-ext') return;
    if (d.wantResponse) {
      browser.runtime.sendMessage(d.msg, (resp: unknown) => {
        window.postMessage({ [MARK]: true, kind: 'to-page', id: d.id, msg: resp }, '*');
      });
    } else {
      void browser.runtime.sendMessage(d.msg).catch(() => {});
    }
  });
  // SW → MAIN（转发 tabs.sendMessage 广播）
  browser.runtime.onMessage.addListener((msg: unknown) => {
    window.postMessage({ [MARK]: true, kind: 'to-page', id: '', msg }, '*');
  });
  // 就绪握手：通知 MAIN 侧桥已可用（补发排队消息）
  window.postMessage({ [MARK]: true, kind: 'to-page', id: '__bridge_ready', msg: null }, '*');
}
