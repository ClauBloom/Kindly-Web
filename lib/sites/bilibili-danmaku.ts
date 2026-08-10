/**
 * B 站弹幕适配器（/x/v2/dm/web/seg.so protobuf + /x/v1/dm/list.so xml）。
 *
 * 弹幕改写管道（先放行 → 异步改写 → 屏上替换）的站点侧实现：
 *  - 极简 protobuf 编解码（字段序保留重编码，未知字段字节级保留）
 *  - 屏上替换（主通道，实测 2026-08）：B 站弹幕是 DOM 元素
 *    （.bpx-player-render-dm-wrap 下 .bili-danmaku-x-dm，无 id 属性），
 *    MutationObserver 按原文文本匹配替换 textContent；状态角标（改/✓/!/跳）
 *    与隐藏原文占位（"重写中"）也在此层维护
 *  - probe 回退：播放器内存弹幕列表探测（DOM 观察不可用时兜底）
 *
 * 结构依据 bilibili-API-collect 文档 + 实测（2026-08）：
 *  - seg.so 顶层：field 1 = repeated DanmakuElem（普通弹幕）；field 4/5 = 指令弹幕（原样保留）
 *  - DanmakuElem：1 id 2 progress 3 mode 4 fontsize 5 color 6 midHash 7 content 8 ctime
 *    9 weight 10 action 11 pool 12 idStr 13 attr
 */

import type { SiteDanmakuAdapter } from './types.ts';
import { normalizeCommentText } from './bilibili.ts';

// ===== protobuf 通用编解码（wire format 与站点无关，但当前仅 B 站使用）=====

export interface PbField {
  field: number;
  wire: 0 | 1 | 2 | 5;
  value: Uint8Array | bigint;
}

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < bytes.length) {
    const b = bytes[i++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, next: i };
    shift += 7n;
    if (shift > 63n) break;
  }
  return { value: result, next: i };
}

function writeVarint(value: bigint): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

export function decodePb(bytes: Uint8Array): PbField[] {
  const fields: PbField[] = [];
  let i = 0;
  while (i < bytes.length) {
    const tag = readVarint(bytes, i);
    i = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n) as PbField['wire'];
    if (wire === 0) {
      const v = readVarint(bytes, i);
      i = v.next;
      fields.push({ field, wire, value: v.value });
    } else if (wire === 1) {
      fields.push({ field, wire, value: bytes.slice(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = readVarint(bytes, i);
      i = len.next;
      const start = i;
      i += Number(len.value);
      fields.push({ field, wire, value: bytes.slice(start, i) });
    } else if (wire === 5) {
      fields.push({ field, wire, value: bytes.slice(i, i + 4) });
      i += 4;
    } else {
      break; // wire 3/4（group）极罕见，遇异常数据即停止
    }
  }
  return fields;
}

export function encodePb(fields: PbField[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const f of fields) {
    chunks.push(writeVarint(BigInt((f.field << 3) | f.wire)));
    if (f.wire === 0) {
      chunks.push(writeVarint(f.value as bigint));
    } else if (f.wire === 2) {
      chunks.push(writeVarint(BigInt((f.value as Uint8Array).length)));
      chunks.push(f.value as Uint8Array);
    } else {
      chunks.push(f.value as Uint8Array);
    }
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ===== seg.so 解析 / 重编码 =====

function extractSegElems(bytes: Uint8Array): { id: string; idStr: string; progress: number; content: string }[] {
  const elems: { id: string; idStr: string; progress: number; content: string }[] = [];
  for (const f of decodePb(bytes)) {
    if (f.field !== 1 || f.wire !== 2) continue;
    const sub = decodePb(f.value as Uint8Array);
    let id = '';
    let idStr = '';
    let progress = 0;
    let content = '';
    for (const s of sub) {
      if (s.wire === 0) {
        if (s.field === 1) id = (s.value as bigint).toString();
        else if (s.field === 2) progress = Number(s.value);
      } else if (s.wire === 2) {
        const text = new TextDecoder().decode(s.value as Uint8Array);
        if (s.field === 7) content = text;
        else if (s.field === 12) idStr = text;
      }
    }
    if (content === '' && id === '') continue;
    elems.push({ id, idStr: idStr || id, progress, content });
  }
  return elems;
}

function replaceSegContent(bytes: Uint8Array, replacements: ReadonlyMap<string, string>): Uint8Array | null {
  const top = decodePb(bytes);
  let changed = false;
  const out = top.map((f) => {
    if (f.field !== 1 || f.wire !== 2) return f;
    const sub = decodePb(f.value as Uint8Array);
    let idStr = '';
    for (const s of sub) {
      if (s.field === 12 && s.wire === 2) idStr = new TextDecoder().decode(s.value as Uint8Array);
    }
    const replacement = idStr ? replacements.get(idStr) : undefined;
    if (replacement === undefined) return f;
    const rebuilt = sub.map((s) => {
      if (s.field === 7 && s.wire === 2) {
        changed = true;
        return { ...s, value: new TextEncoder().encode(replacement) };
      }
      return s;
    });
    return { ...f, value: encodePb(rebuilt) };
  });
  return changed ? encodePb(out) : null;
}

// ===== list.so（xml）解析 / 重编码 =====

function parseXmlDanmaku(xml: string): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const re = /<d p="([^"]*)">([\s\S]*?)<\/d>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const id = m[1]?.split(',')[0] ?? '';
    const text = m[2] ?? '';
    if (id && text.trim()) out.push({ id, text });
  }
  return out;
}

