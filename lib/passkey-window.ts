import { browser } from 'wxt/browser';

/**
 * Firefox can't show a WebAuthn prompt for a request made from the toolbar dropdown (it has no tab to
 * anchor to, so the request just hangs), so passkey unlock runs in a small window near the toolbar.
 * With `reopen`, the window reopens the dropdown when it's done.
 */
export async function openPasskeyWindow({ reopen = true } = {}) {
  const win = await browser.windows.getCurrent();
  const [width, height] = [380, 300];
  await browser.windows.create({
    url: browser.runtime.getURL(`/unlock.html?win=${reopen ? win.id : ''}` as any),
    type: 'popup',
    width,
    height,
    left: Math.round((win.left ?? 0) + (win.width ?? width) - width - 24),
    top: Math.round((win.top ?? 0) + 80),
  });
}
