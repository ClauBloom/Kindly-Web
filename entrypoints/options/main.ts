/**
 * 配置页：API 设置 / 重写偏好 / 站点管理 / 数据与隐私。
 * 保存 → storage 写入 + 通知 SW（KW_CONFIG_CHANGED），SW 再广播给各标签页。
 */

import { browser } from 'wxt/browser';
import { cacheClear, cacheSize } from '@/lib/cache';
import {
  DANMAKU_MAX_OPTIONS,
  DM_SPEED_PRESETS,
  getApiKey,
  getConfig,
  hasOriginAccess,
  PROVIDER_PRESETS,
  requestOriginAccess,
  saveConfig,
  setApiKey,
  STYLE_PRESETS,
} from '@/lib/config';
import type { CustomStyle, Intensity, KindlyConfig, UIMode } from '@/lib/config';
import { t } from '@/lib/i18n';
import { allAdapters } from '@/lib/sites/registry';
import type { TestResult } from '@/lib/messages';

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

let config: KindlyConfig;
let savedKey = '';
/** 自定义风格工作副本：增删后仅更新内存，保存时写回配置 */
let customStyles: CustomStyle[] = [];

async function main(): Promise<void> {
  config = await getConfig();
  savedKey = await getApiKey();

  // 文案
  document.querySelector('.subtitle')!.textContent = t('brand.privacy');
  $('btn-save').textContent = t('btn.save');
  $('sec-api').textContent = t('opt.api.title');
  $('sec-rewrite').textContent = t('opt.rewrite.title');
  $('sec-sites').textContent = t('opt.sites.title');
  $('sec-data').textContent = t('opt.data.title');
  (document.querySelector('label[for="provider"]') as HTMLElement).textContent = t('opt.api.provider');
  (document.querySelector('label[for="baseURL"]') as HTMLElement).textContent = t('opt.api.baseURL');
  (document.querySelector('label[for="modelName"]') as HTMLElement).textContent = t('opt.api.model');
  (document.querySelector('label[for="apiKey"]') as HTMLElement).textContent = t('opt.api.key');
  $('intensity-label').textContent = t('popup.intensity');
  $('mode-label').textContent = t('onb.step4.mode');
  $('stylePreset-label').textContent = t('opt.rewrite.stylePreset');
  $('customStyles-label').textContent = t('opt.rewrite.customStyles');
  $('btn-add-custom-style').textContent = t('opt.rewrite.customStyle.add');
  (document.querySelector('label[for="batchSize"]') as HTMLElement).textContent = t('opt.rewrite.batchSize');
  (document.querySelector('label[for="timeoutMs"]') as HTMLElement).textContent = t('opt.rewrite.timeout');
  (document.querySelector('label[for="retryCount"]') as HTMLElement).textContent = t('opt.rewrite.retryCount');
  (document.querySelector('label[for="retryIntervalSec"]') as HTMLElement).textContent = t('opt.rewrite.retryIntervalSec');
  (document.querySelector('label[for="danmakuMaxTotal"]') as HTMLElement).textContent = t('opt.rewrite.danmakuMaxTotal');
  (document.querySelector('label[for="dmConcurrency"]') as HTMLElement).textContent = t('opt.rewrite.dmConcurrency');
  (document.querySelector('label[for="dmBatchSize"]') as HTMLElement).textContent = t('opt.rewrite.dmBatchSize');
  $('dmSpeed-label').textContent = t('opt.rewrite.dmSpeed');
  $('includeAuthor-label').textContent = t('opt.rewrite.includeAuthor');
  $('hideOriginalComment-label').textContent = t('opt.rewrite.hideOriginalComment');
  $('hideOriginalDanmaku-label').textContent = t('opt.rewrite.hideOriginalDanmaku');
  $('emojiToKaomoji-label').textContent = t('opt.rewrite.emojiToKaomoji');
  $('enableThinking-label').textContent = `${t('opt.rewrite.thinking')} — ${t('opt.rewrite.thinking.warn')}`;
  $('btn-test').textContent = t('btn.test');
  $('btn-clear-cache').textContent = t('opt.data.clearCache');
  $('btn-review-onboarding').textContent = t('opt.data.reviewOnboarding');
  $('privacy-note').textContent = t('opt.data.privacy');
  $('threat-note').textContent = t('opt.data.threat');

  // 表单填充
  buildProviderSelect();
  buildSegmented('intensity', ['mild', 'moderate', 'strong'], config.intensity, (v) => {
    config.intensity = v as Intensity;
  });
  buildSegmented('mode', ['replace', 'bubble'], config.mode, (v) => {
    config.mode = v as UIMode;
  });
  const baseURLInput = $('baseURL') as HTMLInputElement;
  baseURLInput.value = config.baseURL;
  ($('modelName') as HTMLInputElement).value = config.modelName;
  ($('apiKey') as HTMLInputElement).value = savedKey;
  ($('batchSize') as HTMLInputElement).value = String(config.batchSize);
  ($('timeoutMs') as HTMLInputElement).value = String(Math.round(config.timeoutMs / 1000));
  ($('retryCount') as HTMLInputElement).value = String(config.retryCount);
  ($('retryIntervalSec') as HTMLInputElement).value = String(config.retryIntervalSec);
  ($('includeAuthor') as HTMLInputElement).checked = config.includeAuthor;
  ($('hideOriginalComment') as HTMLInputElement).checked = config.hideOriginalComment;
  ($('hideOriginalDanmaku') as HTMLInputElement).checked = config.hideOriginalDanmaku;
  ($('emojiToKaomoji') as HTMLInputElement).checked = config.emojiToKaomoji;
  ($('enableThinking') as HTMLInputElement).checked = config.enableThinking;
  buildDmSpeedControls(config);
  buildDanmakuMaxTotalSelect(config.danmakuMaxTotal);
  customStyles = [...config.customStyles];
  buildStyleSelect();
  buildCustomStyleList();
  buildSiteList();
  updateKeyHint();

  void refreshCacheInfo();

  // 事件
  ($('provider') as HTMLSelectElement).addEventListener('change', onProviderChange);
  baseURLInput.addEventListener('input', updateKeyHint);
  ($('key-eye') as HTMLButtonElement).addEventListener('click', () => {
    const input = $('apiKey') as HTMLInputElement;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('key-eye').textContent = show ? '隐藏' : '显示';
  });
  $('btn-test').addEventListener('click', () => void runTest());
  $('btn-save').addEventListener('click', () => void save());
  $('btn-add-custom-style').addEventListener('click', addCustomStyle);
  $('btn-clear-cache').addEventListener('click', () => void clearCache());
  $('btn-review-onboarding').addEventListener('click', () => {
    void browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
  });
}

