/**
 * 用户配置读写 + Provider 预置表。
 * 存储拆分：
 *  - apiKey            → chrome.storage.local（敏感凭据，不跨设备扩散）
 *  - KindlyConfig      → chrome.storage.sync（非敏感偏好）
 */

import { browser } from 'wxt/browser';

export type Intensity = 'mild' | 'moderate' | 'strong';
export type UIMode = 'replace' | 'bubble';

/** 内置风格预设（下拉框选项；prompt 为空串 = 不注入额外指令） */
export interface StylePreset {
  id: string;
  label: string;
  /** 追加到 system prompt 的风格指令（"默认"预设为空串） */
  prompt: string;
}

/** 用户自定义风格（配置页可增删） */
export interface CustomStyle {
  id: string;
  name: string;
  prompt: string;
}

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
  /**
   * 弹幕处理上限：视频弹幕总量（stat.danmaku）大于此值时跳过弹幕改写
   * （弹幕量极大的视频通常引战少，全量送 LLM 不划算）。null = 无上限。
   */
  danmakuMaxTotal: number | null;
  /** 改写前隐藏原文（评论）：加载即显示"重写中"占位，改写完成后替换 */
  hideOriginalComment: boolean;
  /** 改写前隐藏原文（弹幕）：同评论，弹幕显示"重写中"占位 */
  hideOriginalDanmaku: boolean;
  /** 弹幕处理速度预设（fast/balanced/standard/slow；手动调并发或批大小后为 custom） */
  dmPreset: 'fast' | 'balanced' | 'standard' | 'slow' | 'custom';
  /** 弹幕请求并发量（SW 全局并发 + 段内批并发共用；1–128） */
  dmConcurrency: number;
  /** 弹幕每批条数（小批响应快、请求多；1–100） */
  dmBatchSize: number;
  /** 输出风格：内置预置 id 或自定义风格 id（见 STYLE_PRESETS/customStyles） */
  styleId: string;
  /** 用户自定义风格列表（配置页增删） */
  customStyles: CustomStyle[];
  /** 瞬时失败（网络/解析）重试次数（0–5；0 = 不重试直接判失败） */
  retryCount: number;
  /** 网络失败重试基础间隔（秒；退避 = 间隔 × 2^(重试次数-1)，0 = 立即重试） */
  retryIntervalSec: number;
}

/** 弹幕处理速度预设（快速 → 慢速）：高并发+小批 到 低并发+大批 */
export const DM_SPEED_PRESETS: Record<
  'fast' | 'balanced' | 'standard' | 'slow',
  { label: string; concurrency: number; batchSize: number }
> = {
  fast: { label: '快速', concurrency: 64, batchSize: 10 },
  balanced: { label: '较快', concurrency: 32, batchSize: 20 },
  standard: { label: '标准', concurrency: 16, batchSize: 40 },
  slow: { label: '慢速', concurrency: 8, batchSize: 60 },
};

export type DmSpeedPreset = keyof typeof DM_SPEED_PRESETS | 'custom';

/**
 * 输出风格预设（配置页下拉框）。prompt 为追加到 system prompt 的
 * "输出风格"指令；空串 = 不注入（默认仅改写，行为与旧版一致）。
 * 文案依据各年代网络文化语料编写（详见调研：年度弹幕/流行语等）。
 */
