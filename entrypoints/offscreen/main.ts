import { browser } from 'wxt/browser';
import { playHere, type SoundId } from '@/lib/sounds';

browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg?.type !== 'play-sound') return;
  playHere(msg.id as SoundId, msg.volume).then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: (e as Error).message }),
  );
  return true;
});
