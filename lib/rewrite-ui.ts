/**
 * 通用改写结果应用层（isolated world）。
 *
 * 与站点无关：DOM 定位与选择器经 SiteAdapter 注入（commentSelectors /
 * resolveCommentRoot）。本引擎负责：
 *  - 按 id 定位评论节点并登记（Map<id, Entry> + data-kw-id）
 *  - 结果应用：原地替换 / hover 原文气泡 / 失败角标 + 重试浮层（mode 由配置决定）
 *  - 劫持未激活时的 MutationObserver 兜底采集（10s 超时）
 *  - 自产 mutation 免疫 + 视口上方节点高度变化滚动补偿
 *  - 关闭/还原、配置热更新
 */

import { browser } from 'wxt/browser';
import { getConfig } from '@/lib/config';
import type { KindlyConfig } from '@/lib/config';
import { reasonLabel } from '@/lib/errors';
import type { CommentItem, RewriteReason } from '@/lib/messages';
import type { SiteAdapter } from '@/lib/sites/types';
import { startBridge } from '@/lib/bridge';

const MAX_TEXT_LENGTH = 1500;
const MIN_TEXT_LENGTH = 2;
/** 劫持层未激活时启用 observer 兜底的等待时长 */
const FALLBACK_DELAY_MS = 10_000;
const BATCH_FLUSH_COUNT = 8;
const BATCH_FLUSH_DELAY_MS = 1000;
const RESUBMIT_INTERVAL_MS = 15_000;
const RESUBMIT_AFTER_MS = 20_000;

interface Entry {
  root: HTMLElement;
  contentEl: HTMLElement;
  /** 内容中的纯文本节点（替换时保留元素子节点：emoji / @提及 / 链接） */
  textNodes: Text[];
  fallbackText: string;
  original: string;
  status: 'pending' | 'success' | 'error';
  sentAt: number;
  rewritten?: string;
  /** 评论在渲染列表中的顺序索引（B 站按 seq 定位） */
  seq?: number;
  /** 评论渲染树定位路径（楼中楼 [顶层 seq, 子索引]） */
  path?: number[];
  /** 隐藏原文模式：已替换为"重写中"占位（失败/还原时恢复原文） */
  hiddenOriginal?: boolean;
}

let adapter: SiteAdapter | null = null;
const registry = new Map<string, Entry>();
/** 结果先于 DOM 渲染到达时的重试队列（mock/快速模型/大页面场景的竞态修复） */
const pendingResults = new Map<string, { rewritten: string; seq?: number; path?: number[]; original?: string; attempts: number }>();

/** 隐藏模式占位文本（改写前不显示原文） */
const PENDING_PLACEHOLDER = '重写中';
const pendingErrors = new Map<string, { reason: RewriteReason; detail?: string; seq?: number; path?: number[]; attempts: number }>();
const PENDING_RETRY_MAX = 30; // 30 × 500ms ≈ 15s 窗口（懒加载评论区渲染可能晚于结果到达）
const PENDING_RETRY_INTERVAL_MS = 500;
let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
let config: KindlyConfig | null = null;
let active = false;
/** 劫持层已激活（收到 KW_HIJACK_ACTIVE）→ 不启动 observer 兜底 */
let hijackActive = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingItems: CommentItem[] = [];

export function startRewriteUi(site: SiteAdapter): void {
  adapter = site;
  startBridge(); // MAIN world 劫持层经此桥收发消息（Chrome 137+ MAIN world 无 chrome.runtime）
  browser.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'KW_REWRITE_RESULT':
        applyResult(msg.id, msg.rewritten, msg.seq, msg.path, msg.original);
        break;
      case 'KW_REWRITE_ERROR':
        applyError(msg.id, msg.reason, msg.detail, msg.seq, msg.path);
        break;
      case 'KW_SET_ENABLED':
        void setEnabled(msg.enabled);
        break;
      case 'KW_CONFIG_CHANGED':
        void reloadConfig();
        break;
      case 'KW_HIJACK_ACTIVE':
        onHijackActive();
        break;
      case 'KW_COMMENTS_PENDING':
        // 劫持路径的评论已送改写：登记处理中集合，已渲染的条目立即占位
        onCommentsPending(msg.items);
        break;
      case 'KW_FAILURE_LOG':
        // SW 改写失败详情 → 页面 DevTools console（面向开发者定位）
        console.log(
          `[Kindly Web] 改写失败 · ${msg.kind === 'danmaku' ? '弹幕' : '评论'} · 原因: ${msg.reason} · 重试: ${msg.attempts}次 · 时间: ${new Date().toISOString()} · 接口: ${msg.baseURL} · 模型: ${msg.modelName}`,
          {
            条目: msg.ids.map((id: string, i: number) => ({ id, 原文: msg.originals[i] })),
            请求返回内容: msg.detail,
          },
        );
        break;
    }
  });
  void init();
}

