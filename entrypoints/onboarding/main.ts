/**
 * 初次引导 5 步向导。
 * 规则：每步可跳过（跳过不写 onboardingDone，popup 持续显示 CTA）；
 * 自定义 baseURL 在本步内触发权限申请（用户手势窗口内）。
 */

import { browser } from 'wxt/browser';
import {
  DANMAKU_MAX_OPTIONS,
  getApiKey,
  getConfig,
  hasOriginAccess,
  PROVIDER_PRESETS,
  requestOriginAccess,
  saveConfig,
  setApiKey,
  STYLE_PRESETS,
} from '@/lib/config';
import { allAdapters } from '@/lib/sites/registry';
import type { Intensity, KindlyConfig, ProviderPreset, UIMode } from '@/lib/config';
import { t } from '@/lib/i18n';
import type { TestResult } from '@/lib/messages';

const INTENSITY_OPTIONS: { value: Intensity; label: string; desc: string; example: string }[] = [
  { value: 'mild', label: t('popup.intensity.mild'), desc: t('intensity.mild.desc'), example: '“你脑子有病吧” → “你这样说不合适吧”' },
  { value: 'moderate', label: t('popup.intensity.moderate'), desc: t('intensity.moderate.desc'), example: '“就这水平也敢发？” → “这个水平还有提升空间”' },
  { value: 'strong', label: t('popup.intensity.strong'), desc: t('intensity.strong.desc'), example: '“滚出这个圈子” → “也许换个圈子更适合你”' },
];

const MODE_OPTIONS: { value: UIMode; label: string; desc: string }[] = [
  { value: 'replace', label: t('onb.step4.mode.replace'), desc: t('onb.step4.mode.replace.desc') },
  { value: 'bubble', label: t('onb.step4.mode.bubble'), desc: t('onb.step4.mode.bubble.desc') },
];

const EXAMPLE_URL = 'https://www.bilibili.com/video/BV1GJ411x7h7';

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

let config: KindlyConfig;
let testing = false;