function buildProviderSelect(): void {
  const select = $('provider') as HTMLSelectElement;
  for (const preset of PROVIDER_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    select.appendChild(opt);
  }
  const preset = PROVIDER_PRESETS.find((p) => p.baseURL === config.baseURL);
  select.value = preset?.id ?? 'custom';
}

/**
 * 弹幕处理速度：四档预设（快速→慢速）+ 手动并发/批大小。
 * 选择预设 → 填充两个输入；手动改任一输入 → 档位变"自定义"。
 */
function buildDmSpeedControls(current: KindlyConfig): void {
  const presets = DM_SPEED_PRESETS;
  const box = $('dm-speed');
  box.innerHTML = '';
  const presetKeys = Object.keys(presets) as (keyof typeof presets)[];
  for (const key of presetKeys) {
    const p = presets[key];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn' + (current.dmPreset === key ? ' active' : '');
    btn.textContent = p.label;
    btn.title = `${t('opt.rewrite.dmSpeedHint')}：并发 ${p.concurrency} · 每批 ${p.batchSize} 条`;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(current.dmPreset === key));
    btn.addEventListener('click', () => {
      ($('dmConcurrency') as HTMLInputElement).value = String(p.concurrency);
      ($('dmBatchSize') as HTMLInputElement).value = String(p.batchSize);
      markDmPresetActive(key);
    });
    box.appendChild(btn);
  }
  ($('dmConcurrency') as HTMLInputElement).value = String(current.dmConcurrency);
  ($('dmBatchSize') as HTMLInputElement).value = String(current.dmBatchSize);
  const conInput = $('dmConcurrency') as HTMLInputElement;
  const batchInput = $('dmBatchSize') as HTMLInputElement;
  const markCustom = () => markDmPresetActive(null);
  conInput.addEventListener('input', markCustom);
  batchInput.addEventListener('input', markCustom);
}