/** 已送改写、结果未回的评论 id（隐藏原文模式占位用） */
const pendingCommentIds = new Set<string>();

function onCommentsPending(items: { id: string; seq?: number; path?: number[] }[]): void {
  for (const item of items) pendingCommentIds.add(item.id);
  if (!config?.hideOriginalComment) return;
  for (const item of items) {
    const entry = resolveEntry(item.id, item.seq, item.path);
    if (entry && entry.status === 'pending') applyPendingPlaceholder(entry);
  }
}

async function init(): Promise<void> {
  config = await getConfig();
  applyActiveState();
}

async function reloadConfig(): Promise<void> {
  const prev = config;
  config = await getConfig();
  if (!active && config.enabled && config.enabledSites.includes(adapter!.key)) {
    applyActiveState();
    return;
  }
  if (active && prev && prev.mode !== config.mode) {
    for (const entry of registry.values()) {
      if (entry.status === 'success' && entry.rewritten) applyVisual(entry, entry.rewritten);
    }
  }
}

function applyActiveState(): void {
  const shouldRun = !!(config && config.enabled && config.enabledSites.includes(adapter!.key));
  if (shouldRun && !active) {
    active = true;
    if (!hijackActive && fallbackTimer === null) {
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        if (active && !hijackActive) startFallbackObserver();
      }, FALLBACK_DELAY_MS);
    }
    void scheduleScan();
  } else if (!shouldRun && active) {
    restoreAll();
  }
}

function onHijackActive(): void {
  hijackActive = true;
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// ===== 兜底采集（仅劫持未激活时启用）=====

function startFallbackObserver(): void {
  if (observer || !adapter) return;
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement && node.shadowRoot) {
          observer!.observe(node.shadowRoot, { childList: true, subtree: true });
          observeShadowDeep(node.shadowRoot, observer!);
        }
      }
    }
    void scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  observeShadowDeep(document, observer);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.setInterval(resubmitSweep, RESUBMIT_INTERVAL_MS);
  void scheduleScan();
}

function onScroll(): void {
  void scheduleScan();
}

// ===== shadow DOM 穿透查询 =====
// B 站评论区渲染在 <bili-comments> 的 Lit shadow root 内，
// document.querySelector 查不到 → 所有定位/采集必须穿透 shadow。

