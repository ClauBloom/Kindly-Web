import { defineConfig } from 'wxt';

const BASE_HOST_PERMISSIONS = [
  'https://api.openai.com/*',
  'https://api.deepseek.com/*',
  'https://api.zhipuai.com/*',
  'https://dashscope.aliyuncs.com/*',
];

export default defineConfig({
  // MV3 扩展页对 modulepreload 有限制（cross-world extension resource mismatch 警告），
  // 关闭 Vite 的 preload 生成，避免控制台噪音（页面脚本仍正常加载）
  vite: () => ({
    build: { modulePreload: false },
  }),
  manifest: (env) => ({
    name: 'Kindly Web',
    description: '将网络评论中的攻击性表达重写为友善表达。评论原文仅发送至你自行配置的 LLM API。',
    permissions: ['storage'],
    // 已知提供商静态声明；用户自定义 baseURL 走 optional_host_permissions 运行时授权
    host_permissions: [...BASE_HOST_PERMISSIONS, ...(env.mode === 'development' ? ['http://localhost:8788/*'] : [])],
    optional_host_permissions: ['https://*/*'],
    action: { default_popup: 'popup.html' },
    options_page: 'options.html',
  }),
});
