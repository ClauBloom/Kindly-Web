/**
 * 错误分类。
 * SW 统一把各类失败归类为 RewriteReason，CS 据此降级展示；
 * popup 用同一张表渲染人类可读文案。
 */

import type { RewriteReason } from './messages';

export interface ClassifiedError {
  reason: RewriteReason;
}

/** HTTP 状态码 → 错误分类 */
export function classifyHttpStatus(status: number): RewriteReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'network';
  return 'parse';
}

/** fetch 异常 → 错误分类（AbortError 为超时） */
export function classifyFetchError(err: unknown): RewriteReason {
  if (err instanceof DOMException && err.name === 'AbortError') return 'timeout';
  return 'network';
}

/** 响应体解析失败（结构不符） */
export function classifyParseError(): RewriteReason {
  return 'parse';
}

/**
 * 从非 2xx 响应中提取服务商原始错误信息（借鉴 openai-translator 的多层提取：
 * error.message → message → 截断 JSON），供 UI 展示与开发者日志定位，绝不包含 Key。
 * 返回格式：`HTTP <status>: <body>`（status 可空 → 仅 body）。
 */
export async function extractErrorDetail(res: Response): Promise<string | undefined> {
  const prefix = `HTTP ${res.status}: `;
  try {
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object') return undefined;
    const v = data as Record<string, unknown>;
    const msg = v.error && typeof v.error === 'object' ? (v.error as Record<string, unknown>).message : v.message;
    if (typeof msg === 'string' && msg.trim() !== '') return prefix + msg.trim().slice(0, 2000);
    return prefix + JSON.stringify(data).slice(0, 2000);
  } catch {
    return undefined;
  }
}

export const REASON_LABELS: Record<RewriteReason, string> = {
  auth: 'API Key 无效或未配置',
  rate_limited: '请求过于频繁（限流）',
  timeout: '请求超时',
  network: '网络错误，无法连接 API',
  parse: 'API 返回格式异常',
  empty: '返回内容为空',
};

export function reasonLabel(reason: RewriteReason): string {
  return REASON_LABELS[reason] ?? reason;
}