/** 递归收集元素及其所有 shadow root 内匹配选择器的元素 */
function queryShadowAll(root: ParentNode, selector: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (node: ParentNode) => {
    for (const el of node.querySelectorAll<HTMLElement>(selector)) out.push(el);
    for (const el of node.querySelectorAll<HTMLElement>('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}

/** 深度查找带 id 属性的评论节点（rpid / data-rpid / data-kw-id） */
function findShadowById(id: string): HTMLElement | null {
  try {
    const sel = `[rpid="${CSS.escape(id)}"], [data-rpid="${CSS.escape(id)}"], [data-kw-id="${CSS.escape(id)}"]`;
    return queryShadowAll(document, sel)[0] ?? null;
  } catch {
    return null;
  }
}

/** 递归为 shadow root 注册观察（评论组件懒渲染时采集不丢） */
function observeShadowDeep(root: ParentNode, obs: MutationObserver): void {
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (el.shadowRoot) {
      obs.observe(el.shadowRoot, { childList: true, subtree: true });
      observeShadowDeep(el.shadowRoot, obs);
    }
  }
}

let scanQueued = false;
/** 自产 DOM 变更免疫：替换文本/加角标不触发重扫 */
let ownDomChange = false;
function scheduleScan(): void {
  if (scanQueued || !active) return;
  if (ownDomChange) {
    ownDomChange = false;
    return;
  }
  scanQueued = true;
  window.setTimeout(() => {
    scanQueued = false;
    if (observer) scan();
  }, 120);
}

function scan(): void {
  if (!document.body || !adapter) return;
  const sel = adapter.commentSelectors;
  const roots = queryShadowAll(document, sel.root);
  const flushAt = Math.max(1, Math.min(20, config?.batchSize ?? BATCH_FLUSH_COUNT));
  for (const [i, root] of roots.entries()) {
    if (root.dataset.kwId) continue;
    const entry = collectEntry(root, crypto.randomUUID(), i);
    if (!entry) continue;
    pendingItems.push({ id: entryIdOf(entry), author: entryAuthor(entry), original: entry.original, status: 'pending', seq: i });
    if (pendingItems.length >= flushAt) {
      void flushBatch();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushBatch();
      }, BATCH_FLUSH_DELAY_MS);
    }
  }
  for (const [id, entry] of registry) {
    if (!entry.root.isConnected) registry.delete(id);
  }
}

async function flushBatch(): Promise<void> {
  if (pendingItems.length === 0) return;
  const items = pendingItems;
  pendingItems = [];
  for (const item of items) {
    const entry = registry.get(item.id);
    if (entry) {
      entry.sentAt = Date.now();
      // 隐藏原文模式：改写完成前不显示原文（占位"重写中"）
      if (config?.hideOriginalComment) applyPendingPlaceholder(entry);
    }
  }
  try {
    await browser.runtime.sendMessage({ type: 'KW_REWRITE_COMMENTS', items });
  } catch {
    restoreAll();
  }
}

/** 隐藏模式：把评论文本替换为"重写中"占位（原文不外露；失败/还原时恢复） */
function applyPendingPlaceholder(entry: Entry): void {
  if (entry.hiddenOriginal) return;
  entry.hiddenOriginal = true;
  mutateText(entry, () => {
    const [first, ...rest] = entry.textNodes;
    if (first) {
      first.textContent = PENDING_PLACEHOLDER;
      for (const node of rest) node.textContent = '';
    } else {
      entry.contentEl.textContent = PENDING_PLACEHOLDER;
    }
  });
}

/** SW 休眠/被杀导致结果丢失时，超时重新上报（幂等：SW 侧缓存去重） */
function resubmitSweep(): void {
  const stale = [...registry.values()].filter(
    (e) => e.status === 'pending' && e.sentAt > 0 && Date.now() - e.sentAt > RESUBMIT_AFTER_MS,
  );
  if (stale.length === 0) return;
  for (const entry of stale) entry.sentAt = Date.now();
  const items: CommentItem[] = stale.map((entry) => ({
    id: entryIdOf(entry),
    author: entryAuthor(entry),
    original: entry.original,
    status: 'pending',
    seq: entry.seq,
    path: entry.path,
  }));
  void browser.runtime.sendMessage({ type: 'KW_REWRITE_COMMENTS', items }).catch(() => {});
}

// ===== 节点定位与登记 =====

function entryIdOf(entry: Entry): string {
  return entry.root.dataset.kwId ?? '';
}

/** 按 id 定位节点并登记（优先注册表，其次站点定位器（path/seq 优先），最后 shadow 深度查找） */
function resolveEntry(id: string, seq?: number, path?: number[], original?: string): Entry | null {
  const existing = registry.get(id);
  if (existing) return existing;
  const root = adapter?.resolveCommentRoot(id, seq, path, original) ?? findShadowById(id);
  if (!root) return null;
  const entry = collectEntry(root, id, seq, path);
  if (!entry) return null;
  // 原文校正：消息携带的接口原文与 DOM 文本规范化一致时，以接口原文为准
  // （DOM 文本缺表情标记，校正后"原样返回"判断才准确，恢复原文也完整）
  const normalize = adapter?.normalizeText;
  if (original && normalize && normalize(original) === normalize(entry.original)) {
    entry.original = original;
  }
  return entry;
}

function collectEntry(root: HTMLElement, id: string, seq?: number, path?: number[]): Entry | null {
  if (!adapter) return null;
  const sel = adapter.commentSelectors;
  const primaryContentSelector = sel.content.split(',')[0]?.trim() ?? '';
  const contentEl =
    adapter.resolveContentNode?.(root) ??
    root.querySelector<HTMLElement>(sel.content) ??
    (primaryContentSelector && root.matches(primaryContentSelector) ? root : null) ??
    root;
  const textNodes = Array.from(contentEl.childNodes).filter(
    (n): n is Text => n.nodeType === Node.TEXT_NODE && Boolean(n.textContent?.trim()),
  );
  const fallbackText = contentEl.textContent?.trim() ?? '';
  const original = (textNodes.length > 0 ? textNodes.map((t) => t.textContent).join('') : fallbackText).trim();
  if (original.length < MIN_TEXT_LENGTH || original.length > MAX_TEXT_LENGTH) return null;
  const entry: Entry = { root, contentEl, textNodes, fallbackText, original, status: 'pending', sentAt: 0, seq, path };
  root.dataset.kwId = id;
  registry.set(id, entry);
  // 隐藏原文模式：该评论已送改写（劫持路径广播）→ 立即占位（渲染晚于发送的竞态）
  if (config?.hideOriginalComment && pendingCommentIds.has(id)) applyPendingPlaceholder(entry);
  return entry;
}

function entryAuthor(entry: Entry): string {
  if (!adapter) return '';
  const node =
    adapter.resolveAuthorNode?.(entry.root) ??
    entry.root.querySelector<HTMLElement>(adapter.commentSelectors.author);
  return node?.textContent?.trim() ?? '';
}

// ===== 结果应用 =====

function applyResult(id: string, rewritten: string, seq?: number, path?: number[], original?: string): void {
  const entry = resolveEntry(id, seq, path, original);
  if (!entry) {
    // DOM 尚未渲染（改写快于页面渲染）：排队等待重试
    if (!pendingResults.has(id)) {
      pendingResults.set(id, { rewritten, seq, path, original, attempts: 0 });
      schedulePendingRetry();
    }
    return;
  }
  if (entry.status !== 'pending') return;
  entry.status = 'success';
  entry.rewritten = rewritten;
  entry.hiddenOriginal = false;
  pendingCommentIds.delete(id);
  applyVisual(entry, rewritten);
}

/** 轮询重试尚未就绪的结果（结果先于评论 DOM 渲染的竞态） */
function schedulePendingRetry(): void {
  if (pendingRetryTimer) return;
  pendingRetryTimer = setTimeout(() => {
    pendingRetryTimer = null;
    for (const [id, p] of [...pendingResults]) {
      p.attempts++;
      if (p.attempts > PENDING_RETRY_MAX) {
        pendingResults.delete(id);
        continue;
      }
      const entry = resolveEntry(id, p.seq, p.path, p.original);
      if (entry && entry.status === 'pending') {
        pendingResults.delete(id);
        entry.status = 'success';
        entry.rewritten = p.rewritten;
        entry.hiddenOriginal = false;
        applyVisual(entry, p.rewritten);
      }
    }
    for (const [id, p] of [...pendingErrors]) {
      p.attempts++;
      if (p.attempts > PENDING_RETRY_MAX) {
        pendingErrors.delete(id);
        continue;
      }
      const entry = resolveEntry(id, p.seq, p.path);
      if (entry && entry.status === 'pending') {
        pendingErrors.delete(id);
        applyErrorToEntry(entry, p.reason, p.detail);
      }
    }
    if (pendingResults.size > 0 || pendingErrors.size > 0) schedulePendingRetry();
  }, PENDING_RETRY_INTERVAL_MS);
}

/** 按当前 UI 模式应用视觉：replace → 原地替换 + hover 原文；bubble → 仅悬停浮层 */
function applyVisual(entry: Entry, rewritten: string): void {
  removeVisual(entry);
  if (config?.mode === 'replace' && rewritten !== entry.original) {
    replaceText(entry, rewritten);
    attachHover(entry, '原文', entry.original);
  } else if (config?.mode === 'bubble' && rewritten !== entry.original) {
    attachHover(entry, '改写建议', rewritten);
  } else {
    entry.root.dataset.kwRewritten = 'noop';
  }
}

/** 原地替换/还原统一走这里：自产 mutation 免疫 + 上方节点高度变化视口补偿 */
function mutateText(entry: Entry, apply: () => void): void {
  const beforeHeight = entry.root.getBoundingClientRect().height;
  const rectBefore = entry.root.getBoundingClientRect();
  const isAboveViewport = rectBefore.bottom <= 0;
  withOwnChanges(apply);
  if (isAboveViewport) {
    const heightDelta = entry.root.getBoundingClientRect().height - beforeHeight;
    if (heightDelta !== 0) window.scrollBy({ top: heightDelta, behavior: 'instant' });
  }
}

function replaceText(entry: Entry, text: string): void {
  mutateText(entry, () => {
    const [first, ...rest] = entry.textNodes;
    if (first) {
      first.textContent = text;
      for (const node of rest) node.textContent = '';
    } else {
      entry.contentEl.textContent = text;
    }
  });
}

function restoreText(entry: Entry): void {
  mutateText(entry, () => {
    const [first, ...rest] = entry.textNodes;
    if (first) {
      first.textContent = entry.original;
      for (const node of rest) node.textContent = '';
    } else {
      entry.contentEl.textContent = entry.original;
    }
  });
}

/** 失败角标：点击展开可交互浮层（原因 + 原始错误 + 重试） */
function applyError(id: string, reason: RewriteReason, detail?: string, seq?: number, path?: number[]): void {
  pendingCommentIds.delete(id);
  const entry = resolveEntry(id, seq, path);
  if (!entry) {
    if (!pendingErrors.has(id)) {
      pendingErrors.set(id, { reason, detail, seq, path, attempts: 0 });
      schedulePendingRetry();
    }
    return;
  }
  if (entry.status !== 'pending') return;
  applyErrorToEntry(entry, reason, detail);
}

function applyErrorToEntry(entry: Entry, reason: RewriteReason, detail?: string): void {
  entry.status = 'error';
  // 隐藏模式占位中：失败恢复原文（+ 失败角标），避免永久"重写中"
  if (entry.hiddenOriginal) {
    entry.hiddenOriginal = false;
    restoreText(entry);
  }
  const badge = document.createElement('span');
  badge.className = 'kw-badge';
  // shadow DOM 内不受全局 CSS 影响 → 关键样式内联（流式布局，不依赖定位上下文）
  badge.style.cssText =
    'display:inline-block;margin-left:8px;vertical-align:middle;background:#ff6b6b;color:#fff;' +
    'font-size:12px;line-height:1.4;padding:2px 8px;border-radius:10px;cursor:pointer;user-select:none;';
  badge.textContent = '重写失败';
  badge.title = reasonLabel(reason);
  withOwnChanges(() => {
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      showErrorBubble(entry, reason, detail);
    });
    entry.root.appendChild(badge);
  });
}