function replaceXmlContent(xml: string, replacements: ReadonlyMap<string, string>): string | null {
  let changed = false;
  const out = xml.replace(/<d p="([^"]*)">([\s\S]*?)<\/d>/g, (full, p: string, text: string) => {
    const id = p.split(',')[0] ?? '';
    const replacement = id ? replacements.get(id) : undefined;
    if (replacement === undefined || replacement === text) return full;
    changed = true;
    return `<d p="${p}">${replacement}</d>`;
  });
  return changed ? out : null;
}

// ===== 屏上替换与状态标识 =====

interface DanmakuRecord {
  content?: string;
  progress?: number;
  id?: number | string;
  idStr?: string;
  [key: string]: unknown;
}

let liveList: DanmakuRecord[] | null = null;
let probing = false;

/**
 * B 站弹幕是 DOM 元素渲染（实测 2026-08）：.bpx-player-render-dm-wrap
 * 下的 .bili-danmaku-x-dm（文本节点，无 id 属性）→ 只能按原文文本匹配替换。
 * probe（内存列表探测）仅在 DOM 观察不可用时作为回退。
 */
let dmObserver: MutationObserver | null = null;
let dmContainer: HTMLElement | null = null;
/** id → 原文（parseResponse 时积累，applyLiveRewrites 借它做结果映射） */
const idToText = new Map<string, string>();
/**
 * 以下各 Map 的 key 统一为规范化原文（normalizeCommentText：去 [表情] 标记 + 压缩空白）。
 * 弹幕 DOM 元素无 id，按文本匹配；DOM 渲染后表情变图片、textContent 缺标记，
 * 必须规范化后才能与接口原文对上。
 */
/** 规范化原文 → 改写文本（弹幕 DOM 元素无 id，按文本匹配） */
const rewriteResults = new Map<string, string>();
/** 规范化原文 → 发送时间戳（处理中；超时自动降级不显示角标） */
const pendingTexts = new Map<string, number>();
/** 规范化原文 → 失败原因（改写失败保持原文，屏上打"失败"角标） */
const failTexts = new Map<string, string>();
/** 规范化原文 → 跳过原因（弹幕总量超过处理上限时整批跳过，屏上打"跳过"角标） */
const skipTexts = new Map<string, string>();

/** 改写前隐藏原文（弹幕）：屏上显示"重写中"占位，改写完成后替换（经桥从 SW 同步） */
let hideOriginalDanmaku = false;
/** 占位文本（隐藏模式 + 处理中） */
const PENDING_PLACEHOLDER = '重写中';
/** 占位弹幕"划过中线"检查间隔（弹幕全屏滚动约 4–6s，250ms 精度足够） */
const DM_MIDLINE_CHECK_MS = 250;

/** 配置变化（hijack-engine 经桥同步后回调）：更新隐藏标志并重扫屏上占位 */
function onDmConfigChanged(hide: boolean): void {
  hideOriginalDanmaku = hide;
  if (!hide) stopDmMidlineReveal();
  applyDmTextReplacements();
}

