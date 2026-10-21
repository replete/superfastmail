import '@/assets/theme.css';
import '@fontsource/metropolis/400.css';
import '@fontsource/metropolis/600.css';
import '@fontsource/metropolis/700.css';
import { browser } from 'wxt/browser';
import '@/assets/settings.css';
import { html, insert, render } from '@/lib/html';
import { getPrefs } from '@/lib/prefs';
import { aboutHtml } from '@/lib/settings-ui';
import { initConnection, load as loadConnection } from './connection';
import { ICONS } from '@/lib/icons';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Just the connection and how it's kept; everything else is in the dropdown's Settings.
render($('about'), aboutHtml());

async function applyTheme() {
  const p = await getPrefs();
  // Same light/dark choice as the popup.
  if (p.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = p.theme;
}

browser.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.prefs) applyTheme();
  if ((area === 'local' && c.settings) || (area === 'session' && c.unlocked)) loadConnection();
});
if (__FAKE__) insert($('state'), 'beforebegin', html`<span class="chip" style="position:fixed;right:8px;bottom:6px;font-size:9px;padding:3px 5px;border-radius:3px;background:#d97706;opacity:.9;pointer-events:none">FAKE</span>`);

// Each lock option with its icon (after the radio).
const LOCK_ICONS = { none: ICONS.unlock, passphrase: ICONS.key, device: ICONS.fingerprint, 'security-key': ICONS.usb } as const;
for (const m of document.querySelectorAll<HTMLElement>('.method')) {
  const input = m.querySelector('label input[name="lock"]');
  if (input) insert(input, 'afterend', html`<span class="micon">${LOCK_ICONS[m.dataset.m as keyof typeof LOCK_ICONS]}</span>`);
}

applyTheme();
initConnection();