function markDmPresetActive(key: keyof typeof DM_SPEED_PRESETS | null): void {
  for (const btn of $('dm-speed').querySelectorAll('.seg-btn')) {
    btn.classList.toggle('active', key !== null && btn.textContent === DM_SPEED_PRESETS[key].label);
  }
}

/** 弹幕处理上限下拉（null = 无上限）——选项定义共享自 lib/config.ts */
function buildDanmakuMaxTotalSelect(current: number | null): void {
  const select = $('danmakuMaxTotal') as HTMLSelectElement;
  for (const opt of DANMAKU_MAX_OPTIONS) {
    const el = document.createElement('option');
    el.value = opt.value === null ? '' : String(opt.value);
    el.textContent = opt.label;
    select.appendChild(el);
  }
  select.value = current === null ? '' : String(current);
}

/**
 * 输出风格下拉：内置预置 + 用户自定义（"自定义·名称"）。
 * 配置中的 styleId 已失效（如对应自定义风格被删）时回退默认。
 */
function buildStyleSelect(): void {
  const select = $('stylePreset') as HTMLSelectElement;
  select.innerHTML = '';
  for (const preset of STYLE_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    select.appendChild(opt);
  }
  for (const custom of customStyles) {
    const opt = document.createElement('option');
    opt.value = custom.id;
    opt.textContent = `自定义 · ${custom.name}`;
    select.appendChild(opt);
  }
  const known = STYLE_PRESETS.some((p) => p.id === config.styleId) ||
    customStyles.some((c) => c.id === config.styleId);
  if (!known) config.styleId = 'default';
  select.value = config.styleId;
}

/** 自定义风格列表：每行名称 + 指令预览 + 删除按钮 */
function buildCustomStyleList(): void {
  const box = $('custom-style-list');
  box.innerHTML = '';
  for (const custom of customStyles) {
    const row = document.createElement('div');
    row.className = 'custom-style-row';
    const info = document.createElement('div');
    info.className = 'custom-style-info';
    const name = document.createElement('span');
    name.className = 'custom-style-name';
    name.textContent = custom.name;
    const prompt = document.createElement('span');
    prompt.className = 'custom-style-prompt';
    prompt.textContent = custom.prompt;
    info.append(name, prompt);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-link custom-style-del';
    del.textContent = t('opt.rewrite.customStyle.delete');
    del.addEventListener('click', () => {
      deleteCustomStyle(custom.id);
    });
    row.append(info, del);
    box.appendChild(row);
  }
  if (customStyles.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint custom-style-empty';
    empty.textContent = t('opt.rewrite.customStyle.empty');
    box.appendChild(empty);
  }
}

function addCustomStyle(): void {
  const name = ($('customStyleName') as HTMLInputElement).value.trim();
  const prompt = ($('customStylePrompt') as HTMLTextAreaElement).value.trim();
  if (!name) return toast(t('opt.rewrite.customStyle.needName'));
  if (!prompt) return toast(t('opt.rewrite.customStyle.needPrompt'));
  if (name.length > 20) return toast(t('opt.rewrite.customStyle.nameTooLong'));
  if (prompt.length > 500) return toast(t('opt.rewrite.customStyle.promptTooLong'));
  const id = `custom-${Date.now()}`;
  customStyles.push({ id, name, prompt });
  config.styleId = id;
  ($('customStyleName') as HTMLInputElement).value = '';
  ($('customStylePrompt') as HTMLTextAreaElement).value = '';
  buildStyleSelect();
  buildCustomStyleList();
}