/** 重试：重置为 pending 并重新上报（幂等：SW 侧缓存去重） */
function retryEntry(entry: Entry): void {
  hideBubble();
  const id = entryIdOf(entry);
  entry.root.querySelector('.kw-badge')?.remove();
  entry.status = 'pending';
  entry.sentAt = Date.now();
  const item: CommentItem = { id, author: entryAuthor(entry), original: entry.original, status: 'pending', seq: entry.seq, path: entry.path };
  void browser.runtime.sendMessage({ type: 'KW_REWRITE_COMMENTS', items: [item] }).catch(() => {});
}

// ===== Hover / 错误浮层（共享单例）=====

interface BubbleState {
  el: HTMLDivElement;
  labelEl: HTMLSpanElement;
  textEl: HTMLSpanElement;
  retryBtn: HTMLButtonElement;
  current: HTMLElement | null;
  errorEntry: Entry | null;
}

let bubble: BubbleState | null = null;

function ensureBubble(): BubbleState {
  if (bubble) return bubble;
  const el = document.createElement('div');
  el.className = 'kw-bubble kw-bubble-interactive';
  el.setAttribute('role', 'tooltip');
  const labelEl = document.createElement('span');
  labelEl.className = 'kw-bubble-label';
  const textEl = document.createElement('span');
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'kw-bubble-retry';
  retryBtn.textContent = '重试';
  retryBtn.style.display = 'none';
  retryBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (bubble?.errorEntry) retryEntry(bubble.errorEntry);
  });
  el.append(labelEl, textEl, retryBtn);
  document.documentElement.appendChild(el);
  bubble = { el, labelEl, textEl, retryBtn, current: null, errorEntry: null };
  return bubble;
}

