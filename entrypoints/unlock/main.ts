// Small window for passkey unlock (see lib/passkey-window.ts): ?win=<window to reopen the dropdown in>.
import '@/assets/theme.css';
import '@fontsource/metropolis/400.css';
import '@fontsource/metropolis/600.css';
import { browser } from 'wxt/browser';
import { debugLog } from '@/lib/debuglog';
import { insert } from '@/lib/html';
import { ICONS } from '@/lib/icons';
import { passkeyName } from '@/lib/passkey';
import { getPrefs } from '@/lib/prefs';
import { getSettings, setUnlocked } from '@/lib/storage';
import { openVault } from '@/lib/vault';

const $ = (id: string) => document.getElementById(id)!;
const opener = Number(new URLSearchParams(location.search).get('win')) || undefined;

function say(text: string, kind: '' | 'err' | 'ok' = '') {
  $('msg').textContent = text;
  $('msg').className = kind;
}

async function closeAndReopen() {
  const self = await browser.windows.getCurrent();
  if (opener) {
    try {
      // Needs the browser window focused first.
      await browser.windows.update(opener, { focused: true });
      await (browser.action as any).openPopup({ windowId: opener });
    } catch (e) {
      debugLog('unlock window: could not reopen dropdown:', (e as Error).message);
    }
  }
  await browser.windows.remove(self.id!);
}

async function run() {
  $('retry').hidden = true;
  const { vault } = await getSettings();
  if (vault?.wrap.method !== 'passkey') return say('Passkey unlock isn’t set up', 'err');
  const name = passkeyName(vault.wrap.kind);
  say(vault.wrap.kind === 'security-key' ? 'Touch your security key…' : 'Confirm with your passkey…');
  try {
    await setUnlocked(await openVault(vault));
    debugLog('unlock window: unlocked with', name);
    say('Unlocked', 'ok');
    setTimeout(closeAndReopen, 400);
  } catch (e) {
    const { name: err, message } = e as Error;
    debugLog('unlock window: failed:', err, message);
    say(err === 'NotAllowedError' ? 'Cancelled or timed out' : message, 'err');
    $('retry').hidden = false;
  }
}

getPrefs().then((p) => {
  if (p.theme !== 'system') document.documentElement.dataset.theme = p.theme;
});
insert($('icon'), 'afterend', ICONS.lock);
$('icon').remove();
$('retry').onclick = run;
$('close').onclick = async () => browser.windows.remove((await browser.windows.getCurrent()).id!);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('close').click();
});

// Prompt straight away. WebAuthn needs a focused document; wait briefly if it isn't yet.
if (document.hasFocus()) run();
else {
  const start = () => run();
  addEventListener('focus', start, { once: true });
  setTimeout(() => {
    removeEventListener('focus', start);
    if (!$('msg').textContent) run();
  }, 1000);
}