function deleteCustomStyle(id: string): void {
  customStyles = customStyles.filter((c) => c.id !== id);
  if (config.styleId === id) config.styleId = 'default';
  buildStyleSelect();
  buildCustomStyleList();
  toast(t('opt.rewrite.customStyle.deleted'));
}

function onProviderChange(): void {
  const id = ($('provider') as HTMLSelectElement).value;
  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  ($('baseURL') as HTMLInputElement).value = preset.baseURL;
  ($('modelName') as HTMLInputElement).value = preset.defaultModel;
  updateKeyHint();
}

function buildSegmented(id: string, values: string[], current: string, onChange: (v: string) => void): void {
  const box = $(id);
  for (const value of values) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn' + (value === current ? ' active' : '');
    btn.dataset.value = value;
    btn.textContent = t(value === 'replace' || value === 'bubble' ? `onb.step4.mode.${value}` : `popup.intensity.${value}`);
    btn.title = t(value === 'replace' || value === 'bubble' ? `onb.step4.mode.${value}.desc` : `intensity.${value}.desc`);
    btn.addEventListener('click', () => {
      for (const b of box.querySelectorAll('.seg-btn')) b.classList.remove('active');
      btn.classList.add('active');
      onChange(value);
    });
    box.appendChild(btn);
  }
}

function updateKeyHint(): void {
  const hint = $('key-hint');
  if (savedKey) {
    hint.textContent = t('opt.api.key.hint', { tail: savedKey.slice(-4) });
  } else {
    hint.textContent = '';
  }
}

/** 站点管理：评论/弹幕分开开关（由 lib/sites/registry.ts 驱动，新增平台自动出现） */
function buildSiteList(): void {
  const container = $('site-list');
  container.innerHTML = '';
  for (const site of allAdapters()) {
    container.appendChild(
      buildSiteRow(site.label, site.key, 'comment', config.enabledSites.includes(site.key)),
    );
    if (site.danmaku) {
      container.appendChild(
        buildSiteRow(site.danmakuLabel ?? `${site.label} 弹幕`, site.key, 'danmaku', config.danmakuEnabledSites.includes(site.key)),
      );
    }
  }
}

function buildSiteRow(label: string, siteKey: string, cap: 'comment' | 'danmaku', checked: boolean): HTMLElement {
  const row = document.createElement('label');
  row.className = 'check-row site-row';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.dataset.siteKey = siteKey;
  checkbox.dataset.cap = cap;
  checkbox.checked = checked;
  const span = document.createElement('span');
  span.textContent = label;
  row.append(checkbox, span);
  return row;
}