async function main(): Promise<void> {
  config = await getConfig();

  // 静态文案
  $('btn-skip').textContent = t('btn.skip');
  document.querySelector('[data-step="1"] .step-title')!.textContent = t('onb.step1.title');
  document.querySelector('[data-step="1"] .step-desc')!.textContent = t('onb.step1.desc');
  $('promise-1').textContent = t('onb.step1.privacy.p1');
  $('promise-2').textContent = t('onb.step1.privacy.p2');
  $('promise-3').textContent = t('onb.step1.privacy.p3');
  $('step1-next').textContent = t('onb.step1.cta');
  document.querySelector('[data-step="2"] .step-title')!.textContent = t('onb.step2.title');
  document.querySelector('[data-step="2"] .step-desc')!.textContent = t('onb.step2.subtitle');
  const fields = Array.from(document.querySelectorAll<HTMLElement>('[data-step="2"] .form-field'));
  const baseURLLabel = fields[0]?.querySelector('.field-label');
  const modelLabel = fields[1]?.querySelector('.field-label');
  const keyLabel = fields[2]?.querySelector('.field-label');
  if (baseURLLabel) baseURLLabel.textContent = t('opt.api.baseURL');
  if (modelLabel) modelLabel.textContent = t('opt.api.model');
  if (keyLabel) keyLabel.textContent = t('opt.api.key');
  $('permission-hint').textContent = t('onb.step2.permission.need');
  $('step2-back').textContent = t('btn.back');
  $('step2-next').textContent = t('btn.next');
  document.querySelector('[data-step="3"] .step-title')!.textContent = t('onb.step3.title');
  document.querySelector('[data-step="3"] .step-desc')!.textContent = t('onb.step3.desc');
  $('btn-test').textContent = t('btn.test');
  $('step3-back').textContent = t('btn.back');
  $('step3-next').textContent = t('onb.step3.skipTest');
  document.querySelector('[data-step="4"] .step-title')!.textContent = t('onb.step4.title');
  document.querySelector('[data-step="4"] .step-desc')!.textContent = t('onb.step4.desc');
  $('intensity-label').textContent = t('onb.step4.intensity');
  $('mode-label').textContent = t('onb.step4.mode');
  $('sites-label').textContent = t('onb.step4.sites');
  $('stylePreset-label').textContent = t('opt.rewrite.stylePreset');
  $('danmakuMaxTotal-label').textContent = t('opt.rewrite.danmakuMaxTotal');
  (document.querySelector('label[for="batchSize"]') as HTMLElement).textContent = t('opt.rewrite.batchSize');
  (document.querySelector('label[for="timeoutMs"]') as HTMLElement).textContent = t('opt.rewrite.timeout');
  (document.querySelector('label[for="retryCount"]') as HTMLElement).textContent = t('opt.rewrite.retryCount');
  (document.querySelector('label[for="retryIntervalSec"]') as HTMLElement).textContent = t('opt.rewrite.retryIntervalSec');
  $('includeAuthor-label').textContent = t('opt.rewrite.includeAuthor');
  $('hideOriginalComment-label').textContent = t('opt.rewrite.hideOriginalComment');
  $('hideOriginalDanmaku-label').textContent = t('opt.rewrite.hideOriginalDanmaku');
  $('step4-back').textContent = t('btn.back');
  $('step4-next').textContent = t('btn.next');
  document.querySelector('[data-step="5"] .step-title')!.textContent = t('onb.step5.title');
  document.querySelector('[data-step="5"] .step-desc')!.textContent = t('onb.step5.desc');
  $('step5-cta').textContent = t('onb.step5.cta');
  $('step5-options').textContent = t('onb.step5.options');

  buildProviderGrid();
  buildChoiceCards();
  buildSiteList();
  buildStyleSelect();
  buildDanmakuMaxTotalSelect();
  ($('batchSize') as HTMLInputElement).value = String(config.batchSize);
  ($('timeoutMs') as HTMLInputElement).value = String(Math.round(config.timeoutMs / 1000));
  ($('retryCount') as HTMLInputElement).value = String(config.retryCount);
  ($('retryIntervalSec') as HTMLInputElement).value = String(config.retryIntervalSec);
  ($('includeAuthor') as HTMLInputElement).checked = config.includeAuthor;
  ($('hideOriginalComment') as HTMLInputElement).checked = config.hideOriginalComment;
  ($('hideOriginalDanmaku') as HTMLInputElement).checked = config.hideOriginalDanmaku;

  // 已配置过（重看引导）：预填
  const apiKey = await getApiKey();
  if (apiKey) {
    (document.getElementById('apiKey') as HTMLInputElement).value = apiKey;
    (document.getElementById('baseURL') as HTMLInputElement).value = config.baseURL;
    (document.getElementById('modelName') as HTMLInputElement).value = config.modelName;
  }

  bindEvents();
}

function bindEvents(): void {
  $('btn-skip').addEventListener('click', () => window.close());
  $('step1-next').addEventListener('click', () => go(2));

  $('step2-back').addEventListener('click', () => go(1));
  $('step2-next').addEventListener('click', () => void onStep2Next());

  $('step3-back').addEventListener('click', () => go(2));
  $('step3-next').addEventListener('click', () => go(4));
  $('btn-test').addEventListener('click', () => void runTest());

  $('step4-back').addEventListener('click', () => go(3));
  $('step4-next').addEventListener('click', () => {
    if (onStep4Next()) go(5);
  });

  $('step5-cta').addEventListener('click', () => {
    void browser.tabs.create({ url: EXAMPLE_URL });
    window.close();
  });
  $('step5-options').addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
    window.close();
  });

  (document.getElementById('key-eye') as HTMLButtonElement).addEventListener('click', () => {
    const input = document.getElementById('apiKey') as HTMLInputElement;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('key-eye').textContent = show ? '隐藏' : '显示';
  });
}

function buildProviderGrid(): void {
  const grid = $('providers');
  for (const preset of PROVIDER_PRESETS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'provider-card';
    card.dataset.provider = preset.id;
    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = preset.label;
    const hint = document.createElement('span');
    hint.className = 'provider-hint';
    hint.textContent = preset.hint;
    card.append(name, hint);
    card.addEventListener('click', () => {
      selectProvider(card, preset);
    });
    grid.appendChild(card);
  }
}

