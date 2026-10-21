import { browser } from 'wxt/browser';

import { SOUND_FILES } from './sounds.generated';

// Notification sounds: assets/sounds/source/* trimmed and encoded to assets/sounds/*.ogg by
// scripts/encode-sounds.mjs.
export const SOUNDS = SOUND_FILES;
export type SoundId = (typeof SOUND_FILES)[number][0] | 'none';
export const DEFAULT_SOUND: SoundId = 'nice';

/** A stored choice that no longer exists (renamed/removed sound) falls back to the default. */
export const validSound = (id: string | undefined): SoundId =>
  id === 'none' || SOUNDS.some(([s]) => s === id) ? (id as SoundId) : DEFAULT_SOUND;

// Copied into the build at sounds/<id>.ogg by wxt.config.ts.
export const soundUrl = (id: Exclude<SoundId, 'none'>) => browser.runtime.getURL(`/sounds/${id}.ogg` as any);

/** Play in a page context (popup, options, offscreen document, Firefox's background page). */
export async function playHere(soundId: SoundId, volume: number) {
  const id = validSound(soundId);
  if (id === 'none') return;
  const audio = new Audio(soundUrl(id));
  audio.volume = Math.min(1, Math.max(0, volume));
  await audio.play();
}

let offscreenReady: Promise<void> | undefined;

/**
 * Play from the background. Firefox's MV3 background is a page and can play audio directly;
 * Chrome's service worker can't, so it goes through an offscreen document.
 */
export async function playFromBackground(id: SoundId, volume: number) {
  if (id === 'none') return;
  if (typeof Audio !== 'undefined') return playHere(id, volume);
  const offscreen = (browser as any).offscreen;
  offscreenReady ??= (async () => {
    if (!(await offscreen.hasDocument())) {
      await offscreen.createDocument({
        url: '/offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play the new-mail notification sound',
      });
    }
  })().catch((e) => {
    offscreenReady = undefined;
    throw e;
  });
  await offscreenReady;
  const res = await browser.runtime.sendMessage({ type: 'play-sound', id, volume });
  if (res && !res.ok) throw new Error(res.error);
}