/**
 * 判定弹幕是否已划过播放器中线：右边缘越过中线（整条弹幕已进入左半屏）。
 * 纯函数，便于单元测试。
 */
export function dmCrossedMidline(elRight: number, containerLeft: number, containerWidth: number): boolean {
  return elRight <= containerLeft + containerWidth / 2;
}

/**
 * 隐藏原文模式下的"过中线恢复"：
 * 弹幕划过播放器中线仍未改写完成 → 占位对用户无意义（即将出画），
 * 自动恢复原文（结果若在屏期间返回，正常替换逻辑仍会生效）。
 * 仅在存在占位元素时轮询，无占位即自停。
 */
let dmRevealTimer: number | null = null;

function startDmMidlineReveal(): void {
  if (dmRevealTimer || !hideOriginalDanmaku) return;
  dmRevealTimer = setInterval(checkDmMidlineReveal, DM_MIDLINE_CHECK_MS);
}

function stopDmMidlineReveal(): void {
  if (dmRevealTimer) {
    clearInterval(dmRevealTimer);
    dmRevealTimer = null;
  }
}

function checkDmMidlineReveal(): void {
  if (!dmContainer || !hideOriginalDanmaku) return;
  const els = dmContainer.querySelectorAll<HTMLElement>('.bili-danmaku-x-dm[data-kw-dm-orig]');
  if (els.length === 0) {
    stopDmMidlineReveal();
    return;
  }
  const containerRect = dmContainer.getBoundingClientRect();
  for (const el of els) {
    const orig = el.dataset.kwDmOrig ?? '';
    if (orig === '') continue;
    if (dmCrossedMidline(el.getBoundingClientRect().right, containerRect.left, containerRect.width)) {
      // 已过中线仍未改写：恢复原文并退出处理中（结果返回后 applyDmTextReplacements 会正常替换）
      el.textContent = orig;
      delete el.dataset.kwDmOrig;
      pendingTexts.delete(normalizeCommentText(orig));
    }
  }
}

/** 处理中角标超时（毫秒）：超过后不再显示"改"标（结果可能已丢，避免永久悬空） */
const PENDING_BADGE_TTL_MS = 15_000;

/**
 * 弹幕状态角标（屏上显示处理情况）：
 *  - 处理中：灰"改"（已送 LLM，等待结果）
 *  - 已处理：绿"✓"（文本已替换为友善版）
 *  - 失败：红"!"（改写失败，保持原文；悬停可见原因）
 * 弹幕元素是动态池（出现→移动→移除），角标随元素生命周期自然清理。
 */
function badgeStyle(bg: string): string {
  return (
    'display:inline-block;margin-left:4px;vertical-align:middle;' +
    `background:${bg};color:#fff;font-size:9px;line-height:1.3;` +
    'padding:0 3px;border-radius:3px;user-select:none;pointer-events:none;'
  );
}

function syncDmBadge(el: HTMLElement, original: string): void {
  el.querySelector('.kw-dm-badge')?.remove();
  const now = Date.now();
  if (rewriteResults.has(original)) {
    const span = document.createElement('span');
    span.className = 'kw-dm-badge';
    span.style.cssText = badgeStyle('#4c7a5c');
    span.textContent = '✓';
    el.appendChild(span);
    return;
  }
  const failReason = failTexts.get(original);
  if (failReason !== undefined) {
    const span = document.createElement('span');
    span.className = 'kw-dm-badge';
    span.style.cssText = badgeStyle('#ff6b6b');
    span.textContent = '!';
    span.title = failReason;
    el.appendChild(span);
    return;
  }
  const skipReason = skipTexts.get(original);
  if (skipReason !== undefined) {
    const span = document.createElement('span');
    span.className = 'kw-dm-badge';
    span.style.cssText = badgeStyle('#9aa5a0');
    span.textContent = '跳';
    span.title = `跳过改写：${skipReason}`;
    el.appendChild(span);
    return;
  }
  const sentAt = pendingTexts.get(original);
  if (sentAt !== undefined && now - sentAt < PENDING_BADGE_TTL_MS) {
    const span = document.createElement('span');
    span.className = 'kw-dm-badge';
    span.style.cssText = badgeStyle('#9aa5a0');
    span.textContent = '改';
    el.appendChild(span);
  }
}

