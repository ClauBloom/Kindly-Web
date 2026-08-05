/**
 * B 站 API 劫持层（main world）——薄壳。
 * 站点逻辑在 lib/sites/bilibili.ts + lib/sites/bilibili-danmaku.ts（adapter），
 * 通用引擎在 lib/hijack-engine.ts。matches 必须是字面量（WXT 构建期静态分析）。
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { startHijack } from '@/lib/hijack-engine';
import { getAdapter } from '@/lib/sites/registry';

export default defineContentScript({
  matches: [
    'https://www.bilibili.com/*',
    'https://t.bilibili.com/*',
    'https://player.bilibili.com/*',
    ...(import.meta.env.DEV ? ['http://localhost:8787/*'] : []),
  ],
  world: 'MAIN',
  runAt: 'document_start', // 必须在页面业务脚本之前完成包装
  main() {
    const adapter = getAdapter('bilibili');
    if (adapter) startHijack(adapter);
  },
});
