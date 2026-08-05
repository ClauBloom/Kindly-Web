/**
 * 站点注册表：接入新平台的唯二改动点之一（另一个是新增薄壳 entrypoint）。
 *
 * 接入新平台（如抖音）流程：
 *  1. 新建 lib/sites/douyin.ts 实现 SiteAdapter（评论 URL/提取/DOM 选择器；弹幕可选）
 *  2. 在 SITE_ADAPTERS 注册一行
 *  3. 新增 entrypoints/douyin.content.ts（薄壳，matches 字面量声明域名）
 *  4. onboarding/options 的站点列表自动出现（由本注册表驱动）
 *  SW、通用引擎、UI 零改动。
 */

import type { SiteAdapter } from './types.ts';
import { bilibiliAdapter } from './bilibili.ts';
import { bilibiliDanmakuAdapter } from './bilibili-danmaku.ts';

bilibiliAdapter.danmaku = bilibiliDanmakuAdapter;

export const SITE_ADAPTERS: Record<string, SiteAdapter> = {
  bilibili: bilibiliAdapter,
  // douyin: douyinAdapter, // 未来接入
};

export function getAdapter(key: string): SiteAdapter | null {
  return SITE_ADAPTERS[key] ?? null;
}

/** 所有已注册站点（驱动 UI 站点列表与 enabledSites 校验） */
export function allAdapters(): SiteAdapter[] {
  return Object.values(SITE_ADAPTERS);
}