/** 观察弹幕渲染容器：新弹幕元素出现时按文本替换 */
function startDmDomObserver(maxAttempts = 15, intervalMs = 2000): void {
  if (dmObserver) return;
  let attempts = 0;
  const tick = () => {
    if (dmObserver) return;
    const el = document.querySelector<HTMLElement>('.bpx-player-render-dm-wrap');
    if (el) {
      dmContainer = el;
      dmObserver = new MutationObserver(() => applyDmTextReplacements());
      dmObserver.observe(el, { childList: true, subtree: true });
      applyDmTextReplacements();
      return;
    }
    if (++attempts > maxAttempts) return;
    setTimeout(tick, intervalMs);
  };
  tick();
}

/** 按原文匹配现存/新增弹幕 DOM 元素并替换为改写文本 */
function applyDmTextReplacements(): void {
  if (!dmContainer) return;
  const now = Date.now();
  const els = dmContainer.querySelectorAll<HTMLElement>('.bili-danmaku-x-dm');
  for (const el of els) {
    // 占位元素用 dataset 记录原文；普通元素用当前文本（均规范化后作为 Map key）
    const raw = el.dataset.kwDmOrig ?? el.textContent?.trim() ?? '';
    if (raw === '') continue;
    const key = normalizeCommentText(raw);
    const rewritten = rewriteResults.get(key);
    if (rewritten !== undefined && el.textContent !== rewritten) {
      el.textContent = rewritten;
      delete el.dataset.kwDmOrig;
    }
    // 失败：恢复原文 + 红标（隐藏模式下也不保留占位）
    if (failTexts.has(key) && el.textContent !== raw) {
      el.textContent = raw;
      delete el.dataset.kwDmOrig;
    }
    const sentAt = pendingTexts.get(key);
    if (hideOriginalDanmaku) {
      if (sentAt !== undefined && el.textContent !== PENDING_PLACEHOLDER) {
        // 隐藏模式 + 处理中：原文不外露，显示"重写中"占位
        el.dataset.kwDmOrig = raw;
        el.textContent = PENDING_PLACEHOLDER;
        startDmMidlineReveal();
      } else if (sentAt === undefined && el.textContent === PENDING_PLACEHOLDER) {
        // 处理中状态过期/丢失（如桥断、结果丢失）：恢复原文，避免永久占位
        el.textContent = raw;
        delete el.dataset.kwDmOrig;
      }
    }
    // 角标：占位文本即状态（隐藏模式处理中不打"改"标）；成功/失败/跳过始终打
    if (
      rewriteResults.has(key) ||
      failTexts.has(key) ||
      skipTexts.has(key) ||
      (!hideOriginalDanmaku && sentAt !== undefined && now - sentAt < PENDING_BADGE_TTL_MS)
    ) {
      syncDmBadge(el, key);
    }
  }
}