function selectProvider(card: HTMLElement, preset: ProviderPreset): void {
  for (const c of $('providers').children) c.classList.remove('selected');
  card.classList.add('selected');
  (document.getElementById('baseURL') as HTMLInputElement).value = preset.baseURL;
  (document.getElementById('modelName') as HTMLInputElement).value = preset.defaultModel;
  hideKeyError();
}

/** 站点列表：评论/弹幕分开开关（由 lib/sites/registry.ts 驱动，新增平台自动出现） */
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
  row.className = 'site-row';
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

/** 输出风格下拉：内置预置 + 已有自定义风格（只读展示，避免选中项被重置） */
function buildStyleSelect(): void {
  const select = $('stylePreset') as HTMLSelectElement;
  for (const preset of STYLE_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    select.appendChild(opt);
  }
  for (const custom of config.customStyles) {
    const opt = document.createElement('option');
    opt.value = custom.id;
    opt.textContent = `自定义 · ${custom.name}`;
    select.appendChild(opt);
  }
  const known = STYLE_PRESETS.some((p) => p.id === config.styleId) ||
    config.customStyles.some((c) => c.id === config.styleId);
  if (!known) config.styleId = 'default';
  select.value = config.styleId;
}

/** 弹幕处理上限下拉——选项定义共享自 lib/config.ts（与 options 一致） */
function buildDanmakuMaxTotalSelect(): void {
  const select = $('danmakuMaxTotal') as HTMLSelectElement;
  for (const opt of DANMAKU_MAX_OPTIONS) {
    const el = document.createElement('option');
    el.value = opt.value === null ? '' : String(opt.value);
    el.textContent = opt.label;
    select.appendChild(el);
  }
  select.value = config.danmakuMaxTotal === null ? '' : String(config.danmakuMaxTotal);
}

function buildChoiceCards(): void {  buildRadioCards('intensity-cards', INTENSITY_OPTIONS, config.intensity, (v) => {
    void saveConfig({ intensity: v as Intensity });
  });
  buildRadioCards('mode-cards', MODE_OPTIONS, config.mode, (v) => {
    void saveConfig({ mode: v as UIMode });
  });
}

function buildRadioCards<T extends string>(
  containerId: string,
  options: { value: T; label: string; desc: string; example?: string }[],
  current: T,
  onChange: (value: T) => void,
): void {
  const container = $(containerId);
  for (const opt of options) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'choice-card' + (opt.value === current ? ' selected' : '');
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(opt.value === current));
    const name = document.createElement('span');
    name.className = 'choice-name';
    name.textContent = opt.label;
    const desc = document.createElement('span');
    desc.className = 'choice-desc';
    desc.textContent = opt.desc;
    card.append(name, desc);
    if (opt.example) {
      const example = document.createElement('span');
      example.className = 'choice-example';
      example.textContent = opt.example;
      card.appendChild(example);
    }
    card.addEventListener('click', () => {
      for (const c of container.children) {
        c.classList.remove('selected');
        c.setAttribute('aria-checked', 'false');
      }
      card.classList.add('selected');
      card.setAttribute('aria-checked', 'true');
      onChange(opt.value);
    });
    container.appendChild(card);
  }
}

async function onStep2Next(): Promise<void> {
  const key = (document.getElementById('apiKey') as HTMLInputElement).value.trim();
  if (!key) {
    showKeyError(t('onb.step2.key.missing'));
    return;
  }
  hideKeyError();
  const baseURL = (document.getElementById('baseURL') as HTMLInputElement).value.trim();
  const modelName = (document.getElementById('modelName') as HTMLInputElement).value.trim();
  if (!baseURL || !modelName) {
    showKeyError('请填写接口地址与模型名称');
    return;
  }
  // 自定义域名授权（用户手势窗口内）
  const has = await hasOriginAccess(baseURL);
  if (!has) {
    const granted = await requestOriginAccess(baseURL);
    if (!granted) {
      showKeyError('未授权该地址的网络权限，无法继续');
      return;
    }
  }
  await Promise.all([setApiKey(key), saveConfig({ baseURL, modelName })]);
  go(3);
}