function showErrorBubble(entry: Entry, reason: RewriteReason, detail?: string): void {
  const state = ensureBubble();
  hideBubble();
  state.errorEntry = entry;
  state.labelEl.textContent = `重写失败：${reasonLabel(reason)}`;
  state.textEl.textContent = detail || '请检查 API 设置后重试';
  state.retryBtn.style.display = 'inline-block';
  state.el.style.display = 'block';
  const rect = entry.root.getBoundingClientRect();
  state.el.style.left = `${Math.min(rect.left, window.innerWidth - state.el.getBoundingClientRect().width - 8)}px`;
  state.el.style.top = `${rect.bottom + 6}px`;
}

function hideBubble(): void {
  if (!bubble) return;
  bubble.el.style.display = 'none';
  bubble.current = null;
  bubble.errorEntry = null;
  bubble.retryBtn.style.display = 'none';
}

function attachHover(entry: Entry, label: string, text: string): void {
  const state = ensureBubble();
  const node = entry.contentEl;
  const onEnter = (e: MouseEvent) => {
    hideBubble();
    state.current = node;
    state.labelEl.textContent = label;
    state.textEl.textContent = text;
    state.retryBtn.style.display = 'none';
    positionBubble(state, e);
    state.el.style.display = 'block';
  };
  const onMove = (e: MouseEvent) => {
    if (state.current === node) positionBubble(state, e);
  };
  const onLeave = () => {
    if (state.current === node) {
      state.el.style.display = 'none';
      state.current = null;
    }
  };
  node.addEventListener('mouseenter', onEnter);
  node.addEventListener('mousemove', onMove);
  node.addEventListener('mouseleave', onLeave);
  entry.root.dataset.kwHover = '1';
}