async function save(): Promise<void> {
  const baseURL = ($('baseURL') as HTMLInputElement).value.trim();
  const key = ($('apiKey') as HTMLInputElement).value.trim();
  const modelName = ($('modelName') as HTMLInputElement).value.trim();
  const batchSize = Number(($('batchSize') as HTMLInputElement).value);
  const timeoutSec = Number(($('timeoutMs') as HTMLInputElement).value);
  const danmakuMaxRaw = ($('danmakuMaxTotal') as HTMLSelectElement).value;
  const danmakuMaxTotal = danmakuMaxRaw === '' ? null : Number(danmakuMaxRaw);
  if (!baseURL || !modelName) return toast('请填写接口地址与模型名称');
  if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 20) return toast('每批评论数需在 1–20 之间');
  if (!Number.isFinite(timeoutSec) || timeoutSec < 5 || timeoutSec > 120) return toast('请求超时需在 5–120 秒之间');
  const retryCount = Number(($('retryCount') as HTMLInputElement).value);
  const retryIntervalSec = Number(($('retryIntervalSec') as HTMLInputElement).value);
  if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 5) return toast('重试次数需为 0–5 的整数');
  if (!Number.isInteger(retryIntervalSec) || retryIntervalSec < 0 || retryIntervalSec > 30) return toast('重试间隔需为 0–30 的整数（秒）');

  // 自定义域名权限（用户手势内）
  if (!(await hasOriginAccess(baseURL))) {
    const granted = await requestOriginAccess(baseURL);
    if (!granted) return toast('未授权该地址的网络权限，已取消保存');
  }

  if (key) savedKey = key;
  const checkedSites = Array.from(
    document.querySelectorAll<HTMLInputElement>('#site-list input[type="checkbox"]:checked'),
  );
  const enabledSites = checkedSites.filter((c) => c.dataset.cap !== 'danmaku')
    .map((c) => c.dataset.siteKey ?? '')
    .filter(Boolean);
  const danmakuEnabledSites = checkedSites.filter((c) => c.dataset.cap === 'danmaku')
    .map((c) => c.dataset.siteKey ?? '')
    .filter(Boolean);
  const dmConcurrency = Number(($('dmConcurrency') as HTMLInputElement).value);
  const dmBatchSize = Number(($('dmBatchSize') as HTMLInputElement).value);
  if (!Number.isFinite(dmConcurrency) || dmConcurrency < 1 || dmConcurrency > 128) return toast('并发量需在 1–128 之间');
  if (!Number.isFinite(dmBatchSize) || dmBatchSize < 1 || dmBatchSize > 100) return toast('每批弹幕数需在 1–100 之间');
  // 手动值恰好匹配某预设 → 记为该预设；否则自定义
  const presetMatch = (Object.keys(DM_SPEED_PRESETS) as (keyof typeof DM_SPEED_PRESETS)[]).find(
    (k) => DM_SPEED_PRESETS[k].concurrency === dmConcurrency && DM_SPEED_PRESETS[k].batchSize === dmBatchSize,
  );
  await Promise.all([
    setApiKey(key),
    saveConfig({
      baseURL,
      modelName,
      batchSize,
      timeoutMs: timeoutSec * 1000,
      retryCount,
      retryIntervalSec,
      includeAuthor: ($('includeAuthor') as HTMLInputElement).checked,
      hideOriginalComment: ($('hideOriginalComment') as HTMLInputElement).checked,
      hideOriginalDanmaku: ($('hideOriginalDanmaku') as HTMLInputElement).checked,
      emojiToKaomoji: ($('emojiToKaomoji') as HTMLInputElement).checked,
      enableThinking: ($('enableThinking') as HTMLInputElement).checked,
      enabledSites: enabledSites,
      danmakuEnabledSites: danmakuEnabledSites,
      danmakuMaxTotal,
      dmPreset: presetMatch ?? 'custom',
      dmConcurrency,
      dmBatchSize,
      styleId: ($('stylePreset') as HTMLSelectElement).value,
      customStyles,
      onboardingDone: true,
    }),
  ]);
  updateKeyHint();
  void browser.runtime.sendMessage({ type: 'KW_CONFIG_CHANGED' }).catch(() => {});
  toast(t('btn.saved'));
}

async function runTest(): Promise<void> {
  const btn = $('btn-test') as HTMLButtonElement;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = t('btn.testing');
  const result = $('test-result');
  result.className = 'test-result';
  result.textContent = '';
  try {
    const res = (await browser.runtime.sendMessage({ type: 'KW_TEST_CONNECTION' })) as TestResult | null;
    if (!res) {
      result.textContent = t('onb.step3.fail', { reason: t('err.network') });
      result.classList.add('fail');
    } else if (res.ok) {
      result.textContent = t('onb.step3.ok', { model: res.model ?? '', latency: res.latencyMs ?? 0 });
      result.classList.add('ok');
    } else {
      result.textContent = t('onb.step3.fail', { reason: t(`err.${res.error ?? 'network'}`) });
      result.classList.add('fail');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function clearCache(): Promise<void> {
  await cacheClear();
  await refreshCacheInfo();
  toast(t('opt.data.clearCache'));
}

async function refreshCacheInfo(): Promise<void> {
  $('cache-info').textContent = t('opt.data.cache', { count: await cacheSize() });
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  const el = $('save-toast');
  el.textContent = text;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

void main();
