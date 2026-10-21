import { browser } from 'wxt/browser';

const KEY = 'debugLog';
const MAX = 200;

// Ring buffer in storage.local so background activity is inspectable from any extension page
// (the background's console output isn't visible to test tooling). Never log mail content.
// Re-read on every write: several pages (background, unlock window) append to the same buffer.
let chain = Promise.resolve();

export function debugLog(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map(String).join(' ')}`;
  console.debug('[super-fastmail]', ...parts);
  chain = chain
    .then(async () => {
      const entries = ((await browser.storage.local.get(KEY))[KEY] as string[] | undefined) ?? [];
      entries.push(line);
      if (entries.length > MAX) entries.splice(0, entries.length - MAX);
      await browser.storage.local.set({ [KEY]: entries });
    })
    .catch(() => {});
}
