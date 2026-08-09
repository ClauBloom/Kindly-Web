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
} from '@/lib/config';
import type { Intensity, KindlyConfig, UIMode } from '@/lib/config';
import { t } from '@/lib/i18n';
import { allAdapters } from '@/lib/sites/registry';
import type { TestResult } from '@/lib/messages';

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

let config: KindlyConfig;
let savedKey = '';

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
  (document.querySelector('label[for="batchSize"]') as HTMLElement).textContent = t('opt.rewrite.batchSize');
  (document.querySelector('label[for="timeoutMs"]') as HTMLElement).textContent = t('opt.rewrite.timeout');
  (document.querySelector('label[for="danmakuMaxTotal"]') as HTMLElement).textContent = t('opt.rewrite.danmakuMaxTotal');
  (document.querySelector('label[for="dmConcurrency"]') as HTMLElement).textContent = t('opt.rewrite.dmConcurrency');
  (document.querySelector('label[for="dmBatchSize"]') as HTMLElement).textContent = t('opt.rewrite.dmBatchSize');
  $('dmSpeed-label').textContent = t('opt.rewrite.dmSpeed');
  $('includeAuthor-label').textContent = t('opt.rewrite.includeAuthor');
  $('hideOriginalComment-label').textContent = t('opt.rewrite.hideOriginalComment');
  $('hideOriginalDanmaku-label').textContent = t('opt.rewrite.hideOriginalDanmaku');
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
  ($('includeAuthor') as HTMLInputElement).checked = config.includeAuthor;
  ($('hideOriginalComment') as HTMLInputElement).checked = config.hideOriginalComment;
  ($('hideOriginalDanmaku') as HTMLInputElement).checked = config.hideOriginalDanmaku;
  buildDmSpeedControls(config);
  buildDanmakuMaxTotalSelect(config.danmakuMaxTotal);
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

/** 站点管理：由 lib/sites/registry.ts 驱动，新增平台自动出现 */
function buildSiteList(): void {
  const container = $('site-list');
  container.innerHTML = '';
  for (const site of allAdapters()) {
    const label = document.createElement('label');
    label.className = 'check-row site-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.siteKey = site.key;
    checkbox.checked = config.enabledSites.includes(site.key);
    const span = document.createElement('span');
    span.textContent = site.label;
    label.append(checkbox, span);
    container.appendChild(label);
  }
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

  // 自定义域名权限（用户手势内）
  if (!(await hasOriginAccess(baseURL))) {
    const granted = await requestOriginAccess(baseURL);
    if (!granted) return toast('未授权该地址的网络权限，已取消保存');
  }

  if (key) savedKey = key;
  const checkedSites = Array.from(
    document.querySelectorAll<HTMLInputElement>('#site-list input[type="checkbox"]:checked'),
  ).map((c) => c.dataset.siteKey ?? '')
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
      includeAuthor: ($('includeAuthor') as HTMLInputElement).checked,
      hideOriginalComment: ($('hideOriginalComment') as HTMLInputElement).checked,
      hideOriginalDanmaku: ($('hideOriginalDanmaku') as HTMLInputElement).checked,
      enabledSites: checkedSites,
      danmakuMaxTotal,
      dmPreset: presetMatch ?? 'custom',
      dmConcurrency,
      dmBatchSize,
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
