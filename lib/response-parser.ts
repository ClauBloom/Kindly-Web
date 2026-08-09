/**
 * LLM 响应解析器（纯函数，无浏览器依赖，可独立测试）。
 *
 * 设计借鉴 kiss-translator 的 aiResponseParser 模式（宽容截取 JSON 区间、
 * 多输出形态兼容、字段别名、逐级降级），实现为自有代码：
 *   1. 宽容 JSON：从响应中截取首个 {/[ 到最后一个 }/] 再解析，
 *      容忍模型在 JSON 前后混入说明文字或 Markdown 残留；
 *   2. 多形态：id→text 映射对象 / [{id, text}] 数组 / {rewrites:[...]} 包装对象；
 *   3. 字段别名：text / rewritten / translation / content；
 *   4. 降级链：JSON → 行协议（每行 "id: text"）→ 单条纯文本（仅单条目批次）；
 *   5. 缺失条目以原文兜底（视为"无意义改写"），绝不抛错。
 */

export interface ParseItem {
  id: string;
  original: string;
}

const ID_RE = /^[0-9a-fA-F-]{8,40}$/;

/** 截取首个 [/{ 到最后一个 }/] 之间的内容；无配对区间返回 null */
function extractJsonRange(raw: string): string | null {
  const start = raw.search(/[[{]/);
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/** 规范化单条条目：兼容 {id, text|rewritten|translation|content} 字段名 */
function normalizeEntry(value: unknown): { id: string; text: string } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const rawId = v.id;
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : null;
  if (!id || !ID_RE.test(id)) return null;
  const text = [v.text, v.rewritten, v.translation, v.content].find(
    (x): x is string => typeof x === 'string' && x.trim() !== '',
  );
  if (text === undefined) return null;
  return { id, text: text.trim() };
}

/** 解析 id→text 映射形态：{"<id>": "text", ...} */
function parseMapping(raw: string): Map<string, string> | null {
  const range = extractJsonRange(raw);
  if (!range) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(range);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const map = new Map<string, string>();
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() !== '' && ID_RE.test(id)) map.set(id, value.trim());
  }
  return map.size > 0 ? map : null;
}

/** 解析数组/包装形态：[{id, text}] / {rewrites|results|translations: [...]} */
function parseList(raw: string): Map<string, string> | null {
  const range = extractJsonRange(raw);
  if (!range) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(range);
  } catch {
    return null;
  }
  let list: unknown = null;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const v = parsed as Record<string, unknown>;
    list = [v.rewrites, v.results, v.translations, v.items].find((x) => Array.isArray(x)) ?? null;
  }
  if (!Array.isArray(list)) return null;
  const map = new Map<string, string>();
  for (const entry of list) {
    const normalized = normalizeEntry(entry);
    if (normalized) map.set(normalized.id, normalized.text);
  }
  return map.size > 0 ? map : null;
}

/** 行协议降级：每行 "<id>: text"（id 为 8-40 位字母数字连字符） */
function parseLineProtocol(raw: string, items: ParseItem[]): Map<string, string> | null {
  const map = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([0-9a-fA-F-]{8,40})\s*[:：]\s*(.+?)\s*$/);
    if (!match) continue;
    const [, id, text] = match;
    if (id && text && items.some((it) => it.id === id)) map.set(id, text.trim());
  }
  return map.size > 0 ? map : null;
}

/**
 * 解析模型输出 → Map<id, rewritten>。
 * 返回 null 表示完全无法解析（调用方按 'parse' 错误处理）；
 * 部分缺失的条目以原文兜底，保证"任何失败都保底显示原文"。
 */
export function parseRewrites(raw: string, items: ParseItem[]): Map<string, string> | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  if (cleaned === '') return null;

  const map = parseMapping(cleaned) ?? parseList(cleaned) ?? parseLineProtocol(cleaned, items);
  if (map) {
    for (const item of items) if (!map.has(item.id)) map.set(item.id, item.original);
    return map;
  }
  // 部分模型把 "id" 键写进每个条目（{"id":"<弹幕id>":"text"}，JSON 语法非法）：
  // 去掉 "id": 前缀后重新解析（仅在首轮失败时尝试，避免误伤正常文本）
  if (/"id"\s*:\s*"/.test(cleaned)) {
    const fixed = cleaned.replace(/"id"\s*:\s*(?=")/g, '');
    const map2 = parseMapping(fixed) ?? parseList(fixed) ?? parseLineProtocol(fixed, items);
    if (map2) {
      for (const item of items) if (!map2.has(item.id)) map2.set(item.id, item.original);
      return map2;
    }
  }
  // 单条批次：模型可能直接返回纯文本。仅当内容确实像一段文本时兜底，
  // 避免坏 JSON（以 {/[ 开头但解析失败）或纯符号垃圾被当成改写结果。
  if (items.length === 1 && items[0] && looksLikeText(cleaned)) {
    return new Map([[items[0].id, cleaned]]);
  }
  return null;
}

/** 宽松的"像文本"判定：不以 JSON 结构开头，且含至少一个字母/数字/汉字 */
function looksLikeText(text: string): boolean {
  if (/^[[{]/.test(text)) return false;
  return /[\p{L}\p{N}]/u.test(text);
}