export const STYLE_PRESETS: StylePreset[] = [
  { id: 'default', label: '默认（仅改写）', prompt: '' },
  {
    id: 'bilibili-2010',
    label: '2010年的B站',
    prompt:
      '模拟2010年前后B站早期弹幕氛围：中二、热血、宅气十足。善用早期弹幕文化元素——"2333/233"（大笑）、"wwww"、"=w="（颜文字）、"前方高能/高能预警"（提醒剧情转折）、空耳式谐音梗（如"阿姨洗铁路"=我爱你）、"中二病""节操"等当年圈内用语；可提及初音未来、东方Project、御坂美琴等当时热门角色梗。句子简短密集、弹幕感强、适当夸张。仍须友善、理性，不攻击他人，不改变事实信息。',
  },
  {
    id: 'bilibili-2016',
    label: '2016年的B站',
    prompt:
      '模拟2016年B站弹幕氛围：活泼调侃、爱玩梗。善用当年流行语——"666/6666"（夸赞）、"厉害了""可以的"、"老司机/飙车"（老道、带节奏）、"洪荒之力"（全力以赴）、"蓝瘦香菇"（难受想哭）、"一脸懵逼"（懵圈）；弹幕短句、节奏明快。仍须友善、理性，不攻击他人，不改变事实信息。',
  },
  {
    id: 'bilibili-2019',
    label: '2019年的B站',
    prompt:
      '模拟2019年B站弹幕氛围：玩梗圆熟、表达多样。善用当年热梗——"awsl"（被可爱到/见到大佬）、"妙啊"（赞叹或调侃）、"禁止套娃"（反对复读嵌套）、"泪目"（感动）、"我酸了/柠檬精"（羡慕）、"好嗨哟"（兴奋）；可玩梗但不过度滥用，弹幕短句。仍须友善、理性，不攻击他人，不改变事实信息。',
  },
  {
    id: 'douyin-2019',
    label: '2019年的抖音',
    prompt:
      '模拟2019年抖音短视频口吻：亲切热情、情绪外放。善用当年热词——"老铁/家人们"（称呼）、"奥利给"（加油打气）、"双击666"（夸赞）、"我太难了"（自嘲式诉苦）、"盘他"（逗弄/较劲）、"好嗨哟"（嗨起来）、"土味情话"式表达；句子短促有力、口语化、带节奏感。仍须友善、理性，不攻击他人，不改变事实信息。',
  },
  {
    id: 'catgirl',
    label: '猫娘',
    prompt:
      '模拟猫娘（猫耳萌娘）说话方式：句尾带"喵/喵呜/nya~"口癖，自称"本喵"，善用颜文字（如 >ω<、=^ω^=、ฅ(•ㅅ•)ฅ）；语气软萌、爱撒娇，把攻击或抱怨转化为撒娇式的小抱怨（如"哼，本喵才不理你喵～"）；句子简短可爱。仍须友善、理性，不攻击他人，不改变事实信息。',
  },
];

export const CURRENT_CONFIG_VERSION = 3;

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
  danmakuMaxTotal: 10_000,
  hideOriginalComment: false,
  hideOriginalDanmaku: false,
  dmPreset: 'standard',
  dmConcurrency: 16,
  dmBatchSize: 40,
  styleId: 'default',
  customStyles: [],
  retryCount: 2,
  retryIntervalSec: 1,
};

/**
 * 配置迁移链（借鉴 kiss-translator runDataMigration 的思路，结构就位）。
 * v1→v2：新增输出风格字段（内置默认 + 空自定义列表）。
 * v2→v3：新增失败重试设置（次数 + 基础间隔，沿用既有默认行为 2 次 / 1s）。
 */
const MIGRATIONS: Record<number, (cfg: KindlyConfig) => KindlyConfig> = {
  1: (cfg) => ({ ...cfg, styleId: 'default', customStyles: [] }),
  2: (cfg) => ({ ...cfg, retryCount: 2, retryIntervalSec: 1 }),
};

export interface ProviderPreset {
  id: string;
  label: string;
  /** 预置描述，用于引导页卡片 */
  hint: string;
  baseURL: string;
  defaultModel: string;
}

/** 弹幕处理上限下拉选项（null = 无上限；popup 与 options 共用） */
export const DANMAKU_MAX_OPTIONS: { value: number | null; label: string }[] = [
  { value: 100, label: '100' },
  { value: 500, label: '500' },
  { value: 1000, label: '1000' },
  { value: 2000, label: '2000' },
  { value: 5000, label: '5000' },
  { value: 10000, label: '1万' },
  { value: 20000, label: '2万' },
  { value: 50000, label: '5万' },
  { value: 100000, label: '10万' },
  { value: null, label: '无上限' },
];

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
    defaultModel: 'deepseek-v4-flash',
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
  // 旧配置中的 deepseek-chat 已不可用，修正为官方当前模型
  if (cfg.modelName === 'deepseek-chat') cfg.modelName = 'deepseek-v4-flash';
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
