/**
 * 用户配置读写 + Provider 预置表。
 * 存储拆分（见 docs/ARCHITECTURE.md §2.5）：
 *  - apiKey            → chrome.storage.local（敏感凭据，不跨设备扩散）
 *  - KindlyConfig      → chrome.storage.sync（非敏感偏好）
 */

import { browser } from 'wxt/browser';

export type Intensity = 'mild' | 'moderate' | 'strong';
export type UIMode = 'replace' | 'bubble';

export interface KindlyConfig {
  /** 配置结构版本（读时迁移，见 MIGRATIONS） */
  version: number;
  /** OpenAI 兼容接口地址，如 https://api.openai.com/v1 */
  baseURL: string;
  modelName: string;
  intensity: Intensity;
  /** 总开关 */
  enabled: boolean;
  /** UI 模式：原地替换 / 仅浮层对比 */
  mode: UIMode;
  /** 单次 API 请求携带的评论条数 */
  batchSize: number;
  /** 单请求超时（ms） */
  timeoutMs: number;
  /** 是否把评论者昵称发给 LLM（隐私选项） */
  includeAuthor: boolean;
  /** 启用站点，CS 启动时过滤 */
  enabledSites: string[];
  /** 初次引导完成标记（未完成 → popup 显示引导 CTA） */
  onboardingDone: boolean;
}

export const CURRENT_CONFIG_VERSION = 1;

export const DEFAULT_CONFIG: KindlyConfig = {
  version: CURRENT_CONFIG_VERSION,
  baseURL: 'https://api.openai.com/v1',
  modelName: 'gpt-4o-mini',
  intensity: 'mild',
  enabled: true,
  mode: 'replace',
  batchSize: 5,
  timeoutMs: 30_000,
  includeAuthor: false,
  enabledSites: ['bilibili'],
  onboardingDone: false,
};

/**
 * 配置迁移链（借鉴 kiss-translator runDataMigration 的思路，结构就位）。
 * v1 起步：未来新增迁移时在此追加 `CURRENT_CONFIG_VERSION: (cfg) => ({...cfg, newField: default})`。
 */
const MIGRATIONS: Record<number, (cfg: KindlyConfig) => KindlyConfig> = {};

export interface ProviderPreset {
  id: string;
  label: string;
  /** 预置描述，用于引导页卡片 */
  hint: string;
  baseURL: string;
  defaultModel: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'GPT 系列',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: '国产 · 性价比高',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    hint: '国产 · 中文友好',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼',
    hint: '国产 · 通义系列',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
  {
    id: 'custom',
    label: '自定义',
    hint: '任何 OpenAI 兼容接口',
    baseURL: '',
    defaultModel: '',
  },
];

// 站点注册表（lib/sites/registry.ts）为唯一来源：SITE_KEYS/SITE_LABELS 已移除，
// UI 与校验一律使用 allAdapters() / getAdapter()。

const SYNC_KEY = 'config';
const LOCAL_KEY = 'apiKey';

export async function getConfig(): Promise<KindlyConfig> {
  const stored = await browser.storage.sync.get(SYNC_KEY);
  const raw = stored[SYNC_KEY] as Partial<KindlyConfig> | undefined;
  // 默认值合并兜底 + 版本链迁移：旧数据缺字段/低版本不会崩
  let cfg = { ...DEFAULT_CONFIG, ...raw } as KindlyConfig;
  const fromVersion = raw?.version ?? 0;
  for (let v = fromVersion; v < CURRENT_CONFIG_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (migrate) cfg = migrate(cfg);
  }
  cfg.version = CURRENT_CONFIG_VERSION;
  return cfg;
}

export async function saveConfig(patch: Partial<KindlyConfig>): Promise<KindlyConfig> {
  const next = { ...(await getConfig()), ...patch };
  await browser.storage.sync.set({ [SYNC_KEY]: next });
  return next;
}

export async function getApiKey(): Promise<string> {
  const stored = await browser.storage.local.get(LOCAL_KEY);
  return (stored[LOCAL_KEY] as string | undefined) ?? '';
}

/**
 * 多 Key 支持（借鉴 kiss-translator keyPick / openai-translator 多 key 轮换）：
 * apiKey 字段可用逗号/分号/换行分隔多个 Key，SW 按请求轮询使用。
 */
export async function getApiKeys(): Promise<string[]> {
  const raw = await getApiKey();
  return raw
    .split(/[\n,;]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export async function setApiKey(key: string): Promise<void> {
  await browser.storage.local.set({ [LOCAL_KEY]: key });
}

/** 从 baseURL 推导需要授权的 origin（用于 optional_host_permissions 申请） */
export function originOf(baseURL: string): string | null {
  try {
    return new URL(baseURL).origin;
  } catch {
    return null;
  }
}

/** 判断 baseURL 的 origin 是否已具备网络权限（静态声明或已授权） */
export async function hasOriginAccess(baseURL: string): Promise<boolean> {
  const origin = originOf(baseURL);
  if (!origin) return false;
  const pattern = `${origin}/*`;
  const has = await browser.permissions.contains({ origins: [pattern] });
  if (has) return true;
  // optional_host_permissions 已授予时同样放行
  return browser.permissions.contains({ origins: ['https://*/*'] });
}

/** 申请自定义 baseURL 的网络权限（必须在用户手势内调用） */
export async function requestOriginAccess(baseURL: string): Promise<boolean> {
  const origin = originOf(baseURL);
  if (!origin) return false;
  return browser.permissions.request({ origins: [`${origin}/*`] });
}
