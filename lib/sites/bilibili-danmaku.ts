/**
 * B 站弹幕适配器（/x/v2/dm/web/seg.so protobuf + /x/v1/dm/list.so xml）。
 *
 * 弹幕改写管道（先放行 → 异步改写 → 屏上替换）的站点侧实现：
 *  - 极简 protobuf 编解码（字段序保留重编码，未知字段字节级保留）
 *  - 屏上替换：深度探测播放器内存弹幕列表（{content, progress} 数组），
 *    改 content 字段 → canvas 每帧重绘友善版（渐进增强，失败即降级）
 *
 * 结构依据 bilibili-API-collect 文档 + 实测（2026-08）：
 *  - seg.so 顶层：field 1 = repeated DanmakuElem（普通弹幕）；field 4/5 = 指令弹幕（原样保留）
 *  - DanmakuElem：1 id 2 progress 3 mode 4 fontsize 5 color 6 midHash 7 content 8 ctime
 *    9 weight 10 action 11 pool 12 idStr 13 attr
 */

import type { SiteDanmakuAdapter } from './types.ts';

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

// ===== 屏上替换（渐进增强）=====

interface DanmakuRecord {
  content?: string;
  progress?: number;
  id?: number | string;
  idStr?: string;
  [key: string]: unknown;
}

let liveList: DanmakuRecord[] | null = null;
let probing = false;

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
  if (!liveList || replacements.size === 0) return false;
  let changed = false;
  for (const item of liveList) {
    const id = String(item.idStr ?? item.id ?? '');
    const replacement = replacements.get(id);
    if (replacement !== undefined && item.content !== replacement) {
      item.content = replacement;
      changed = true;
    }
  }
  return changed;
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
      return parseXmlDanmaku(new TextDecoder().decode(data));
    }
    return extractSegElems(data).map((e) => ({ id: e.idStr, text: e.content }));
  },
  rebuildResponse(buf, replacements) {
    if (isXmlResponse(buf)) {
      const rebuilt = replaceXmlContent(new TextDecoder().decode(buf), replacements);
      return rebuilt !== null ? new TextEncoder().encode(rebuilt) : null;
    }
    return replaceSegContent(buf, replacements);
  },
  applyLiveRewrites,
  startLiveProbe: startProbe,
};
