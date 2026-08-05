import { browser } from 'wxt/browser';
import { getApiKey, getConfig, saveConfig } from '@/lib/config';
import type { Intensity, KindlyConfig } from '@/lib/config';
import { t } from '@/lib/i18n';
import type { StatusPayload } from '@/lib/messages';

const INTENSITIES: { value: Intensity; label: string; desc: string }[] = [
  { value: 'mild', label: t('popup.intensity.mild'), desc: t('intensity.mild.desc') },
  { value: 'moderate', label: t('popup.intensity.moderate'), desc: t('intensity.moderate.desc') },
  { value: 'strong', label: t('popup.intensity.strong'), desc: t('intensity.strong.desc') },
];

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

async function main(): Promise<void> {
  // 文案
  $('tagline').textContent = t('brand.slogan');
  $('privacy-note').textContent = t('brand.privacy');
  $('btn-start').textContent = t('popup.unconfigured.cta');
  $('btn-settings').textContent = t('popup.openSettings');
  $('btn-visit').textContent = t('popup.visitBilibili');
  $('intensity-label').textContent = t('popup.intensity');
  $('st-queue-label').textContent = t('popup.status.queue');
  $('st-inflight-label').textContent = t('popup.status.inflight');
  $('st-failures-label').textContent = t('popup.status.failures');
  $('st-rewritten-label').textContent = t('popup.status.rewritten');

  const [config, hasKey] = await Promise.all([getConfig(), getApiKey().then((k) => k.length > 0)]);
  render(config, hasKey);
  bindEvents(config);

  const status = await browser.runtime.sendMessage({ type: 'KW_GET_STATUS' }).catch(() => null);
  if (status) renderStatus(status);
  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'KW_STATUS') renderStatus(msg);
  });
}

function render(config: KindlyConfig, hasKey: boolean): void {
  const unconfigured = !hasKey || !config.onboardingDone;
  $('state-unconfigured').classList.toggle('hidden', !unconfigured);
  $('state-configured').classList.toggle('hidden', unconfigured);
  if (unconfigured) return;

  (document.getElementById('toggle') as HTMLInputElement).checked = config.enabled;
  $('toggle-label').textContent = config.enabled ? t('popup.toggle.on') : t('popup.toggle.off');
  buildIntensity(config.intensity);
}

function buildIntensity(current: Intensity): void {
  const box = $('intensity');
  box.innerHTML = '';
  for (const item of INTENSITIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn' + (item.value === current ? ' active' : '');
    btn.textContent = item.label;
    btn.title = item.desc;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(item.value === current));
    btn.addEventListener('click', () => {
      void saveConfig({ intensity: item.value });
      for (const b of box.querySelectorAll('.seg-btn')) b.classList.remove('active');
      btn.classList.add('active');
    });
    box.appendChild(btn);
  }
}

function renderStatus(status: StatusPayload): void {
  $('st-queue').textContent = String(status.queueLength);
  $('st-inflight').textContent = String(status.inFlight);
  $('st-failures').textContent = String(status.failures);
  $('st-rewritten').textContent = String(status.totalRewritten);

  const warnings = $('warnings');
  warnings.innerHTML = '';
  if (status.authFailed) {
    const p = document.createElement('p');
    p.className = 'warn warn-danger';
    p.textContent = t('popup.auth.warn');
    warnings.appendChild(p);
  } else if (status.paused) {
    const p = document.createElement('p');
    p.className = 'warn';
    p.textContent = t('popup.paused.warn');
    warnings.appendChild(p);
  }
  warnings.classList.toggle('hidden', warnings.childElementCount === 0);
}

function bindEvents(config: KindlyConfig): void {
  const toggle = document.getElementById('toggle') as HTMLInputElement;
  toggle.addEventListener('change', () => {
    $('toggle-label').textContent = toggle.checked ? t('popup.toggle.on') : t('popup.toggle.off');
    void browser.runtime.sendMessage({ type: 'KW_SET_ENABLED', enabled: toggle.checked }).catch(() => {});
  });

  $('btn-start').addEventListener('click', () => {
    void browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
    window.close();
  });
  $('btn-settings').addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
    window.close();
  });
  $('btn-visit').addEventListener('click', () => {
    void browser.tabs.create({ url: 'https://www.bilibili.com' });
    window.close();
  });
  void config;
}

void main();
