import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'wxt';

// FAKE_FASTMAIL=1 (or =<port>): a build that talks to scripts/fake-fastmail.mjs instead of Fastmail.
// It goes to its own output folder so it never replaces the build a live session has loaded. The
// interactive fake session uses port 8765; automated runs use their own port, so both can run at once.
const FAKE = Boolean(process.env.FAKE_FASTMAIL);
const FAKE_PORT = Number(process.env.FAKE_FASTMAIL) > 1 ? Number(process.env.FAKE_FASTMAIL) : 8765;

export default defineConfig({
  // The sources zip (for add-on review) must never carry local or personal files, tracked or not.
  zip: { excludeSources: ['.env*', 'reference/**', '.claude/**', '.output*/**', 'docs/**', 'web-ext.config.ts', 'assets/sounds/source/**'] },
  ...(FAKE ? { outDir: FAKE_PORT === 8765 ? '.output-fake' : `.output-fake-${FAKE_PORT}` } : {}),
  hooks: {
    // Ship the encoded sounds (assets/sounds/*.ogg) at sounds/<name>.ogg, without their MP3 sources.
    'build:publicAssets': (_wxt, files) => {
      const dir = path.resolve('assets/sounds');
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ogg'))) {
        files.push({ absoluteSrc: path.join(dir, f), relativeDest: `sounds/${f}` });
      }
      // The calendar UI ships as a prebuilt script (a global, not a module): loaded only when the
      // Calendar app opens.
      const ec = path.resolve('node_modules/@event-calendar/build/dist');
      for (const f of ['event-calendar.min.js', 'event-calendar.min.css']) files.push({ absoluteSrc: path.join(ec, f), relativeDest: `vendor/${f}` });
    },
    // Dev-only pages are built only with FIXTURES=1. (A hook rather than `filterEntrypoints`,
    // which would override per-browser `manifest.include` on other entrypoints.)
    'entrypoints:found': (_wxt, infos) => {
      if (process.env.FIXTURES) return;
      for (let i = infos.length - 1; i >= 0; i--) if (infos[i]!.name === 'email-preview') infos.splice(i, 1);
    },
  },
  vite: () => ({
    define: {
      __FIXTURES__: JSON.stringify(Boolean(process.env.FIXTURES)),
      __FAKE__: JSON.stringify(FAKE),
      // FAKE_SETUP=1 (pnpm fake:chrome): the fake build signs itself in on install (fake token and
      // Calendar password, no lock), for a browser without the Firefox harness to set it up.
      __FAKE_SETUP__: JSON.stringify(FAKE && Boolean(process.env.FAKE_SETUP)),
      __SESSION_URL__: JSON.stringify(FAKE ? `http://127.0.0.1:${FAKE_PORT}/jmap/session` : 'https://api.fastmail.com/jmap/session'),
      // Where CalDAV discovery starts: Fastmail's /.well-known redirect target (a browser can't read that
      // redirect, and the server root answers 404).
      __CALDAV_URL__: JSON.stringify(FAKE ? `http://127.0.0.1:${FAKE_PORT}/dav/calendars` : 'https://caldav.fastmail.com/dav/calendars'),
      __FILES_URL__: JSON.stringify(FAKE ? `http://127.0.0.1:${FAKE_PORT}/files/` : 'https://myfiles.fastmail.com/'),
    },
    // Keep bundled assets (fonts) as files rather than inlined data: URLs.
    build: { assetsInlineLimit: 0 },
  }),
  manifest: ({ browser }) => ({
    name: 'Super Fastmail',
    description: 'Unread count, notifications and quick inbox view for Fastmail.',
    // Public contact (a Fastmail masked address). Chrome wants { email }, Firefox a display string.
    author: (browser === 'firefox' ? 'replete <odd.oak3428@fastmail.com>' : { email: 'odd.oak3428@fastmail.com' }) as any,
    permissions: [
      'storage',
      'alarms',
      'notifications',
      'contextMenus',
      'activeTab',
      // Chrome's service worker needs an offscreen document to play sounds.
      ...(browser === 'chrome' ? ['offscreen'] : []),
    ],
    action: {
      // The logo's envelope in the toolbar (without this Firefox shows a generic icon). Swapped while locked.
      default_icon: { 16: 'icon/toolbar-16.png', 32: 'icon/toolbar-32.png' },
      // Firefox: start pinned to the toolbar instead of hidden in the extensions menu (Chrome has no equivalent).
      ...(browser === 'firefox' ? { default_area: 'navbar' } : {}),
    },
    host_permissions: ['https://api.fastmail.com/*', 'https://*.fastmail.com/*', ...(FAKE ? ['http://127.0.0.1/*'] : [])],
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'odd.oak3428@fastmail.com',
              // Shown at install. Mail, events and files only go between the browser and the user's own
              // Fastmail account, but Mozilla counts any handling outside the browser, so it's declared.
              data_collection_permissions: { required: ['personalCommunications'] },
            },
          },
        }
      : {}),
  }),
});