function probe(root: unknown, depth: number, seen: Set<object>): DanmakuRecord[] | null {
  if (root === null || typeof root !== 'object' || depth <= 0) return null;
  if (seen.has(root as object)) return null;
  seen.add(root as object);
  if (Array.isArray(root)) {
    if (root.length > 0) {
      const sample = root[0] as DanmakuRecord | undefined;
      if (sample && typeof sample === 'object' && typeof sample.content === 'string' && typeof sample.progress === 'number') {
        return root as DanmakuRecord[];
      }
    }
    for (const item of root) {
      const found = probe(item, depth - 1, seen);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(root as Record<string, unknown>)) {
    if (key.length > 24 || key === 'prototype' || key === 'webkitStorageInfo') continue;
    let child: unknown;
    try {
      child = (root as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (child !== null && typeof child === 'object') {
      const found = probe(child, depth - 1, seen);
      if (found) return found;
    }
  }
  return null;
}

function startProbe(maxAttempts = 15, intervalMs = 2000): void {
  if (probing) return;
  probing = true;
  let attempts = 0;
  const tick = () => {
    attempts++;
    if (liveList) return;
    if (attempts > maxAttempts) {
      probing = false;
      return;
    }
    try {
      const found = probe(window, 4, new Set());
      if (found) {
        liveList = found;
        probing = false;
        return;
      }
    } catch {
      // 忽略探测异常，继续重试
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}

function applyLiveRewrites(replacements: ReadonlyMap<string, string>): boolean {
  let changed = false;
  // 1) 旧路径：播放器内存列表可达时（canvas 渲染的旧播放器）
  if (liveList) {
    for (const item of liveList) {
      const id = String(item.idStr ?? item.id ?? '');
      const replacement = replacements.get(id);
      if (replacement !== undefined && item.content !== replacement) {
        item.content = replacement;
        changed = true;
      }
    }
  }
  // 2) DOM 路径（B 站主通道）：id → 原文 → 规范化 → 文本匹配替换
  for (const [id, rewritten] of replacements) {
    const original = idToText.get(id);
    if (original !== undefined && original !== rewritten) {
      const key = normalizeCommentText(original);
      rewriteResults.set(key, rewritten);
      pendingTexts.delete(key);
      failTexts.delete(key);
      changed = true;
    }
  }
  if (changed) applyDmTextReplacements();
  return changed;
}

/**
 * 批发送时标记"处理中"（原文 → 灰"改"角标）。
 * 结果返回后由 applyLiveRewrites（成功）/ onBatchFailed（失败）清除。
 */
function markDmPending(items: { id: string; text: string }[]): void {
  const now = Date.now();
  for (const item of items) {
    pendingTexts.set(normalizeCommentText(item.text), now);
  }
  applyDmTextReplacements();
}

/** 批中部分/全部改写失败：保持原文，屏上打"失败"角标 */
function markDmFailed(ids: string[], reason?: string): void {
  let changed = false;
  for (const id of ids) {
    const original = idToText.get(id);
    if (original === undefined) continue;
    const key = normalizeCommentText(original);
    failTexts.set(key, reason ?? '改写失败，已保持原文');
    pendingTexts.delete(key);
    changed = true;
  }
  if (changed) applyDmTextReplacements();
}

/** 弹幕被跳过改写（弹幕总量超过处理上限）：保持原文，屏上打"跳过"角标 */
function markDmSkipped(ids: string[], reason: string): void {
  let changed = false;
  for (const id of ids) {
    const original = idToText.get(id);
    if (original === undefined) continue;
    const key = normalizeCommentText(original);
    skipTexts.set(key, reason);
    pendingTexts.delete(key);
    changed = true;
  }
  if (changed) applyDmTextReplacements();
}

// ===== adapter 装配 =====

/** 探测响应格式：xml（<d …>）vs protobuf（seg.so） */
function isXmlResponse(data: Uint8Array): boolean {
  return new TextDecoder().decode(data.slice(0, 32)).trimStart().startsWith('<');
}

export const bilibiliDanmakuAdapter: SiteDanmakuAdapter = {
  matchUrl: (url) => /\/x\/v2\/dm\/(?:wbi\/)?web\/seg\.so/.test(url) || /\/x\/v1\/dm\/list\.so/.test(url),
  parseResponse(data) {
    if (isXmlResponse(data)) {
      const parsed = parseXmlDanmaku(new TextDecoder().decode(data));
      for (const d of parsed) idToText.set(d.id, d.text);
      return parsed;
    }
    const elems = extractSegElems(data);
    for (const e of elems) idToText.set(e.idStr, e.content);
    return elems.map((e) => ({ id: e.idStr, text: e.content }));
  },
  rebuildResponse(buf, replacements) {
    if (isXmlResponse(buf)) {
      const rebuilt = replaceXmlContent(new TextDecoder().decode(buf), replacements);
      return rebuilt !== null ? new TextEncoder().encode(rebuilt) : null;
    }
    return replaceSegContent(buf, replacements);
  },
  applyLiveRewrites,
  onBatchSent: markDmPending,
  onBatchFailed: markDmFailed,
  onBatchSkipped: markDmSkipped,
  onConfigChanged: onDmConfigChanged,
  startLiveProbe: () => {
    // 双通道：DOM 弹幕观察（主）+ 内存列表探测（probe 回退）
    startProbe();
    startDmDomObserver();
  },
};