function showKeyError(text: string): void {
  const el = $('key-error');
  el.textContent = text;
  el.classList.remove('hidden');
}

function hideKeyError(): void {
  $('key-error').classList.add('hidden');
}

async function runTest(): Promise<void> {
  if (testing) return;
  testing = true;
  const btn = $('btn-test') as HTMLButtonElement;
  btn.disabled = true;
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
    testing = false;
    btn.disabled = false;
    btn.textContent = t('btn.test');
  }
}

/** 第 4 步保存：校验 + 写回所有基本配置；校验失败留在本步并提示 */
function onStep4Next(): boolean {
  const batchSize = Number(($('batchSize') as HTMLInputElement).value);
  const timeoutSec = Number(($('timeoutMs') as HTMLInputElement).value);
  const retryCount = Number(($('retryCount') as HTMLInputElement).value);
  const retryIntervalSec = Number(($('retryIntervalSec') as HTMLInputElement).value);
  if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 20) return showStep4Error('每批评论数需在 1–20 之间');
  if (!Number.isFinite(timeoutSec) || timeoutSec < 5 || timeoutSec > 120) return showStep4Error('请求超时需在 5–120 秒之间');
  if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 5) return showStep4Error('重试次数需为 0–5 的整数');
  if (!Number.isInteger(retryIntervalSec) || retryIntervalSec < 0 || retryIntervalSec > 30) return showStep4Error('重试间隔需为 0–30 的整数（秒）');
  hideStep4Error();
  const checkedInputs = Array.from(document.querySelectorAll<HTMLInputElement>('#site-list input[type="checkbox"]:checked'));
  const enabledSites = checkedInputs.filter((c) => c.dataset.cap !== 'danmaku')
    .map((c) => c.dataset.siteKey ?? '')
    .filter(Boolean);
  const danmakuEnabledSites = checkedInputs.filter((c) => c.dataset.cap === 'danmaku')
    .map((c) => c.dataset.siteKey ?? '')
    .filter(Boolean);
  const danmakuMaxRaw = ($('danmakuMaxTotal') as HTMLSelectElement).value;
  const danmakuMaxTotal = danmakuMaxRaw === '' ? null : Number(danmakuMaxRaw);
  // 第 4 步是向导最后一步表单：走到第 5 步（完成页）即视为引导完成。
  // 不写的话 onboardingDone 永远为 false，popup 会一直显示"开始配置"（死循环）
  void saveConfig({
    enabledSites,
    danmakuEnabledSites,
    onboardingDone: true,
    batchSize,
    timeoutMs: timeoutSec * 1000,
    retryCount,
    retryIntervalSec,
    danmakuMaxTotal,
    styleId: ($('stylePreset') as HTMLSelectElement).value,
    includeAuthor: ($('includeAuthor') as HTMLInputElement).checked,
    hideOriginalComment: ($('hideOriginalComment') as HTMLInputElement).checked,
    hideOriginalDanmaku: ($('hideOriginalDanmaku') as HTMLInputElement).checked,
  }).then(() => {
    void browser.runtime.sendMessage({ type: 'KW_CONFIG_CHANGED' }).catch(() => {});
  });
  return true;
}

function showStep4Error(text: string): boolean {
  const el = $('step4-error');
  el.textContent = text;
  el.classList.remove('hidden');
  return false;
}

function hideStep4Error(): void {
  $('step4-error').classList.add('hidden');
}

function go(target: number): void {
  for (let i = 1; i <= 5; i++) {
    const section = document.querySelector<HTMLElement>(`[data-step="${i}"]`);
    if (section) section.classList.toggle('hidden', i !== target);
    const dot = document.querySelector<HTMLElement>(`[data-dot="${i}"]`);
    if (dot) {
      dot.classList.toggle('done', i < target);
      dot.classList.toggle('current', i === target);
    }
  }
  window.scrollTo({ top: 0 });
}

void main();