function positionBubble(state: BubbleState, e: MouseEvent): void {
  const rect = state.el.getBoundingClientRect();
  const x = Math.min(e.clientX + 14, window.innerWidth - rect.width - 8);
  let y = e.clientY + 16;
  if (y + rect.height > window.innerHeight - 8) y = Math.max(8, e.clientY - rect.height - 12);
  state.el.style.left = `${Math.max(8, x)}px`;
  state.el.style.top = `${y}px`;
}

function removeVisual(entry: Entry): void {
  if (entry.root.dataset.kwHover === '1') {
    // hover 监听绑定在 contentEl 上，无法按节点解绑，用克隆替换以释放监听器
    withOwnChanges(() => {
      const clone = entry.contentEl.cloneNode(true) as HTMLElement;
      entry.contentEl.replaceWith(clone);
      entry.contentEl = clone;
      entry.textNodes = Array.from(clone.childNodes).filter(
        (n): n is Text => n.nodeType === Node.TEXT_NODE && Boolean(n.textContent?.trim()),
      );
    });
    delete entry.root.dataset.kwHover;
  }
}

/** 包住自产 DOM 写入，令后续 mutation 回调不触发重扫 */
function withOwnChanges(fn: () => void): void {
  ownDomChange = true;
  fn();
}

// ===== 关闭 / 还原 =====

async function setEnabled(enabled: boolean): Promise<void> {
  if (config) config = { ...config, enabled };
  if (!enabled && active) {
    restoreAll();
  } else if (enabled && !active && config) {
    applyActiveState();
  }
}

function restoreAll(): void {
  active = false;
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  for (const entry of registry.values()) {
    if (entry.status === 'success' && entry.rewritten !== entry.original) {
      restoreText(entry);
    }
    withOwnChanges(() => {
      entry.root.querySelector('.kw-badge')?.remove();
      entry.root.removeAttribute('data-kw-id');
      removeVisual(entry);
    });
  }
  registry.clear();
  pendingResults.clear();
  pendingErrors.clear();
  pendingItems = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  hideBubble();
}
