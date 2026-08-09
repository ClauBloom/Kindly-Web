/**
 * 改写缓存：sha256(原文) → 改写结果。
 * 存于 storage.local（配额 10MB），内存中维护 LRU 顺序，上限 2000 条防爆配额。
 * 仅 SW 读写（CS 无网络请求，不需要缓存）。
 */

import { browser } from 'wxt/browser';

const CACHE_KEY = 'kwCache';
export const CACHE_MAX = 2000;

type CacheShape = Record<string, string>;

async function readCache(): Promise<CacheShape> {
  const stored = await browser.storage.local.get(CACHE_KEY);
  return (stored[CACHE_KEY] as CacheShape | undefined) ?? {};
}

export async function cacheGet(original: string, sig: string): Promise<string | null> {
  const hash = await sha256(`${original}\n${sig}`);
  const cache = await readCache();
  return cache[hash] ?? null;
}

export async function cacheSet(original: string, sig: string, rewritten: string): Promise<void> {
  const hash = await sha256(`${original}\n${sig}`);
  const cache = await readCache();
  cache[hash] = rewritten;
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    for (const key of keys.slice(0, keys.length - CACHE_MAX)) delete cache[key];
  }
  await browser.storage.local.set({ [CACHE_KEY]: cache });
}

export async function cacheSize(): Promise<number> {
  return Object.keys(await readCache()).length;
}

export async function cacheClear(): Promise<void> {
  await browser.storage.local.remove(CACHE_KEY);
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 缓存签名：改写结果受内容类型（评论/弹幕 prompt 不同）、服务商、模型、
 * 强度、昵称开关影响，任一变化 → 签名变化 → 缓存自动失效
 * （借鉴 kiss-translator 的 promptSig 思路）。
 */
export function cacheSigOf(
  baseURL: string,
  modelName: string,
  intensity: string,
  includeAuthor: boolean,
  kind: 'comment' | 'danmaku' = 'comment',
): string {
  return `${baseURL}|${modelName}|${intensity}|${includeAuthor ? 1 : 0}|${kind}`;
}
