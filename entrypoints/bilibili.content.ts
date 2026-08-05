/**
 * B 站内容脚本（isolated world）——薄壳。
 * 站点逻辑在 lib/sites/bilibili.ts（adapter），通用引擎在 lib/rewrite-ui.ts。
 * matches 必须是字面量（WXT 构建期静态分析）。
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { startRewriteUi } from '@/lib/rewrite-ui';
import { getAdapter } from '@/lib/sites/registry';

export default defineContentScript({
  matches: [
    'https://www.bilibili.com/*',
    'https://t.bilibili.com/*',
    ...(import.meta.env.DEV ? ['http://localhost:8787/*'] : []),
  ],
  runAt: 'document_idle',
  main() {
    const adapter = getAdapter('bilibili');
    if (adapter) startRewriteUi(adapter);
  },
});
