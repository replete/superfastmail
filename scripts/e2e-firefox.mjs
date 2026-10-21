// Smoke test: loads .output/firefox-mv3 into a downloaded Firefox (throwaway profile) via
// Selenium/geckodriver, opens the extension pages as real top-level tabs and reports
// console errors (including the background script's).
//
//   pnpm build:firefox && node scripts/e2e-firefox.mjs
//
// Needs a Firefox binary: `pnpm exec puppeteer browsers install firefox` (or set FIREFOX_BIN).
// WebDriver refuses to navigate to moz-extension:// URLs, so tabs are opened from the
// privileged chrome context instead.
import { Builder, Button, By, Key } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Screenshots are written only when SHOTS_DIR is set (never into the repo by default).
const OUT = process.env.SHOTS_DIR;
// LIVE: use the real token from .env (via `pnpm test:e2e:live`). Output is redacted to counts,
// and no screenshots are taken, so no mail content ends up in logs.
// FAKE=1 (pnpm test:fake): run against scripts/fake-fastmail.mjs with the FAKE_FASTMAIL build, so
// write actions get exercised on made-up mail. It behaves like a live run otherwise.
// FAKE=<port> matches the build's FAKE_FASTMAIL port (8765 for the interactive session).
const FAKE = Boolean(process.env.FAKE);
const FAKE_PORT = Number(process.env.FAKE) > 1 ? Number(process.env.FAKE) : 8765;
const fake = FAKE ? await (await import('./fake-fastmail.mjs')).startFakeFastmail({ port: FAKE_PORT }) : undefined;
const LIVE_TOKEN = FAKE ? 'fake-token' : process.env.FASTMAIL_API_KEY;
const LIVE = Boolean(LIVE_TOKEN);
// WATCH=<seconds>|forever: after the flow, keep the browser open and stream background logs.
// With "forever" it runs until the Firefox window is closed.
const WATCH = process.env.WATCH === 'forever' ? Infinity : Number(process.env.WATCH ?? 0);
// FRESH (pnpm fresh:firefox): a new user's first run. Just the extension: no token, no tabs opened,
// and rebuilds keep whatever the user has set up. Background logs are read from chrome code instead.
const FRESH = Boolean(process.env.FRESH);
// TOUR=<dir> (pnpm tour): not the tests: walk through the popup on the fake server for the README screenshots.
const TOUR = process.env.TOUR;
const GECKO_ID = 'odd.oak3428@fastmail.com';
const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-downloads-'));
const UUID = '11111111-1111-4111-8111-111111111111';
const base = `moz-extension://${UUID}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firefoxBinary() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  const dir = path.join(os.homedir(), '.cache/puppeteer/firefox');
  return path.join(dir, fs.readdirSync(dir)[0], 'Firefox.app/Contents/MacOS/firefox');
}

const options = new firefox.Options()
  .setBinary(firefoxBinary())
  .setPreference('extensions.webextensions.uuids', JSON.stringify({ [GECKO_ID]: UUID }))
  // Reloading the extension closes its pages; if one was the last tab, keep the window (new tab instead).
  .setPreference('browser.tabs.closeWindowWithLastTab', false)
  // Downloads (attachment tests) go to a temp folder, never the user's Downloads.
  .setPreference('browser.download.folderList', 2)
  .setPreference('browser.download.dir', DOWNLOADS)
  .setPreference('browser.download.useDownloadDir', true)
  .setPreference('browser.download.always_ask_before_handling_new_types', false);
// HEADLESS=1: no window (for automated runs alongside an interactive session).
if (process.env.HEADLESS) options.addArguments('-headless');

// System access lets us use the chrome context (geckodriver passes the flag on to Firefox).
const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
const driver = await new Builder()
  .forBrowser('firefox')
  .setFirefoxOptions(options)
  .setFirefoxService(service)
  .build();

async function chrome(script, ...args) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeScript(script, ...args);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

// The harness's own browser window. Not simply the most recent one: the extension opens small popup
// windows (passkey unlock) that become most recent while they're up.
const MAIN_WINDOW = `([...Services.wm.getEnumerator('navigator:browser')].find((w) => w.__harness) ??
  Services.wm.getMostRecentWindow('navigator:browser'))`;

/** Collect every console message Firefox sees (pages + background) into the chrome window. */
async function startConsoleCapture() {
  await chrome(`
    const w = Services.wm.getMostRecentWindow('navigator:browser');
    w.__harness = true;
    w.__log = [];
    const t0 = Date.now();
    const stamp = () => '+' + ((Date.now() - t0) / 1000).toFixed(0) + 's ';
    // Errors and warnings.
    Services.console.registerListener({
      observe(m) {
        const text = m.message ?? String(m);
        const src = m.sourceName ?? '';
        if (/moz-extension|super-fastmail/.test(text + src)) w.__log.push(stamp() + text + (src ? '  @ ' + src : ''));
      },
    });
    // console.log/debug/... from extension pages and the background script.
    Services.obs.addObserver({
      observe(subject) {
        const m = subject.wrappedJSObject;
        if (!/^moz-extension:/.test(m.filename ?? '')) return;
        const page = m.filename.split('/').pop();
        w.__log.push(stamp() + '[' + m.level + ' ' + page + '] ' + m.arguments.map(String).join(' '));
      },
    }, 'console-api-log-event');
  `);
}

async function drainConsole(label) {
  const log = await chrome(`
    const w = ${MAIN_WINDOW};
    const l = w.__log ?? []; w.__log = []; return l;
  `);
  // Expected for email frames (scripts are stopped by their CSP instead; see mountFrame).
  const short = log.filter((l) => !l.includes('both allow-scripts and allow-same-origin')).map((l) => l.replaceAll(base, 'ext:'));
  if (!short.length && label === 'errors') return; // keep watch output quiet
  console.log(`  [${label}] console:`, short.length ? '\n    ! ' + short.join('\n    ! ') : 'clean');
  await checkShownText(label);
}

// html`` escapes values itself, so a template gone wrong shows as text escaped twice (`&lt;`, `&#39;`, in text or
// attributes, hidden panels too), markup escaped once and shown as text (`<span class="…">`), or Html joined as a
// string ("[object Object]"). Email frames' srcdoc is left out: a body can legitimately contain `&amp;`.
async function checkShownText(label) {
  const bad = await driver
    .executeScript(
      `const dom = (document.body?.outerHTML ?? '').replace(/ srcdoc="[^"]*"/g, '');
      const text = document.body?.innerText ?? '';
      return dom.match(/&amp;(?:lt|gt|amp|quot|#\\d+);|\\[object Object\\]/)?.[0]
        ?? text.match(/class="|xmlns="http:\\/\\/www\\.w3\\.org|<\\/(?:span|div|b|button|li)>/)?.[0] ?? null`,
    )
    .catch(() => null);
  if (bad) throw new Error(`[${label}] the page shows ${JSON.stringify(bad)}`);
}

/** The extension's debugLog, read from its storage in chrome code (no extension tab needed). */
async function debugLogViaChrome() {
  return chrome(
    `const { ExtensionStorageIDB } = ChromeUtils.importESModule('resource://gre/modules/ExtensionStorageIDB.sys.mjs');
     const ext = WebExtensionPolicy.getByID(arguments[0]).extension;
     return ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(ext))
       .then((db) => db.get(['debugLog']))
       .then((r) => {
         let v = r instanceof Map ? r.get('debugLog') : r?.debugLog;
         if (v && typeof v.deserialize === 'function') v = v.deserialize(globalThis);
         return v ?? [];
       });`,
    GECKO_ID,
  );
}

/** Open an extension page as a real top-level tab and switch WebDriver to it. */
/** Change preferences directly (the Settings view is tested on its own). */
async function setPrefs(patch) {
  await driver.executeScript("const p = arguments[0]; return browser.storage.local.get('prefs').then((r) => browser.storage.local.set({ prefs: { ...r.prefs, ...p } }))", patch);
  await sleep(400);
}

/** Reload the page; the dropdown starts from the list, not the message that was open (tests expect that). */
async function reloadFresh() {
  await driver.executeScript("return browser.storage?.session.remove('reading')").catch(() => {});
  await driver.navigate().refresh();
}

async function openTab(page, { select = true } = {}) {
  const before = new Set(await driver.getAllWindowHandles());
  await chrome(
    `const w = ${MAIN_WINDOW};
     const tab = w.gBrowser.addTab(arguments[0], {
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });
     if (arguments[1]) w.gBrowser.selectedTab = tab;`,
    `${base}/${page}`,
    select,
  );
  await sleep(1500);
  const handle = (await driver.getAllWindowHandles()).find((h) => !before.has(h));
  await driver.switchTo().window(handle);
}

async function tabUrls() {
  const urls = [];
  for (const h of await driver.getAllWindowHandles()) {
    await driver.switchTo().window(h);
    urls.push(await driver.getCurrentUrl());
  }
  return urls;
}

// Never with a real token (no real mail in screenshots); the fake server's mail is made up.
const shot = async (name) =>
  (LIVE && !FAKE) || !OUT || fs.writeFileSync(`${OUT}/${name}.png`, await driver.takeScreenshot(), 'base64');
const redact = (t) => (LIVE ? `[${t.length} chars]` : JSON.stringify(t));
const text = async (sel) => (await driver.findElement(By.css(sel)).getText()).trim();

const EXT_DIR = path.resolve(
  !FAKE ? '.output/firefox-mv3' : FAKE_PORT === 8765 ? '.output-fake/firefox-mv3' : `.output-fake-${FAKE_PORT}/firefox-mv3`,
);
const manifestMtime = () => fs.statSync(path.join(EXT_DIR, 'manifest.json'), { throwIfNoEntry: false })?.mtimeMs;

async function saveToken() {
  await openTab('options.html');
  await driver.findElement(By.css('#token')).sendKeys(LIVE_TOKEN ?? 'dummy-token-not-real');
  // One-off runs leave push off: Fastmail allows one stream per token, and a live session may hold it.
  // (Its switch is in the dropdown's Settings now; saving the connection keeps it.)
  await driver.executeScript("return browser.storage.local.get('settings').then((r) => browser.storage.local.set({ settings: { intervalMinutes: 1, ...r.settings, push: arguments[0] } }))", Boolean(WATCH));
  // A fake-server session to play with doesn't lock (nothing real to protect); tests use a password.
  const lock = FAKE && WATCH === Infinity ? 'none' : 'passphrase';
  await driver.findElement(By.css(`input[name="lock"][value="${lock}"]`)).click();
  if (lock === 'passphrase') {
    await driver.findElement(By.css('#pass')).sendKeys('dummy passphrase 123');
    await driver.findElement(By.css('#pass2')).sendKeys('dummy passphrase 123');
  }
  await driver.findElement(By.css('#save')).click();
  await sleep(2500); // checks the token with Fastmail, then PBKDF2
  // The dummy token fails the check; saving it anyway takes a second click.
  if ((await text('#save')) === 'Save anyway') {
    await driver.findElement(By.css('#save')).click();
    await sleep(1500);
  }
  // Fake server: the Calendar/Files password too (the field shows once a token is saved).
  if (FAKE) {
    await driver.findElement(By.css('#dav')).sendKeys('fake-dav-password');
    await driver.findElement(By.css('#save')).click();
    await sleep(2500);
    console.log('  calendar password:', JSON.stringify(await text('#davResult')), '|', JSON.stringify(await text('#connStatus')));
  }
}

try {
  await startConsoleCapture();
  console.log('installed:', await driver.installAddon(EXT_DIR, true));

  await sleep(1500);
  await drainConsole('install + background');

  if (FRESH) {
    console.log('# fresh profile: extension only, no token');
  } else if (TOUR) {
    await saveToken();
    await openTab('popup.html');
    await sleep(2000);
    await (await import('./tour.mjs')).tour({ driver, By, Key, sleep, dir: TOUR, fake, openTab });
  } else if (WATCH === Infinity) {
    // Live session (pnpm live:firefox / fake:firefox): skip the test suite, just sign in and open the popup.
    await saveToken();
    await openTab('popup.html');
    if (FAKE) console.log(`# fake Fastmail: new mail with  curl ${fake.url}/fake/new  ·  start over with  curl ${fake.url}/fake/reset`);
  } else {
    console.log('\n# popup');
    await openTab('popup.html');
    console.log('  header:', (await text('#account')).replace(/./g, '•').slice(0, 3) + '… ' + await text('#unreadCount'), '| body:', redact(await text('#body')));
    await shot('popup');
    await drainConsole('popup load');

    console.log('\n# settings');
    await driver.findElement(By.css('#railSettings')).click();
    await sleep(800);
    // The gear shows the in-dropdown Settings; its Connection link opens the full settings page.
    console.log('  settings in the dropdown:', await driver.executeScript("return document.body.dataset.app + ' | ' + document.getElementById('connSummary').textContent"));
    await driver.findElement(By.css('#openConnection')).click();
    await sleep(1500);
    console.log('  open tabs:', await tabUrls());
    await drainConsole('gear');

    console.log('\n# options save bar');
    {
      await openTab('options.html');
      // (Back to Mail for the popup tests that follow.)
      await driver.executeScript("return browser.storage.local.get('prefs').then((r) => browser.storage.local.set({ prefs: { ...r.prefs, app: 'mail' } }))");
      const bar = () =>
        driver.executeScript(`const b = document.getElementById('saveBar'), s = document.getElementById('save');
          return getComputedStyle(b).display === 'none' ? 'hidden' : (s.disabled ? 'disabled' : 'enabled') + ' "' + s.textContent + '"' +
            (document.getElementById('saveReason').textContent ? ' (' + document.getElementById('saveReason').textContent + ')' : '');`);
      const steps = [['fresh', await bar()]];
      const type = (sel, v) => driver.findElement(By.css(sel)).sendKeys(v);
      const trySave = async (k) => {
        await driver.findElement(By.css('#save')).click();
        await sleep(200);
        steps.push([k, await bar()]);
      };
      await type('#token', 'dummy-token-not-real');
      steps.push(['token typed', await bar()]);
      await trySave('save, no lock');
      await driver.findElement(By.css('input[name="lock"][value="passphrase"]')).click();
      steps.push(['password chosen', await bar()]);
      await trySave('save, no password');
      await type('#pass', 'dummy passphrase 123');
      await trySave('save, not repeated');
      await type('#pass2', 'dummy passphrase 12');
      await trySave('save, mismatch');
      await type('#pass2', '3');
      steps.push(['match', await bar()]);
      await driver.findElement(By.css('#cancel')).click();
      steps.push(['cancel', await bar()]);
      for (const [k, v] of steps) console.log(`  ${k}: ${v}`);
    }

    console.log('\n# options save');
    await saveToken();
    console.log('  state after:', await text('#state'), '| msg:', JSON.stringify(await text('#connStatus')), '| bar:',
      await driver.executeScript("return getComputedStyle(document.getElementById('saveBar')).display === 'none' ? 'hidden' : 'shown'"));
    await shot('options');
    // Like a password manager refilling the saved values: nothing to save.
    if (FAKE) {
      await driver.executeScript(`for (const [id, v] of [['token', arguments[0]], ['dav', 'fake-dav-password']]) {
        const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }`, LIVE_TOKEN);
      console.log('  refilled with saved values: bar', await driver.executeScript("return getComputedStyle(document.getElementById('saveBar')).display === 'none' ? 'hidden' : 'shown: ' + document.getElementById('saveReason').textContent"));
      await driver.executeScript("for (const id of ['token', 'dav']) document.getElementById(id).value = ''; document.getElementById('dav').dispatchEvent(new Event('input'))");
    }
    await drainConsole('options save');

    if (FAKE) {
      // Vacation response (settings): loads, saves as it changes.
      console.log('\n# vacation response');
      await openTab('popup.html');
      await sleep(2000);
      await driver.findElement(By.css('#railSettings')).click();
      await sleep(1500);
      await driver.findElement(By.css('#setTabs [data-st="vacation"]')).click();
      const vac = () => driver.executeScript("return { shown: !document.getElementById('vacation').hidden, disabled: document.getElementById('vacOn').disabled, note: document.getElementById('vacNote').textContent }");
      console.log('  loaded:', JSON.stringify(await vac()));
      await driver.findElement(By.css('#vacOn')).click();
      await driver.findElement(By.css('#vacSubject')).sendKeys('Away this week', Key.TAB);
      await driver.executeScript("const d = document.getElementById('vacTo'); d.value = '2026-10-25'; d.dispatchEvent(new Event('change'))");
      await sleep(1500);
      console.log('  saved:', JSON.stringify(fake.data.vacation), '| toast:', await driver.executeScript("return document.getElementById('toastMsg')?.textContent"));
      fake.data.vacation.isEnabled = false;
    }

    console.log('\n# notification sound');
    // In the dropdown's Settings (the full page is only the connection now).
    if (!FAKE) {
      await openTab('popup.html');
      await sleep(2000);
      await driver.findElement(By.css('#railSettings')).click();
      await sleep(1500);
    }
    await driver.findElement(By.css('#setTabs [data-st="secNotify"]')).click();
    console.log('  sounds offered:', await driver.executeScript("return [...document.querySelectorAll('#sounds .snd')].map((b) => b.dataset.id).join(',')"));
    await driver.findElement(By.css('#sounds [data-id="tink"]')).click();
    await sleep(600);
    console.log('  picked tink:', await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.storage.local.get('prefs').then((r) => done('pressed=' + document.querySelector('#sounds [aria-pressed="true"]').dataset.id + ' saved=' + r.prefs.sound));
    `));
    await driver.findElement(By.css('#sounds [data-id="chime"]')).click();
    await sleep(300);
    await shot('options-sounds');
    await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.storage.local.get('prefs').then((r) => browser.storage.local.set({ prefs: { ...r.prefs, theme: 'light' } })).then(done);
    `);
    await reloadFresh();
    await sleep(800);
    await shot('options-light');
    await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.storage.local.get('prefs').then((r) => browser.storage.local.set({ prefs: { ...r.prefs, theme: 'system' } })).then(done);
    `);
    // The background's test hook (no button in the UI any more): a notification plus the sound.
    const sent = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage({ type: 'test-notify' }).then((r) => done(r?.ok ? 'Sent.' : 'Failed: ' + r?.error), (e) => done('Failed: ' + e.message));
    `);
    await sleep(1500);
    console.log('  test notification:', sent, '|', await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.storage.local.get('debugLog').then((r) => done((r.debugLog ?? []).filter((l) => l.includes('sound:')).slice(-1)[0]?.slice(24) ?? 'no sound log'));
    `));
    await drainConsole('sound');
    // Opening Settings in the dropdown made it the app to open with; back to Mail for what follows.
    await setPrefs({ app: 'mail' });

    console.log(`\n# popup after save (${LIVE ? 'live token' : 'dummy token, expect HTTP 401'})`);
    // The gear handler calls window.close(), so the first popup tab is gone; open a fresh one.
    await openTab('popup.html');
    await sleep(3000);
    {
      const cls = () => driver.executeScript("return document.getElementById('refresh').className");
      await driver.findElement(By.css('#refresh')).click();
      const during = await cls();
      await sleep(LIVE ? 3000 : 2500);
      console.log(`  refresh: during="${during}" after="${await cls()}" title="${await driver.executeScript("return document.getElementById('refresh').title")}"`);
    }
    // Find rows after the refresh: it re-renders the list.
    const items = await driver.findElements(By.css('#body li'));
    console.log('  header:', (await text('#account')).replace(/./g, '•').slice(0, 3) + '… ' + await text('#unreadCount'), '| list items:', items.length);
    const dot = await driver.executeScript(
      "const d = document.getElementById('dot'); return d.className + ' | ' + d.title.split('Now: ')[1];",
    );
    console.log('  status dot:', dot);
    console.log('  compose:', await driver.executeScript("const c = document.getElementById('compose'); return c.getAttribute('aria-disabled') === 'true' ? 'disabled: ' + c.title : 'enabled'"));
    if (items.length) {
      await driver.findElement(By.css('body')).sendKeys('jj');
      console.log('  after "jj": selected index =', await driver.executeScript(
        "return [...document.querySelectorAll('#body li')].findIndex((li) => li.classList.contains('sel'))",
      ));
      const ha = await driver.executeScript("return document.querySelectorAll('#body li:first-child .hover-actions button').length");
      console.log('  pinned rows in list:', await driver.executeScript("return document.querySelectorAll('#body .pin.on').length"));
      console.log('  hover actions per row:', ha, '| rows with attachments:', await driver.executeScript("return [...document.querySelectorAll('#body .att')].filter((a) => a.innerHTML).length"));
      const bulkState = () => driver.executeScript(
        "return [document.getElementById('bulk').hidden ? 'bulk hidden' : document.getElementById('bulkCount').textContent, document.querySelectorAll('#body li.checked').length + ' checked', document.querySelector('.tabs').hidden ? 'tabs hidden' : 'tabs shown'].join(', ')",
      );
      await driver.findElement(By.css('body')).sendKeys('x');
      console.log('  after "x":', await bulkState());
      await driver.findElement(By.css('#body li:nth-child(1) input.cb')).click();
      console.log('  after first checkbox:', await bulkState(), '| reader open:', await driver.executeScript("return document.body.classList.contains('reading')"));
      await driver.findElement(By.css('#selAll')).click();
      console.log('  after select all:', await bulkState());
      await driver.findElement(By.css('#selAll')).click();
      console.log('  after select all again:', await bulkState());
    }
    if (!items.length) console.log('  body:', JSON.stringify(await text('#body')));
    else console.log('  first item:', redact(await items[0].getText()));
    await shot('popup-after-save');
    await drainConsole('popup after save');

    if (FAKE) {
      // Write actions against the fake server: what the list shows, what the server ends up with.
      console.log('\n# actions (fake server)');
      const js = (code, ...args) => driver.executeScript(code, ...args);
      const rows = () => js("return [...document.querySelectorAll('#body li[data-id]')].map((li) => li.dataset.id + (li.classList.contains('read') ? '(read)' : ''))");
      const toastText = () => js("const t = document.getElementById('toast'); return t.hidden ? '' : document.getElementById('toastMsg').textContent");
      const boxes = (id) => Object.keys(fake.data.emails.find((e) => e.id === id)?.mailboxIds ?? {}).join(',');
      const kw = (id) => Object.keys(fake.data.emails.find((e) => e.id === id)?.keywords ?? {}).join(',') || '-';
      const pressKey = async (k) => {
        await driver.findElement(By.css('body')).sendKeys(k);
        await sleep(900);
      };
      fake.reset();
      await openTab('popup.html');
      await sleep(1500);
      console.log('  unread list:', (await rows()).join(' '));
      console.log('  alignment:', JSON.stringify(await js(`const x = (el) => Math.round(el.getBoundingClientRect().left);
        return { selAll: x(document.getElementById('selAll')), rowCb: x(document.querySelector('#body li input.cb')),
          firstTab: x(document.querySelector('.tabs [data-v]')), sender: x(document.querySelector('#body li .from')),
          cb: document.querySelector('#body li input.cb').getBoundingClientRect().width };`)));

      await js("document.querySelector('#body li[data-id=\"e1\"] [data-act=\"archive\"]').click()");
      await sleep(900);
      console.log(`  hover archive e1: rows=${(await rows()).join(' ')} | toast="${await toastText()}" | server e1 in ${boxes('e1')}`);
      await driver.findElement(By.css('#toastUndo')).click();
      await sleep(1500);
      console.log(`  undo: server e1 in ${boxes('e1')} | rows=${(await rows()).join(' ')}`);

      // Keyboard: select the second row (j), unpin (s), delete (d), undo (z), spam (!).
      await pressKey('j');
      await pressKey('j');
      const sel = await js("return document.querySelector('#body li.sel')?.dataset.id");
      await pressKey('s');
      console.log(`  "s" on ${sel}: toast="${await toastText()}" | server keywords ${kw(sel)}`);
      await pressKey('d');
      console.log(`  "d": server ${sel} in ${boxes(sel)} | rows=${(await rows()).join(' ')}`);
      await pressKey('z');
      await sleep(800);
      console.log(`  "z": server ${sel} in ${boxes(sel)} | toast="${await toastText()}"`);

      // Bulk: check two rows, Archive.
      await js("for (const id of ['e1', 'e5']) document.querySelector(`#body li[data-id=\"${id}\"] input.cb`).click()");
      await sleep(300);
      await js("document.querySelector('#bulk [data-act=\"archive\"]').click()");
      await sleep(1200);
      console.log(`  bulk archive e1+e5: toast="${await toastText()}" | server e1 in ${boxes('e1')}, e5 in ${boxes('e5')} | rows=${(await rows()).join(' ')}`);

      // Opening a message marks it read; it stays in the Unread list until the tab changes.
      fake.reset();
      await reloadFresh();
      await sleep(1500);
      await js("document.querySelector('#body li[data-id=\"e2\"] .subj').click()");
      await sleep(1500);
      await js("document.getElementById('back').click()");
      await sleep(1500);
      console.log(`  open e2 then back: server keywords ${kw('e2')} | rows=${(await rows()).join(' ')}`);
      // Read here, then deleted: gone, and it stays gone after the next refresh of the list.
      await js("document.querySelector('#body li[data-id=\"e2\"] [data-act=\"delete\"]').click()");
      await sleep(900);
      await js("document.getElementById('refresh').click()");
      await sleep(1500);
      console.log(`  then delete e2: server in ${boxes('e2')} | listed=${(await rows()).some((r) => r.startsWith('e2'))}`);

      // Conversations: one row per thread; opening shows the others as rows; actions cover the thread.
      fake.reset();
      await reloadFresh();
      await sleep(1500);
      const list = await rows();
      console.log(`  conversation t9 rows: e10=${list.some((r) => r.startsWith('e10'))} e9=${list.some((r) => r.startsWith('e9'))}`);
      await js("document.querySelector('#body li[data-id=\"e10\"] .subj').click()");
      await sleep(1500);
      const thread = () => js(`return { open: [...document.querySelectorAll('#msgs .cmsg.open')].map((m) => m.dataset.msg),
        closed: [...document.querySelectorAll('#msgs .cmsg.closed')].map((m) => m.dataset.msg),
        focus: document.querySelector('#msgs .cmsg.focus')?.dataset.msg,
        sized: [...document.querySelectorAll('#msgs .cmsg.open .mframe')].map((f) => Math.round(f.getBoundingClientRect().height) + '/' + Math.ceil(f.contentDocument?.documentElement.getBoundingClientRect().height)) }`);
      console.log('  open e10:', JSON.stringify(await thread()), `| server e9 ${kw('e9')}, e10 ${kw('e10')}`);
      await pressKey('p');
      console.log('  "p":', JSON.stringify(await thread()));
      await pressKey('n');
      console.log('  "n":', JSON.stringify(await thread()));
      await pressKey('y');
      await sleep(600);
      console.log(`  "y" in the conversation: server e9 in ${boxes('e9')}, e10 in ${boxes('e10')} | reading=${await js("return document.body.classList.contains('reading')")}`);

      // Open a message by id, the way a notification click does.
      const openById = async (id) => {
        await js(`browser.storage.session.set({ pendingOpen: { id: '${id}', at: Date.now() } })`);
        await reloadFresh();
        await sleep(2500);
      };

      // Security: hostile payloads must not run, load anything, or open anything but web links.
      await openById('x1');
      const tabsBefore = (await driver.getAllWindowHandles()).length;
      const popupHandle = await driver.getWindowHandle();
      // Real pointer clicks at on-screen coordinates (WebDriver's in-frame targeting ignores the
      // reader's slide transform; a person clicks where the link is drawn).
      const clicked = [];
      for (const id of ['web', 'self', 'top', 'tabjs', 'spacejs', 'datahtml', 'svga', 'rel']) {
        const at = await js(`const f = document.querySelector('#msgs .cmsg.open .mframe'); const el = f.contentDocument.getElementById('${id}');
          if (!el) return null; const fr = f.getBoundingClientRect(), r = el.getBoundingClientRect();
          return { x: Math.round(fr.left + r.left + Math.min(r.width / 2, 20)), y: Math.round(fr.top + r.top + r.height / 2) };`);
        if (!at) {
          clicked.push(`${id}:missing`);
          continue;
        }
        await driver.actions({ async: true }).move({ x: at.x, y: at.y, origin: 'viewport' }).click().perform();
        clicked.push(id);
        await sleep(400);
      }
      await driver.switchTo().window(popupHandle);
      await sleep(1000);
      const newTabs = [];
      for (const h of await driver.getAllWindowHandles()) {
        if (h === popupHandle) continue;
        await driver.switchTo().window(h);
        const u = await driver.getCurrentUrl();
        if (!/^(about:blank|moz-extension:)/.test(u)) newTabs.push(u);
      }
      await driver.switchTo().window(popupHandle);
      const stillThere = await js("return Boolean(document.querySelector('#msgs .cmsg.open .mframe')?.contentDocument?.getElementById('web'))");
      console.log(`  hostile: frame still shows the email=${stillThere} | pwned=${JSON.stringify(await js('return window.__pwned ?? null'))} | server hits=${JSON.stringify(fake.pwned)} | clicked=${clicked.join(',')} | tabs ${tabsBefore}→${(await driver.getAllWindowHandles()).length} opened=${JSON.stringify(newTabs)} | sandbox="${await js("return document.querySelector('#msgs .mframe').getAttribute('sandbox')")}"`);


      // Control: an ordinary target=_blank link on the settings page (no frame, no sandbox).
      await openTab('options.html');
      const ctl = await driver.findElement(By.css('.labelrow a'));
      await driver.actions({ async: true }).move({ origin: ctl }).click().perform();
      await sleep(1500);
      console.log('  control link (settings page):', JSON.stringify(await chrome(`return [...Services.wm.getEnumerator('navigator:browser')].map((w) => [...w.gBrowser.tabs].map((t) => t.linkedBrowser.currentURI.spec.slice(0, 50)).filter((u) => !u.startsWith('moz-extension') && u !== 'about:blank'))`)));
      await driver.switchTo().window(popupHandle);

      // Layout: a 100vh wrapper must not grow the frame without end.
      await openById('v1');
      await sleep(1500);
      const vh = () => js("return Math.round(document.querySelector('#msgs .cmsg.open .mframe').getBoundingClientRect().height)");
      const before = await vh();
      // Theme switch remounts the frame; it must settle again rather than grow on.
      await js("browser.storage.local.get('prefs').then((r) => browser.storage.local.set({ prefs: { ...r.prefs, theme: 'dark' } }))");
      await sleep(3000);
      const afterTheme = await vh();
      await sleep(2500);
      console.log(`  full-height layout: frame px ${before} → after theme switch ${afterTheme} → later ${await vh()} | window px ${await js('return innerHeight')}`);
      await js("browser.storage.local.get('prefs').then((r) => browser.storage.local.set({ prefs: { ...r.prefs, theme: 'system' } }))");

      // New mail notifies (per message): two arrivals, one poll.
      const sounds = () => js("return browser.storage.local.get('debugLog').then((r) => (r.debugLog ?? []).filter((l) => l.includes('sound: played')).length)");
      const soundsBefore = await sounds();
      fake.arrive();
      fake.arrive();
      await js("return browser.runtime.sendMessage('poll-now')");
      await sleep(1500);
      console.log(`  new mail: sound played ${(await sounds()) - soundsBefore}× for 2 new messages (once per batch)`);

      // --- Compose -----------------------------------------------------------------------------
      fake.reset();
      await reloadFresh();
      await sleep(1800);
      const cq = (sel) => driver.findElement(By.css(sel));
      const cstate = () => js(`const c = document.querySelector('.composer'); return c ? { where: c.parentElement.id, status: c.querySelector('.cstatus').textContent,
        to: [...c.querySelectorAll('.chips[data-field="to"] .chip')].map((x) => JSON.parse(x.dataset.addr).email),
        cc: [...c.querySelectorAll('.chips[data-field="cc"] .chip')].map((x) => JSON.parse(x.dataset.addr).email),
        subject: c.querySelector('.csubject').value } : null`);
      const lastEmail = () => fake.data.emails.at(-1);
      const lastSub = () => fake.data.submissions.at(-1);

      // Typing a recipient: suggestions, never a half-typed chip (the background snapshot used to make one).
      await cq('#compose').click();
      await sleep(1200);
      console.log('  compose opens in place:', JSON.stringify(await js("return { slide: getComputedStyle(document.getElementById('slider')).transitionDuration, rail: ['railCompose', 'railMail'].filter((id) => document.getElementById(id).classList.contains('on')) }")));
      await cq('.composer .chips[data-field="to"] input').sendKeys('a');
      await sleep(1500);
      const typed = await js(`const c = document.querySelector('.composer'); return { chips: c.querySelectorAll('.chip').length, input: c.querySelector('.chips[data-field="to"] input').value,
        suggestions: [...c.querySelectorAll('.suggest:not([hidden]) .sitem')].map((b) => b.querySelector('span').textContent),
        from: [...c.querySelectorAll('.cfrom option')].map((o) => o.textContent), fromSelected: c.querySelector('.cfrom').selectedOptions[0]?.textContent,
        sig: c.querySelector('.cbody .sig')?.textContent, rowHeights: [...c.querySelectorAll('.cfield:not([hidden])')].map((r) => Math.round(r.getBoundingClientRect().height)),
        rowParts: [...c.querySelector('.cfield').children].map((x) => x.tagName + '.' + x.className + ':' + Math.round(x.getBoundingClientRect().height) + ' pad=' + getComputedStyle(x).padding + ' m=' + getComputedStyle(x).margin + ' lh=' + getComputedStyle(x).lineHeight),
        rowStyle: (() => { const cs = getComputedStyle(c.querySelector('.cfield')); return [cs.padding, cs.minHeight, cs.height, cs.display]; })() }`);
      await shot('compose-suggest');
      await cq('.composer .chips[data-field="to"] input').sendKeys(Key.ENTER);
      await sleep(300);
      console.log('  typing "a":', JSON.stringify(typed), '| after Enter:', JSON.stringify((await cstate()).to));
      await js("const s = document.querySelector('.composer .cfrom'); s.value = 'id2'; s.dispatchEvent(new Event('change', { bubbles: true }))");
      await sleep(300);
      console.log('  From → work: signature now', JSON.stringify(await js("return document.querySelector('.composer .cbody .sig')?.textContent")));
      await js("document.querySelector('.composer .cdiscard').click()");
      await sleep(800);

      // New message with a Bcc: sent with a hold; Bcc only on the envelope.
      await cq('#compose').click();
      await sleep(1200);
      await cq('.composer .chips[data-field="to"] input').sendKeys('sam@example.org', Key.ENTER);
      await cq('.composer [data-show="bcc"]').click();
      await cq('.composer .chips[data-field="bcc"] input').sendKeys('secret@example.com', Key.ENTER);
      await cq('.composer .csubject').sendKeys('Hello from the test');
      await cq('.composer .cbody').sendKeys('Hi Sam, this is a test.');
      console.log('  compose new:', JSON.stringify(await cstate()), '| composing:', await js("return document.body.classList.contains('composing')"));
      await cq('.composer .cbody').sendKeys(Key.chord(Key.CONTROL, Key.ENTER));
      await sleep(1800);
      const sentEmail = fake.data.emails.find((e) => e.subject === 'Hello from the test' && e.mailboxIds['mb-sent']);
      console.log(`  sent: toast="${await toastText()}" undo=${await js("return !document.getElementById('toastUndo').hidden")} | in Sent=${Boolean(sentEmail)} | rcptTo=${lastSub()?.envelope.rcptTo.map((r) => r.email).join(',')} | hold=${JSON.stringify(lastSub()?.envelope.mailFrom.parameters)} | bcc header=${JSON.stringify(sentEmail?.bcc ?? null)} | to header=${sentEmail?.to.map((a) => a.email)}`);

      // Undo: cancelled on the server, back in Drafts, composer reopened.
      await cq('#toastUndo').click();
      await sleep(1800);
      const back = fake.data.emails.find((e) => e.subject === 'Hello from the test');
      console.log(`  undo: submission ${lastSub()?.undoStatus} | message in ${Object.keys(back?.mailboxIds ?? {})} ${Object.keys(back?.keywords ?? {})} | composer:`, JSON.stringify(await cstate()));
      await js("document.querySelector('.composer .cdiscard').click()");
      await sleep(1200);
      console.log(`  discard: draft gone=${!fake.data.emails.some((e) => e.subject === 'Hello from the test')} | toast="${await toastText()}" | composing=${await js("return document.body.classList.contains('composing')")}`);

      // Schedule send: the caret menu, "Tomorrow" → held until then; Undo cancels.
      await cq('#compose').click();
      await sleep(1000);
      await cq('.composer .chips[data-field="to"] input').sendKeys('sam@example.org', Key.ENTER);
      await cq('.composer .csubject').sendKeys('Scheduled one');
      await cq('.composer .ccaret').click();
      await sleep(300);
      await shot('compose-schedule');
      const choices = await js("return [...document.querySelectorAll('.composer .cschedule .mi')].map((b) => b.querySelector('.label').textContent + (b.disabled ? ' (off)' : '') + ' ' + (b.querySelector('.hint')?.textContent ?? ''))");
      await js("[...document.querySelectorAll('.composer .cschedule .mi')].find((b) => b.textContent.includes('Tomorrow')).click()");
      await sleep(1800);
      const sched = lastSub();
      console.log(`  schedule: menu=${JSON.stringify(choices)} | toast="${await toastText()}" | HOLDUNTIL=${sched?.envelope.mailFrom.parameters?.HOLDUNTIL} (${new Date(sched?.envelope.mailFrom.parameters?.HOLDUNTIL).toString().slice(0, 21)}) | ${sched?.undoStatus}`);
      await cq('#toastUndo').click();
      await sleep(1500);
      console.log(`  schedule undo: ${lastSub()?.undoStatus}`);
      await js("document.querySelector('.composer .cdiscard').click()");
      await sleep(800);

      // Autosave, then the dropdown "closing" mid-message: restored from the local snapshot.
      await cq('#compose').click();
      await sleep(1000);
      await cq('.composer .csubject').sendKeys('Draft that survives');
      await cq('.composer .cbody').sendKeys('Half written…');
      await sleep(5000);
      const draft = fake.data.emails.find((e) => e.subject === 'Draft that survives');
      console.log(`  autosave: server draft in ${Object.keys(draft?.mailboxIds ?? {})} ${Object.keys(draft?.keywords ?? {})}`);
      await cq('.composer .csubject').sendKeys(' (edited)');
      await sleep(400);
      await reloadFresh();
      await sleep(2500);
      console.log('  reopened dropdown:', JSON.stringify(await cstate()));
      await js("document.querySelector('.composer .cclose').click()");
      await sleep(1500);
      const drafts = fake.data.emails.filter((e) => e.subject?.startsWith('Draft that survives'));
      console.log(`  close: toast="${await toastText()}" | drafts on server=${drafts.map((d) => d.subject).join(' / ')} | snapshot cleared=${await js("return browser.storage.local.get('compose').then((r) => !r.compose)")}`);

      // An untouched compose (new or reply) put away with Esc doesn't come back, or leave a draft.
      const draftsBefore = fake.data.emails.filter((e) => e.mailboxIds['mb-drafts']).length;
      await cq('#compose').click();
      await sleep(900);
      await cq('.composer .cbody').sendKeys(Key.ESCAPE);
      await sleep(800);
      await reloadFresh();
      await sleep(2200);
      const afterNew = await cstate();
      await openById('e2');
      await pressKey('r');
      await sleep(1000);
      await cq('.composer .cbody').sendKeys(Key.ESCAPE);
      await sleep(800);
      await reloadFresh();
      await sleep(2200);
      console.log(`  untouched compose put away: new comes back=${Boolean(afterNew)} | reply comes back=${Boolean(await cstate())} | drafts added=${fake.data.emails.filter((e) => e.mailboxIds['mb-drafts']).length - draftsBefore}`);

      // A server that refuses the hold, or ignores it: still sent once, no Undo, no drafts left.
      for (const mode of ['reject', 'ignore']) {
        fake.setHoldMode(mode);
        await reloadFresh();
        await sleep(1800);
        await cq('#compose').click();
        await sleep(900);
        await cq('.composer .chips[data-field="to"] input').sendKeys('sam@example.org', Key.ENTER);
        await cq('.composer .csubject').sendKeys(`Hold ${mode}`);
        await cq('.composer .cbody').sendKeys(Key.chord(Key.CONTROL, Key.ENTER));
        await sleep(1800);
        const copies = fake.data.emails.filter((e) => e.subject === `Hold ${mode}`);
        console.log(`  hold ${mode}: toast="${await toastText()}" undo=${await js("return !document.getElementById('toastUndo').hidden")} | copies: ${copies.map((c) => Object.keys(c.mailboxIds).join('+')).join(', ')}`);
      }
      fake.setHoldMode('ok');

      // Reply (inline, threaded) and reply all (never to yourself).
      await openById('e1');
      await pressKey('r');
      await sleep(1200);
      const rs = await cstate();
      await shot('compose-reply');
      await cq('.composer .cbody').sendKeys('y d ! — typing shortcuts in a reply does nothing');
      await sleep(500);
      console.log(`  reply: ${JSON.stringify(rs)} | quote=${await js("return Boolean(document.querySelector('.composer .cbody blockquote'))")} | typing "y" left e1 in ${boxes('e1')}`);
      await cq('.composer .cbody').sendKeys(Key.chord(Key.CONTROL, Key.ENTER));
      await sleep(1800);
      const reply = lastEmail();
      console.log(`  reply sent: subject="${reply.subject}" inReplyTo=${JSON.stringify(reply.inReplyTo)} references=${JSON.stringify(reply.references)} sameThread=${reply.threadId === 't1'}`);
      await openById('e1');
      await pressKey('a');
      await sleep(1200);
      console.log('  reply all:', JSON.stringify(await cstate()));
      await js("document.querySelector('.composer .cdiscard').click()");
      await sleep(800);

      // Replying to the hostile message: the quote is sanitised into the editor (no scripts, no loads).
      await openById('x1');
      await pressKey('r');
      await sleep(1500);
      const quoted = await js("return document.querySelector('.composer .cbody').innerHTML");
      console.log(`  hostile reply: pwned=${JSON.stringify(await js('return window.__pwned ?? null'))} | server hits=${JSON.stringify(fake.pwned)} | quote has: onerror=${/onerror/i.test(quoted)} svg=${/<svg/i.test(quoted)} jsUrl=${/(href|src)\s*=\s*"\s*(javascript|data:text)/i.test(quoted)} remoteImg=${/<img[^>]+src="http/i.test(quoted)} style=${/<style|style=/i.test(quoted)} form=${/<form/i.test(quoted)}`);
      await js("document.querySelector('.composer .cdiscard').click()");
      await sleep(800);

      // --- Attachments ---------------------------------------------------------------------------
      fake.reset();
      await openById('e1');
      const atts = await js("return [...document.querySelectorAll('#msgs .cmsg.open .mfoot .att')].map((b) => b.textContent.trim())");
      await js("document.querySelector('#msgs .cmsg.open .mfoot .att').click()");
      await sleep(2000);
      const saved = fs.readdirSync(DOWNLOADS);
      // Firefox opens a downloaded PDF in a new tab (its normal behaviour): close it, back to the popup.
      await chrome(`const w = ${MAIN_WINDOW}; for (const t of [...w.gBrowser.tabs]) if (t.linkedBrowser.currentURI.spec.startsWith('file:')) w.gBrowser.removeTab(t);`);
      await driver.switchTo().window(await driver.getWindowHandle());
      console.log(`  reader attachments: ${JSON.stringify(atts)} | download → server served ${JSON.stringify(fake.downloads)}, saved ${JSON.stringify(saved)} (${saved[0] ? fs.statSync(path.join(DOWNLOADS, saved[0])).size : 0} bytes)`);
      // Attach a file in compose and send it.
      const upload = path.join(DOWNLOADS, 'hello.txt');
      fs.writeFileSync(upload, 'Hello attachment\n');
      await reloadFresh();
      await sleep(1800);
      await cq('#compose').click();
      await sleep(1000);
      await cq('.composer .chips[data-field="to"] input').sendKeys('sam@example.org', Key.ENTER);
      await cq('.composer .csubject').sendKeys('With a file');
      await cq('.composer .cfile').sendKeys(upload);
      await sleep(1500);
      const chips = await js("return [...document.querySelectorAll('.composer .catt')].map((c) => c.textContent.trim())");
      await cq('.composer .cbody').sendKeys(Key.chord(Key.CONTROL, Key.ENTER));
      await sleep(1800);
      const withFile = fake.data.emails.find((e) => e.subject === 'With a file');
      console.log(`  compose attach: chips=${JSON.stringify(chips)} | sent attachments=${JSON.stringify(withFile?.attachments.map((a) => a.name + ':' + a.size))} | blob=${fake.blobs.get(withFile?.attachments[0]?.blobId)?.data.toString().trim()}`);
      // Forwarding keeps the original's attachments.
      await openById('e1');
      await pressKey('f');
      await sleep(1200);
      const fwdChips = await js("return [...document.querySelectorAll('.composer .catt')].map((c) => c.textContent.trim())");
      await cq('.composer .chips[data-field="to"] input').sendKeys('sam@example.org', Key.ENTER);
      await cq('.composer .cbody').sendKeys(Key.chord(Key.CONTROL, Key.ENTER));
      await sleep(1800);
      const fwd = fake.data.emails.find((e) => e.subject === 'Fwd: Quarterly planning notes');
      console.log(`  forward: chips=${JSON.stringify(fwdChips)} | sent attachments=${JSON.stringify(fwd?.attachments.map((a) => a.blobId))}`);

      // Move to (m): the folder list, filtered; undo puts it back.
      fake.reset();
      await openById('e2');
      await pressKey('m');
      await sleep(600);
      const moveChoices = await js("return [...document.querySelectorAll('#moveList [data-target]')].map((b) => b.textContent.trim())");
      await driver.findElement(By.css('#moveFilter')).sendKeys('wor', Key.ENTER);
      await sleep(1500);
      console.log(`  move: choices=${JSON.stringify(moveChoices)} | e2 in ${boxes('e2')} | toast="${await toastText()}" | reader closed=${!(await js("return document.body.classList.contains('reading')"))}`);
      await cq('#toastUndo').click();
      await sleep(1500);
      console.log(`  move undo: e2 in ${boxes('e2')}`);

      // An image embedded in the message (cid:) shows, from the message's own data.
      await openById('i1');
      await sleep(1500);
      console.log('  embedded image:', JSON.stringify(await js(`const d = document.querySelector('#msgs .cmsg.open .mframe').contentDocument; const img = d.querySelector('img');
        return { src: img?.getAttribute('src')?.slice(0, 22), loaded: img ? img.complete && img.naturalWidth > 0 : false, served: ${JSON.stringify('x')} }`)), '| server served', JSON.stringify(fake.downloads.filter((b) => b === 'blob-logo')));

      // --- Folders -------------------------------------------------------------------------------
      fake.reset();
      await reloadFresh();
      await sleep(2000);
      const folderMenu = () => js("return [...document.querySelectorAll('#folderList [data-box]')].map((b) => ' '.repeat(Math.round((parseInt(b.style.paddingLeft) - 12) / 14)) + b.querySelector('.label').textContent + (b.querySelector('.hint').textContent ? '(' + b.querySelector('.hint').textContent + ')' : ''))");
      const tab = () => js("return document.getElementById('folderName').textContent");
      await pressKey('g');
      await sleep(700);
      console.log('  folders:', JSON.stringify(await folderMenu()));
      await driver.findElement(By.css('#folderFilter')).sendKeys('wor');
      await sleep(200);
      console.log('  filter "wor":', JSON.stringify(await folderMenu()));
      await driver.findElement(By.css('#folderFilter')).sendKeys(Key.ENTER);
      await sleep(1500);
      await js("document.querySelector('.tabs [data-v=\"inbox\"]').click()");
      await sleep(1500);
      console.log(`  Work (all): tab="${await tab()}" rows=${(await rows()).join(' ')}`);
      await js("document.querySelector('.tabs [data-v=\"unread\"]').click()");
      await sleep(1500);
      console.log(`  Work (unread): rows=${(await rows()).join(' ')} | hover=${await js("return [...document.querySelectorAll('#body li:first-child .hover-actions [data-act]')].map((b) => b.dataset.act).join(',')")}`);
      const placeholder = () => js("return document.getElementById('q').placeholder");
      console.log(`  search label: "${await placeholder()}"`);
      // All: every folder but Trash and Spam; no Archive there; search says so.
      await js("document.querySelector('.tabs [data-v=\"all\"]').click()");
      await sleep(1500);
      const allRows = await rows();
      const inTrashOrSpam = allRows.filter((r) => /^(z\d)/.test(r));
      console.log(`  All: rows=${allRows.length} (Work's w1: ${allRows.some((r) => r.startsWith('w1'))}, Trash/Spam: ${inTrashOrSpam.length}) | hover=${await js("return [...document.querySelectorAll('#body li:first-child .hover-actions [data-act]')].map((b) => b.dataset.act).join(',')")} | search label: "${await placeholder()}"`);
      await driver.findElement(By.css('#q')).sendKeys('notes', Key.ENTER);
      await sleep(1500);
      const resultsLine = () => js("return document.querySelector('#body .results')?.textContent ?? document.querySelector('#body .msg')?.textContent");
      console.log('  search All "notes":', await resultsLine());
      // Part of a word finds it (as Fastmail does when you type).
      await js("const q = document.getElementById('q'); q.value = 'plann'; q.dispatchEvent(new Event('input'))");
      await sleep(1500);
      console.log('  search "plann":', await resultsLine());
      // Search is like a tab: another tab leaves the results, the search box brings them back.
      await js("document.querySelector('.tabs [data-v=\"unread\"]').click()");
      await sleep(1200);
      const leftTo = await js("return document.body.classList.contains('searching') ? 'still searching' : 'tab list'");
      await js("document.getElementById('q').click()");
      await sleep(500);
      console.log(`  search as a tab: Unread → ${leftTo} | search box → ${await resultsLine()}`);
      await js("document.getElementById('qClear').click()");
      await sleep(500);
      await js("document.querySelector('.tabs [data-v=\"all\"]').click()");
      await sleep(1200);
      // The folder tab: the first click shows it, a second opens the folder menu.
      await js("document.querySelector('.tabs [data-v=\"inbox\"]').click()");
      await sleep(1200);
      const firstClick = await js("return document.getElementById('folderMenu').hidden ? 'menu closed' : 'menu open'");
      await js("document.querySelector('.tabs [data-v=\"inbox\"]').click()");
      await sleep(400);
      console.log(`  folder tab: first click → ${firstClick}, label "${await placeholder()}" | second click → ${await js("return document.getElementById('folderMenu').hidden ? 'menu closed' : 'menu open'")} | chevron in the tab: ${await js("return Boolean(document.getElementById('folderBtn').closest('button[data-v=\"inbox\"]'))")}`);
      await pressKey(Key.ESCAPE);
      const goTo = async (name) => {
        await js("document.getElementById('folderBtn').click()");
        await sleep(500);
        await js(`[...document.querySelectorAll('#folderList [data-box]')].find((b) => b.querySelector('.label').textContent === '${name}').click()`);
        await sleep(1500);
        // (Clicking the folder tab while it's showing opens the folder menu, so only if it isn't.)
        await js("const t = document.querySelector('.tabs [data-v=\"inbox\"]'); if (!t.classList.contains('on')) t.click()");
        await sleep(1500);
      };
      await goTo('Spam');
      const spamUi = await js("return { rows: [...document.querySelectorAll('#body li[data-id]')].map((li) => li.dataset.id), hover: [...document.querySelectorAll('#body li:first-child .hover-actions [data-act]')].map((b) => b.dataset.act).join(','), bulk: [...document.querySelectorAll('#bulk [data-act]')].filter((b) => !b.hidden).map((b) => b.dataset.act + ':' + b.textContent.trim()).join(',') }");
      await js("document.querySelector('#body li[data-id=\"z2\"] [data-act=\"notspam\"]').click()");
      await sleep(1200);
      console.log(`  Spam: ${JSON.stringify(spamUi)} | not spam → z2 in ${boxes('z2')} ${kw('z2')} | toast="${await toastText()}"`);
      await goTo('Trash');
      const trashUi = await js("return { rows: [...document.querySelectorAll('#body li[data-id]')].map((li) => li.dataset.id), hover: [...document.querySelectorAll('#body li:first-child .hover-actions [data-act]')].map((b) => b.dataset.act).join(',') }");
      await js("document.querySelector('#body li[data-id=\"z3\"] [data-act=\"restore\"]').click()");
      await sleep(1200);
      const restored = boxes('z3');
      await js("document.querySelector('#body li[data-id=\"z1\"] [data-act=\"delete\"]').click()");
      await sleep(500);
      const confirmText = await toastText();
      const keptUntilConfirmed = fake.data.emails.some((e) => e.id === 'z1');
      await driver.findElement(By.css('#toastUndo')).click();
      await sleep(1200);
      console.log(`  Trash: ${JSON.stringify(trashUi)} | restore → z3 in ${restored} | delete asks "${confirmText}" (kept until confirmed: ${keptUntilConfirmed}) → gone: ${!fake.data.emails.some((e) => e.id === 'z1')}`);
      await goTo('Drafts');
      await js("document.querySelector('#body li[data-id=\"d1\"] .subj').click()");
      await sleep(1500);
      console.log('  Drafts: open d1 →', JSON.stringify(await cstate()));
      await cq('.composer .cbody').sendKeys(Key.ESCAPE);
      await sleep(1000);
      console.log(`  put away untouched: d1 kept=${fake.data.emails.some((e) => e.id === 'd1')} | composing=${await js("return document.body.classList.contains('composing')")}`);
      await goTo('Inbox');
      console.log(`  back to Inbox: tab="${await tab()}" rows=${(await rows()).length}`);

      // --- Compose is its own view: from any app; set aside when switching; Compose brings it back.
      await reloadFresh();
      await sleep(1500);
      const vstate = () => js(`return { app: document.body.dataset.app, shown: Boolean(document.querySelector('#composeNew .composer')?.offsetParent),
        subject: document.querySelector('#composeNew .csubject')?.value ?? null, waiting: document.getElementById('railCompose').classList.contains('waiting'),
        on: [...document.querySelectorAll('.rail-btn.on')].map((b) => b.id.replace('rail', '')).join() }`);
      await js("document.getElementById('railContacts').click()");
      await sleep(800);
      await js("document.getElementById('railCompose').click()");
      await sleep(1200);
      const fromContacts = await vstate();
      await driver.findElement(By.css('#composeNew .csubject')).sendKeys('Set aside');
      await js("document.getElementById('railCalendar').click()");
      await sleep(1500);
      const toCalendar = await vstate();
      await js("document.getElementById('railCompose').click()");
      await sleep(800);
      const backAgain = await vstate();
      await js("document.getElementById('railMail').click()");
      await sleep(800);
      const toMail = await vstate();
      const listShown = await js("return !document.body.classList.contains('reading') && Boolean(document.getElementById('listPane').offsetParent)");
      console.log('  compose smoke:', JSON.stringify({ fromContacts, toCalendar, backAgain, toMail, listShown }));
      console.log('  logo menu (links to Fastmail): highlighted =', await js("return document.querySelectorAll('#appsMenu .app.on').length"), '| all links =', await js("return [...document.querySelectorAll('#appsMenu .app')].every((b) => b.dataset.app)"));
      await js("document.getElementById('railCompose').click()");
      await sleep(500);
      await driver.findElement(By.css('#composeNew .cbody')).sendKeys(Key.ESCAPE);
      await sleep(1200);
      console.log('  put away:', JSON.stringify(await vstate()));

      // --- Calendar ------------------------------------------------------------------------------
      await reloadFresh();
      await sleep(1500);
      await driver.findElement(By.css('#railCalendar')).click();
      await sleep(3500);
      const calState = () => js(`return { title: document.getElementById('calTitle').textContent, msg: document.getElementById('calMsg').hidden ? '' : document.getElementById('calMsg').textContent.trim(),
        events: [...document.querySelectorAll('#calHost .ec-event')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()),
        calendars: [...document.querySelectorAll('#calChips .calchip')].map((c) => c.textContent.trim() + (c.classList.contains('off') ? ' (off)' : '')) }`);
      const agenda = await calState();
      console.log('  calendar agenda:', JSON.stringify(agenda));
      // Reopened: what was there shows at once (from the cache) while it checks again.
      await driver.navigate().refresh();
      const t0 = Date.now();
      let cachedAt;
      for (let i = 0; i < 40 && !cachedAt; i++) {
        if ((await calState()).events.length) cachedAt = Date.now() - t0;
        else await sleep(50);
      }
      console.log(`  reopened calendar: events shown after ${cachedAt ?? 'over 2000'} ms (cached)`);
      await sleep(1500);
      // Reminders (background): the next day's are scheduled, and the one due at start was shown.
      console.log('  reminders:', JSON.stringify(await driver.executeAsyncScript(`const done = arguments[arguments.length - 1];
        browser.storage.session.get(['calDue', 'calFired']).then((r) => done({ due: Object.values(r.calDue ?? {}).map((d) => d.title),
          shown: Object.keys(r.calFired ?? {}).map((k) => k.split('#')[0].split('/').pop()) }));`)));
      await shot('calendar-agenda');
      // Turn Work off: its events go.
      await sleep(300);
      await js("[...document.querySelectorAll('#calChips .calchip')].find((c) => c.textContent.includes('Work'))?.click()");
      await sleep(2000);
      console.log('  Work off:', JSON.stringify((await calState()).events), '| chips:', JSON.stringify((await calState()).calendars));
      await js("[...document.querySelectorAll('#calChips .calchip')].find((c) => c.textContent.includes('Work'))?.click()");
      await sleep(2000);
      // Details card.
      await js("[...document.querySelectorAll('#calHost .ec-event')].find((e) => e.textContent.includes('Dentist'))?.click()");
      await sleep(500);
      console.log('  details:', JSON.stringify(await js("return document.getElementById('calEvent').hidden ? null : document.getElementById('calEvent').innerText.replace(/\\n+/g, ' | ')")));
      await shot('calendar-details');
      await pressKey(Key.ESCAPE);
      console.log('  Esc closes details:', await js("return document.getElementById('calEvent').hidden"));
      await pressKey('m');
      await sleep(2000);
      const month = await calState();
      console.log(`  month (m): title="${month.title}" events=${month.events.length}`);
      await shot('calendar-month');
      await pressKey('w');
      await sleep(2000);
      console.log(`  week (w): title="${(await calState()).title}" events=${(await calState()).events.length} | sideways overflow: ${await js("return [...document.querySelectorAll('#calHost *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'hidden' && getComputedStyle(el).overflowX !== 'visible').map((el) => el.className).join() || 'none'")}`);
      await shot('calendar-week');
      // Hover: an instant tooltip. Double-click an empty time: a draft event there and its form.
      // (The grid scrolls with the time of day, so the event may start out of view.)
      const firstEvent = await driver.findElement(By.css('#calHost .ec-time-grid .ec-body .ec-event'));
      await js('arguments[0].scrollIntoView({ block: "center" })', firstEvent);
      await driver.actions({ async: true }).move({ origin: firstEvent }).perform();
      await sleep(200);
      console.log('  tooltip:', JSON.stringify(await js("const t = document.getElementById('calTip'); return t.hidden ? null : t.innerText.replace(/\\n+/g, ' | ')")));
      const day = await driver.findElement(By.css('#calHost .ec-time-grid .ec-body .ec-day:nth-of-type(2)'));
      await driver.actions({ async: true }).move({ origin: day }).click().perform();
      await sleep(300);
      const afterOneClick = await js("return document.getElementById('calEvent').hidden ? 'nothing' : 'form'");
      await driver.actions({ async: true }).move({ origin: day }).doubleClick().perform();
      await sleep(600);
      console.log(`  one click: ${afterOneClick} | double-click: ${JSON.stringify(await js("const f = document.querySelector('#calEvent form'); return f ? { starts: f.elements.namedItem('sd').value + ' ' + f.elements.namedItem('st').value, ends: f.elements.namedItem('et').value, draftOnGrid: document.querySelectorAll('#calHost .ec-draft').length } : null"))}`);
      await shot('calendar-draft');
      await pressKey(Key.ESCAPE);
      console.log('  Esc: form closed =', await js("return document.getElementById('calEvent').hidden"), '| draft gone =', await js("return !document.querySelector('#calHost .ec-draft')"));
      await pressKey('a');
      await sleep(1500);

      // New event: Create shows once something's typed; moving the start keeps the hour.
      const objs = () => [...fake.calendar.objects.entries()];
      const findObj = (text) => objs().find(([, o]) => o.ics.includes(text));
      const setField = (name, value) =>
        js(`const f = document.querySelector('#calEvent form').elements.namedItem(arguments[0]); f.value = arguments[1];
          f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true }));`, name, value);
      const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const inDays = (n) => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + n);
      const saveShown = () => js("const b = document.querySelector('#calEvent [data-save]'); return b && !b.hidden ? b.textContent : null");
      await driver.findElement(By.css('#calNew')).click();
      await sleep(400);
      const createBefore = await saveShown();
      await driver.findElement(By.css('#calEvent input[name="title"]')).sendKeys('Lunch with Sam');
      await setField('sd', ymd(inDays(1)));
      await setField('st', '12:00');
      await setField('location', 'Corner Cafe');
      await js("document.querySelector('#calEvent [data-addalarm]').click()");
      const ends = await js("const f = document.querySelector('#calEvent form'); return f.elements.namedItem('ed').value + ' ' + f.elements.namedItem('et').value");
      await shot('calendar-new');
      console.log(`  new event: save before typing=${createBefore} | after="${await saveShown()}" | end follows start → ${ends === `${ymd(inDays(1))} 13:00`}`);
      await js("document.querySelector('#calEvent [data-save]').click()");
      await sleep(2000);
      const created = findObj('Lunch with Sam');
      const ics = created?.[1].ics ?? '';
      console.log(`  created: in=${created?.[0].split('/').slice(-2, -1)} | tzid+vtimezone=${/DTSTART;TZID=[^:]+:\d{8}T120000/.test(ics) && /BEGIN:VTIMEZONE/.test(ics)} | 1h=${/DTEND;TZID=[^:]+:\d{8}T130000/.test(ics)} | reminder=${/TRIGGER:-PT10M/.test(ics)} | place=${ics.includes('LOCATION:Corner Cafe')} | form closed=${await js("return document.getElementById('calEvent').hidden")} | shown=${(await calState()).events.some((e) => e.includes('Lunch with Sam'))}`);

      // Edit: rename and move to Work (a copy in Work, then the original goes).
      const openEvent = async (text) => {
        await js("[...document.querySelectorAll('#calHost .ec-event')].find((e) => e.textContent.includes(arguments[0]))?.click()", text);
        await sleep(500);
      };
      await openEvent('Lunch with Sam');
      await js("document.querySelector('#calEvent [data-edit]').click()");
      await sleep(300);
      const editBefore = await saveShown();
      await setField('title', 'Lunch with Sam and Alex');
      await setField('cal', [...(await js("return [...document.querySelectorAll('#calEvent select[name=\"cal\"] option')].map((o) => o.value)"))].find((u) => u.includes('/work/')));
      await shot('calendar-edit');
      await js("document.querySelector('#calEvent [data-save]').click()");
      await sleep(2000);
      const moved = findObj('Lunch with Sam and Alex');
      console.log(`  edited: save before change=${editBefore} | now in=${moved?.[0].split('/').slice(-2, -1)} | old copy gone=${!objs().some(([k, o]) => k.includes('/personal/') && o.ics.includes('Lunch with Sam'))} | reminder kept=${/TRIGGER:-PT10M/.test(moved?.[1].ics ?? '')} | sequence=${/SEQUENCE/.test(moved?.[1].ics ?? '') ? 'set' : 'none'}`);

      // Changed elsewhere meanwhile: the delete is refused, not forced.
      await openEvent('Lunch with Sam and Alex');
      if (moved) fake.calendar.objects.get(moved[0]).etag = '"changed-elsewhere"';
      await js("document.querySelector('#calEvent [data-delete]').click()");
      await sleep(200);
      await js("document.querySelector('#calEvent [data-really]').click()");
      await sleep(1000);
      console.log(`  conflict: ${JSON.stringify(await js("return document.querySelector('#calEvent .ceerr')?.textContent"))} | still there=${Boolean(findObj('Lunch with Sam and Alex'))}`);
      await pressKey(Key.ESCAPE);
      await pressKey('m');
      await sleep(1500);
      await pressKey('a');
      await sleep(1500);
      await openEvent('Lunch with Sam and Alex');
      await js("document.querySelector('#calEvent [data-delete]').click()");
      await sleep(200);
      await shot('calendar-delete');
      await js("document.querySelector('#calEvent [data-really]').click()");
      await sleep(1500);
      console.log(`  deleted: gone=${!findObj('Lunch with Sam')} | shown=${(await calState()).events.some((e) => e.includes('Lunch with Sam'))}`);

      // All day: the last day shown is inclusive, stored exclusive.
      await driver.findElement(By.css('#calNew')).click();
      await sleep(300);
      await driver.findElement(By.css('#calEvent input[name="title"]')).sendKeys('Day off');
      await js("document.querySelector('#calEvent input[name=\"allDay\"]').click()");
      await setField('sd', ymd(inDays(2)));
      await setField('ed', ymd(inDays(2)));
      await js("document.querySelector('#calEvent [data-save]').click()");
      await sleep(1500);
      const dayOff = findObj('Day off')?.[1].ics ?? '';
      const d8 = (d) => ymd(d).replaceAll('-', '');
      console.log(`  all day: start=${dayOff.includes(`DTSTART;VALUE=DATE:${d8(inDays(2))}`)} | end next day=${dayOff.includes(`DTEND;VALUE=DATE:${d8(inDays(3))}`)} | no zone=${!dayOff.includes('VTIMEZONE')}`);
      // Repeating events: no Edit or Delete yet.
      await openEvent('Team standup');
      console.log(`  repeating: actions=${await js("return document.querySelectorAll('#calEvent .ceactions button').length")}`);
      await pressKey(Key.ESCAPE);
      await sleep(300);
      await driver.findElement(By.css('#railMail')).click();
      await sleep(800);

      // --- Files ---------------------------------------------------------------------------------
      await js("document.getElementById('railFiles').click()");
      await sleep(2000);
      const fstate = () => js(`return { trail: [...document.querySelectorAll('#filesTrail button, #filesTrail .here')].map((b) => b.textContent).join(' › '),
        names: [...document.querySelectorAll('#filesList .frow .fname')].map((n) => n.textContent), quota: document.getElementById('filesQuota').textContent,
        up: !document.getElementById('filesUp').hidden, imgsInList: document.querySelectorAll('#filesList img').length }`);
      const top = await fstate();
      console.log('  files:', JSON.stringify(top), '| pwned:', JSON.stringify(fake.pwned));
      await shot('files');
      const openName = (n) => js("[...document.querySelectorAll('#filesList .frow')].find((r) => r.querySelector('.fname').textContent === arguments[0])?.click()", n);
      await openName('Documents');
      await sleep(1500);
      const docs = await fstate();
      await openName('Projects');
      await sleep(1500);
      const projects = await fstate();
      await pressKey('u');
      await sleep(1200);
      console.log(`  Documents: ${JSON.stringify(docs.names)} | trail "${docs.trail}" | Projects trail "${projects.trail}" | u → "${(await fstate()).trail}"`);
      // Download a file with an accented, spaced name: same bytes as on the server.
      for (const f of fs.readdirSync(DOWNLOADS)) fs.rmSync(path.join(DOWNLOADS, f), { force: true });
      await openName('Résumé 2026.pdf');
      await sleep(2000);
      await chrome(`const w = ${MAIN_WINDOW}; for (const t of [...w.gBrowser.tabs]) if (t.linkedBrowser.currentURI.spec.startsWith('file:')) w.gBrowser.removeTab(t);`);
      await driver.switchTo().window(await driver.getWindowHandle());
      const got = fs.readdirSync(DOWNLOADS).find((f) => f.normalize().startsWith('Résumé'.normalize()));
      const same = got && fs.readFileSync(path.join(DOWNLOADS, got)).equals(fake.files.files.get('/files/Documents/Résumé 2026.pdf').body);
      console.log(`  download: saved "${got}" | same bytes: ${same}`);
      // Images preview inside (PNG yes; SVG never, it downloads).
      await js("[...document.querySelectorAll('#filesTrail button')].find((b) => b.textContent === 'Files').click()");
      await sleep(1200);
      await openName('Photos');
      await sleep(1500);
      await openName('beach.png');
      await sleep(1200);
      const prev = await js("const p = document.getElementById('filesPreview'); return p.hidden ? null : { name: p.querySelector('.fpname').textContent, img: Boolean(p.querySelector('img')?.naturalWidth) }");
      await shot('files-preview');
      await pressKey(Key.ESCAPE);
      await openName('logo.svg');
      await sleep(1500);
      await chrome(`const w = ${MAIN_WINDOW}; for (const t of [...w.gBrowser.tabs]) if (t.linkedBrowser.currentURI.spec.startsWith('file:')) w.gBrowser.removeTab(t);`);
      await driver.switchTo().window(await driver.getWindowHandle());
      console.log(`  preview png: ${JSON.stringify(prev)} | Esc closed | svg previewed: ${await js("return !document.getElementById('filesPreview').hidden")}, downloaded: ${fs.readdirSync(DOWNLOADS).some((f) => f.startsWith('logo'))} | pwned: ${JSON.stringify(fake.pwned)}`);
      // No Calendar/Files password: says so, with a way to settings.
      await driver.executeAsyncScript(`const done = arguments[arguments.length - 1];
        browser.storage.session.get('unlocked').then(({ unlocked }) => { window.__keepUnlocked = unlocked;
          return browser.storage.session.set({ unlocked: { ...unlocked, secrets: { ...unlocked.secrets, davPassword: undefined } } }); }).then(done);`);
      await js("document.getElementById('refresh').click()");
      await sleep(1500);
      console.log('  files without password:', JSON.stringify(await js("const m = document.getElementById('filesMsg'); return m.hidden ? null : m.textContent.trim()")));
      await driver.executeAsyncScript(`const done = arguments[arguments.length - 1]; browser.storage.session.set({ unlocked: window.__keepUnlocked }).then(done);`);
      // Changes (slice 2): new folder, upload (and again: asks before replacing), rename, move, delete.
      await js("document.getElementById('refresh').click()");
      await sleep(1500);
      const fpaths = () => [...fake.files.files.keys()];
      const bar = () => js("const b = document.getElementById('filesBar'); return b.hidden ? '' : b.innerText.replace(/\\s+/g, ' ').trim()");
      const rowAction = (name, action) => js("const r = [...document.querySelectorAll('#filesList .frow')].find((r) => r.querySelector('.fname')?.textContent === arguments[0]); r?.querySelector('[data-fa=\"' + arguments[1] + '\"]').click()", name, action);
      const typeName = async (text) => {
        await js("document.querySelector('#filesList .fnameinput').select()");
        await driver.findElement(By.css('#filesList .fnameinput')).sendKeys(text, Key.ENTER);
        await sleep(1500);
      };
      await js("[...document.querySelectorAll('#filesTrail button')].find((b) => b.textContent === 'Files')?.click()");
      await sleep(1200);
      await js("document.getElementById('filesNew').click()");
      await sleep(300);
      await typeName('Reports');
      console.log(`  new folder: ${fpaths().includes('/files/Reports/')} | bar "${await bar()}"`);
      await openName('Reports');
      await sleep(1200);
      const upFile = path.join(DOWNLOADS, 'upload test.txt');
      fs.writeFileSync(upFile, 'uploaded from the test\n');
      await driver.findElement(By.css('#filesInput')).sendKeys(upFile);
      await sleep(2000);
      const up = fake.files.files.get('/files/Reports/upload test.txt');
      console.log(`  upload: on server=${Boolean(up)} same bytes=${up?.body.equals(fs.readFileSync(upFile))} | listed=${JSON.stringify((await fstate()).names)} | bar "${await bar()}"`);
      fs.writeFileSync(upFile, 'uploaded again\n');
      await driver.findElement(By.css('#filesInput')).sendKeys(upFile);
      await sleep(1500);
      const asked = await bar();
      await js("document.querySelector('#filesBar [data-bar=\"yes\"]')?.click()");
      await sleep(1500);
      console.log(`  upload again: asked "${asked}" → replaced=${fake.files.files.get('/files/Reports/upload test.txt')?.body.toString().trim() === 'uploaded again'}`);
      await rowAction('upload test.txt', 'rename');
      await sleep(300);
      const selectedPart = await js("const i = document.querySelector('#filesList .fnameinput'); return i.value.slice(i.selectionStart, i.selectionEnd)");
      await typeName('a/b.txt');
      const badNameMsg = await bar();
      await rowAction('upload test.txt', 'rename');
      await sleep(300);
      await typeName('renamed.txt');
      console.log(`  rename: selects "${selectedPart}" | "a/b.txt" → "${badNameMsg}" | renamed=${fpaths().includes('/files/Reports/renamed.txt') && !fpaths().includes('/files/Reports/upload test.txt')}`);
      await rowAction('renamed.txt', 'move');
      await sleep(300);
      const inPlace = await bar();
      await pressKey('u');
      await sleep(1200);
      await openName('Documents');
      await sleep(1200);
      await js("document.querySelector('#filesBar [data-bar=\"movehere\"]').click()");
      await sleep(1500);
      console.log(`  move: here "${inPlace}" → moved=${fpaths().includes('/files/Documents/renamed.txt') && !fpaths().includes('/files/Reports/renamed.txt')} | bar "${await bar()}"`);
      await rowAction('renamed.txt', 'rename');
      await sleep(300);
      await typeName('file2.txt');
      console.log(`  rename onto file2.txt: "${await bar()}" | both still there=${fpaths().includes('/files/Documents/renamed.txt') && fake.files.files.get('/files/Documents/file2.txt')?.body.toString() === 'two'}`);
      await rowAction('Projects', 'move');
      await sleep(300);
      await openName('Projects');
      await sleep(1200);
      console.log(`  move a folder into itself: "${await bar()}" | Move here offered=${await js("return Boolean(document.querySelector('#filesBar [data-bar=\"movehere\"]'))")}`);
      await pressKey(Key.ESCAPE);
      await pressKey('u');
      await sleep(1200);
      await rowAction('renamed.txt', 'delete');
      await sleep(300);
      const askDel = await bar();
      await js("document.querySelector('#filesBar [data-bar=\"yes\"]').click()");
      await sleep(1500);
      await pressKey('u');
      await sleep(1200);
      await rowAction('Reports', 'delete');
      await sleep(300);
      const askFolder = await bar();
      await js("document.querySelector('#filesBar [data-bar=\"yes\"]').click()");
      await sleep(1500);
      console.log(`  delete: asked "${askDel}" → gone=${!fpaths().includes('/files/Documents/renamed.txt')} | folder: asked "${askFolder}" → gone=${!fpaths().some((p) => p.startsWith('/files/Reports'))}`);
      console.log('  file writes:', JSON.stringify(fake.files.writes.map(([m]) => m)));
      await shot('files-changes');
      await js("document.getElementById('railMail').click()");
      await sleep(800);

      // Long conversation: earlier read messages closed, unread ones open, first unread in view.
      await openById('l4');
      await sleep(1500);
      await shot('conversation-long');
      if (process.env.MEASURE) console.log('  measure:', JSON.stringify(await js(`const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
        const c = document.querySelector('#msgs .cmsg.closed'); const o = document.querySelector('#msgs .cmsg.open');
        const cs = (el) => el ? getComputedStyle(el) : {};
        const fd = o.querySelector('.mframe').contentDocument; const p = fd.querySelector('p');
        return { closed: h(c), closedRow: h(c.querySelector('.tmsg')), closedHead: cs(c.querySelector('.mhead')).display, closedBody: cs(c.querySelector('.mbody')).display,
          closedChildren: [...c.children].map((x) => x.className + ':' + h(x) + ':' + cs(x).display),
          openHead: h(o.querySelector('.mhead')), headPad: cs(o.querySelector('.mhead')).padding, bodyMargin: getComputedStyle(fd.body).margin, pMargin: p ? getComputedStyle(p).margin : null,
          frameLeft: Math.round(o.querySelector('.mframe').getBoundingClientRect().left - o.getBoundingClientRect().left), textLeft: p ? Math.round(p.getBoundingClientRect().left) : null }`)));
      console.log('  long conversation:', JSON.stringify(await js(`const conv = document.getElementById('conv').getBoundingClientRect();
        const first = document.querySelector('#msgs .cmsg.unread, #msgs .cmsg[data-msg="l3"]').getBoundingClientRect();
        return { open: [...document.querySelectorAll('#msgs .cmsg.open')].map((m) => m.dataset.msg), closed: [...document.querySelectorAll('#msgs .cmsg.closed')].map((m) => m.dataset.msg),
          firstUnreadInView: first.top >= conv.top - 1 && first.top < conv.bottom, frames: [...document.querySelectorAll('#msgs .cmsg.open .mframe')].map((f) => Math.round(f.getBoundingClientRect().height)) }`)));
      const openNow = () => js("return [...document.querySelectorAll('#msgs .cmsg.open')].map((m) => m.dataset.msg).join(',')");
      await js("document.getElementById('expandAll').click()");
      await sleep(1500);
      const expanded = await openNow();
      const label = await js("return document.getElementById('expandAll').title");
      await js("document.getElementById('expandAll').click()");
      await sleep(500);
      console.log(`  expand all: open=${expanded} → "${label}" → open=${await openNow()}`);
      await drainConsole('actions');
    }

    console.log('\n# lock / unlock');
    {
      console.log('  lock button in the header:', await driver.executeScript("return document.getElementById('lockBtn').hidden ? 'hidden' : 'shown'"));
      await driver.findElement(By.css('#lockBtn')).click();
      await sleep(1500);
      const lockText = await driver.executeScript("return document.querySelector('.lock h3')?.textContent ?? 'no lock screen'");
      const pkButton = await driver.executeScript("return Boolean(document.getElementById('pkUnlock'))");
      const lockedUi = await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        Promise.all([browser.action.getBadgeText({}), browser.action.getTitle({})]).then(([badge, title]) => done({
          badge, title, contactsDisabled: document.getElementById('railContacts').disabled, filesDisabled: document.getElementById('railFiles').disabled,
          searchDisabled: document.getElementById('q').disabled, app: document.body.dataset.app }));`);
      console.log('  locked ui:', JSON.stringify(lockedUi));
      await driver.findElement(By.css('#pp')).sendKeys('wrong passphrase');
      await driver.findElement(By.css('#unlock button')).click();
      await sleep(1200);
      const wrong = await driver.executeScript("return document.getElementById('uerr').textContent");
      await driver.findElement(By.css('#pp')).clear();
      await driver.findElement(By.css('#pp')).sendKeys('dummy passphrase 123');
      await driver.findElement(By.css('#unlock button')).click();
      await sleep(2500);
      console.log(`  locked: "${lockText}" | passkey button: ${pkButton} | wrong: "${wrong}" | after unlock: ${await driver.executeScript("return document.querySelector('.lock') ? 'still locked' : 'unlocked'")}`);
      await drainConsole('lock');
    }

    console.log('\n# menu');
    const q = (js) => driver.executeScript(js);
    // The header: refresh left of the address, Do Not Disturb (with its menu) and pop-out on the right.
    console.log('  header:', await q("return [...document.querySelectorAll('body > header button')].filter((b) => b.offsetParent).map((b) => b.id).join(' ')"));
    await driver.findElement(By.css('#dndBtn')).click();
    await sleep(300);
    console.log('  dnd menu open:', await q("return !document.getElementById('menu').hidden"), '| items:', await q("return [...document.querySelectorAll('#menu .mi')].filter((b) => !b.hidden).map((b) => b.textContent.trim()).join(' | ')"));
    await shot('menu-dnd');
    await driver.findElement(By.css('#menu [data-dnd="30m"]')).click();
    await sleep(500);
    console.log('  dnd on:', await q("return document.getElementById('dndBtn').classList.contains('on') + ' | ' + document.getElementById('dndBtn').title + ' | menu closed: ' + document.getElementById('menu').hidden"));
    await driver.findElement(By.css('#dndBtn')).click();
    await sleep(300);
    console.log('  menu while on:', await q("return [...document.querySelectorAll('#menu .mi')].filter((b) => !b.hidden).map((b) => b.textContent.trim()).join(' | ')"));
    await driver.findElement(By.css('#menu [data-dnd=\"off\"]')).click();
    await sleep(400);
    console.log('  dnd off:', await q("return !document.getElementById('dndBtn').classList.contains('on')"));
    // The gear: the in-dropdown Settings view (connection summary, then the shared sections).
    await driver.findElement(By.css('#railSettings')).click();
    await sleep(800);
    const seg = async (group, v) => {
      const tab = { density: 'secLook', theme: 'secLook', dnd: 'secNotify' }[group];
      await driver.findElement(By.css(`#setTabs [data-st="${tab}"]`)).click();
      await driver.findElement(By.css(`#settingsView [data-seg="${group}"] [data-v="${v}"]`)).click();
      await sleep(500);
    };
    console.log('  settings view:', JSON.stringify(await q(`return { app: document.body.dataset.app, rail: document.getElementById('railSettings').classList.contains('on'),
      summary: [...document.querySelectorAll('#connSummary dt')].map((d) => d.textContent + ': ' + d.nextElementSibling.textContent).join(' | '),
      tabs: [...document.querySelectorAll('#setTabs button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')).join(', '),
      bg: getComputedStyle(document.getElementById('settingsView')).backgroundColor === getComputedStyle(document.getElementById('listPane')).backgroundColor || getComputedStyle(document.getElementById('settingsView')).backgroundColor }`)));
    await shot('settings-view');
    await seg('density', 'compact');
    console.log('  compact:', await q("return document.body.classList.contains('compact')"));
    await seg('dnd', '30m');
    console.log('  dnd lit:', await q("return document.getElementById('dndBtn').classList.contains('on')"), '| state:', await q("return document.getElementById('dndNow').textContent"));
    await seg('theme', 'light');
    await shot('settings-light');
    await seg('theme', 'dark');
    console.log('  dark theme bg:', await q("return getComputedStyle(document.body).backgroundColor"),
      '| Dark pressed:', await q(`return document.querySelector('#settingsView [data-seg="theme"] [data-v="dark"]').getAttribute('aria-pressed')`));
    await driver.findElement(By.css('#railHelp')).click();
    await sleep(500);
    console.log('  help view:', await q("return document.body.dataset.app + ' | ' + [...document.querySelectorAll('#helpKeys h3')].map((t) => t.textContent).join(', ') + ' | ' + document.querySelectorAll('#helpKeys kbd').length + ' keys'"));
    await shot('help-view');
    await driver.findElement(By.css('#railMail')).click();
    await sleep(500);
    await shot('popup-dark');
    await driver.findElement(By.css('.tabs [data-v="inbox"]')).click();
    await sleep(3000);
    const inboxItems = await driver.findElements(By.css('#body li'));
    const readItems = await driver.findElements(By.css('#body li.read'));
    for (const v of ['pinned', 'vips']) {
      await driver.findElement(By.css(`.tabs [data-v="${v}"]`)).click();
      await sleep(3500);
      console.log(`  ${v} view: items:`, (await driver.findElements(By.css('#body li'))).length, '| red pins:', await q("return document.querySelectorAll('#body .pin.on').length"), '| msg:', await q("return document.querySelector('#body .msg')?.textContent ?? '-'"));
    }
    await driver.findElement(By.css('.tabs [data-v="pinned"]')).click();
    await sleep(1500);
    await reloadFresh();
    await sleep(2500);
    console.log('  tab after reopening popup:', await q("return document.querySelector('.tabs .on')?.dataset.v"));
    await driver.findElement(By.css('#apps')).click();
    await sleep(300);
    console.log('  app switcher:', await q("return [...document.querySelectorAll('#appsMenu .app')].map((b) => b.textContent.trim()).join(' | ')"),
      '| rail buttons:', await q("return document.querySelectorAll('.rail-btn').length"));
    await driver.findElement(By.css('header')).click(); // outside → closes
    await sleep(200);
    console.log('  switcher closed:', await q("return document.getElementById('appsMenu').hidden"));
    await driver.findElement(By.css('#q')).sendKeys('the');
    await sleep(3000);
    console.log('  search "the":', await q("return document.querySelector('#body .results')?.textContent ?? document.querySelector('#body .msg')?.textContent"),
      '| tabs dimmed:', await q("return document.body.classList.contains('searching')"));
    await driver.findElement(By.css('#q')).sendKeys(Key.ESCAPE);
    await sleep(500);
    console.log('  after Esc: searching =', await q("return document.body.classList.contains('searching')"), '| q empty:', await q("return document.getElementById('q').value === ''"));
    await driver.findElement(By.css('.tabs [data-v="inbox"]')).click();
    await sleep(3000);
    console.log('  inbox view:', (await text('#account')).replace(/./g, '•').slice(0, 3) + '… ' + await text('#unreadCount'), '| items:', inboxItems.length, '| read:', readItems.length);
    await driver.findElement(By.css('.tabs [data-v="unread"]')).click();
    await setPrefs({ theme: 'system' });
    await setPrefs({ density: 'comfortable' });
    await setPrefs({ dndUntil: 0 });
    await sleep(2500);
    console.log('  reset: menu hidden:', await q("return document.getElementById('menu').hidden"), '| dnd lit:', await q("return document.getElementById('dndBtn').classList.contains('on')"), '|', (await text('#account')).replace(/./g, '•').slice(0, 3) + '… ' + await text('#unreadCount'));
    await drainConsole('menu');

    if (!LIVE) {
      // Visual fixture: fill the reader with placeholder content (no real mail) and screenshot it.
      await setPrefs({ theme: 'dark' }); // the menu is off-screen once the reader slides in
      // Feed fake inbox data through storage so the popup renders its real row markup. A background
      // poll (the dummy token's 401) can land just after and replace it, so retry until the rows stick.
      for (let attempt = 0; attempt < 5; attempt++) {
      await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        const now = Date.now(), iso = (m) => new Date(now - m * 60000).toISOString();
        const m = (id, from, subject, preview, mins, unread, att) => ({ id, from, subject, preview, receivedAt: iso(mins), unread, flagged: false, hasAttachment: att });
        browser.storage.local.set({ status: { checkedAt: now, state: { unread: 59, recent: [
          m('f1', 'Alex Example', 'Quarterly planning notes', 'Here are the notes from today.', 12, true, true),
          { ...m('f2', 'Billing Team', 'Your invoice is ready', 'Invoice #1234 for October is now available.', 95, true, true), flagged: true },
          m('f3', 'Sam Sample', 'Lunch Thursday?', 'Are you free around 12:30? There is a new place…', 300, false, false),
          m('f4', 'Newsletter', 'This week in widgets', 'Five things you missed this week, plus a deal.', 3000, false, false),
        ] } } }).then(done);
      `);
      await sleep(800);
      if ((await q("return document.querySelectorAll('#body li').length")) >= 4) break;
      }
      await q(`
        document.getElementById('account').textContent = 'someone.with.a.long.address@example.com';
        document.getElementById('dot').className = 'dot push';
      `);
      await driver.findElement(By.css('#body li:nth-child(2) input.cb')).click();
      await driver.actions().move({ origin: await driver.findElement(By.css('#body li:nth-child(3)')) }).perform();
      await sleep(300);
      await shot('list-dark');
      if (process.env.FIXTURES) {
        await driver.findElement(By.css('#railContacts')).click();
        await sleep(600);
        await q(`window.__fixtureContacts([
          { id: 'c1', name: 'Alex Example', title: 'Engineer', org: 'ACME Ltd', emails: [{ value: 'alex@example.com', label: 'Work' }],
            phones: [{ value: '+44 20 7946 0000', label: 'Mobile' }], addresses: [{ value: '1 Sample Street, London', label: 'Work' }], links: [], birthday: '3 March', notes: 'Met at the widgets conference.' },
          { id: 'c2', name: 'Andrea Sample', emails: [{ value: 'andrea@example.org' }], phones: [], addresses: [], links: [] },
          { id: 'c3', name: 'Billing Team', org: 'Example Bank', emails: [{ value: 'billing@example.net' }], phones: [{ value: '0800 000 000' }], addresses: [], links: [] },
          { id: 'c4', name: 'Chris Placeholder', emails: [], phones: [{ value: '+1 555 0100', label: 'Mobile' }], addresses: [], links: [] },
          { id: 'c5', name: 'Dana Dummy', emails: [{ value: 'dana@example.com' }], phones: [], addresses: [], links: [] },
        ]);
        document.getElementById('account').textContent = 'someone.with.a.long.address@example.com';`);
        await sleep(300);
        await shot('contacts-dark');
        await driver.findElement(By.css('#railMasked')).click();
        await sleep(600);
        await q(`const d = (y, m) => new Date(y, m, 5).toISOString(); window.__fixtureMasked([
          { id: 'm1', email: 'sunny.otter4821@fastmail.com', state: 'enabled', description: 'example-shop.com', createdAt: d(2024, 2), createdBy: 'Password manager', lastMessageAt: d(2026, 9) },
          { id: 'm2', email: 'quiet.maple77@fastmail.com', state: 'enabled', description: 'Newsletter signup', forDomain: 'https://news.example.org', createdAt: d(2023, 5), createdBy: 'Fastmail', lastMessageAt: d(2026, 8) },
          { id: 'm3', email: 'brisk.heron12@fastmail.com', state: 'disabled', description: 'Old forum', createdAt: d(2021, 1), createdBy: 'Fastmail' },
          { id: 'm4', email: 'amber.fox903@fastmail.com', state: 'enabled', description: 'Travel booking', createdAt: d(2025, 7), createdBy: 'Password manager', lastMessageAt: d(2026, 1) },
        ]);`);
        await driver.actions().move({ origin: await driver.findElement(By.css('#mbody .crow:nth-child(2)')) }).perform();
        await sleep(300);
        await shot('masked-dark');
        await driver.findElement(By.css('#mnew')).click();
        await sleep(300);
        await shot('masked-new');
        await driver.findElement(By.css('#railMail')).click();
        await sleep(400);
        const here = await driver.getWindowHandle();
        await openTab('email-preview.html');
        await sleep(800);
        await shot('email-preview');
        await driver.close();
        await driver.switchTo().window(here);
      }
      await driver.findElement(By.css('#apps')).click();
      await sleep(300);
      await shot('apps-dark');
      await driver.findElement(By.css('header')).click();
      await sleep(200);
      await setPrefs({ theme: 'light' });
      await shot('list-light');
      await q("document.getElementById('compose').setAttribute('aria-disabled', 'false')");
      await shot('compose-enabled-light');
      await setPrefs({ theme: 'dark' });
      await q(`
        document.body.classList.add('reading');
        document.getElementById('rsubj').textContent = 'Quarterly planning notes';
        document.getElementById('rlabels').innerHTML = '<span class="mailbox-chip">Inbox</span>';
        document.getElementById('msgs').innerHTML = '<article class="cmsg open"><div class="mhead"><div class="avatar" style="background:#1f4d3f">AE</div>' +
          '<div><div class="mname"><span style="color:#a7d8c9">Alex Example</span><span class="addr">alex@example.com</span></div><div class="mto">to Sam Sample</div></div>' +
          '<div class="mdate">15 Oct (57 minutes ago)</div></div><div class="mbody"><iframe class="mframe" style="height:160px" srcdoc="' +
          '<body style=&quot;margin:4px 16px 16px 60px;font:14px/1.5 system-ui;color:#d6d8da;background:#1b1e20&quot;>Hi Sam,<br><br>Here are the notes from today.<br><br>Alex</body>' +
          '"></iframe><div class="mfoot"><button class="pill">Load images (3)</button></div></div></article>';
      `);
      await sleep(400);
      await shot('reader-dark');
      await q("document.body.classList.remove('reading')");
      await sleep(300);
      await setPrefs({ theme: 'system' });
    }

    if (LIVE) {
      console.log('\n# contacts (counts only)');
      await driver.findElement(By.css('#railContacts')).click();
      await sleep(3000);
      const cstate = () => q(`return [
        document.querySelectorAll('#cbody .crow').length + ' rows',
        document.querySelectorAll('#cbody .cletter').length + ' letters',
        document.getElementById('ccount').textContent.trim(),
        document.getElementById('cdetailCard').hidden ? 'no detail' : document.querySelectorAll('#cdetailCard .crow-d').length + ' detail rows',
      ].join(', ')`);
      console.log('  loaded:', await cstate());
      console.log('  list scrolls:', await q("const b = document.getElementById('cbody'); b.scrollTop = 400; return getComputedStyle(b).overflowY + ', scrollTop=' + b.scrollTop + ' of ' + (b.scrollHeight - b.clientHeight)"));
      await driver.findElement(By.css('#cq')).sendKeys('an');
      await sleep(300);
      console.log('  search "an":', await cstate());
      await driver.findElement(By.css('#cq')).sendKeys(Key.ESCAPE);
      await sleep(200);
      await driver.findElement(By.css('header')).click();
      await driver.findElement(By.css('body')).sendKeys('jj');
      console.log('  after Esc + jj: selected index =', await q("return [...document.querySelectorAll('#cbody .crow')].findIndex((r) => r.classList.contains('sel'))"));
      await reloadFresh();
      await sleep(2500);
      console.log('  app after reopening popup:', await q("return document.body.dataset.app"));
      await drainConsole('contacts');

      console.log('\n# masked email (counts only)');
      await driver.findElement(By.css('#railMasked')).click();
      await sleep(3000);
      const mstate = () => q(`return [
        document.querySelectorAll('#mbody .crow').length + ' rows',
        [...document.querySelectorAll('#mfilter button')].map((b) => b.textContent.trim()).join('/'),
        document.querySelectorAll('#mbody .mdot').length + ' enabled dots',
        document.querySelectorAll('#mbody .myear').length + ' years',
        document.getElementById('mdetailCard').hidden ? 'no detail' : document.querySelectorAll('#mdetailCard .crow-d').length + ' detail rows',
      ].join(', ')`);
      console.log('  loaded:', await mstate());
      console.log('  list scrolls:', await q("const b = document.getElementById('mbody'); b.scrollTop = 400; return getComputedStyle(b).overflowY + ', scrollTop=' + b.scrollTop + ' of ' + (b.scrollHeight - b.clientHeight)"));
      await driver.findElement(By.css('#mfilter [data-f="disabled"]')).click();
      console.log('  disabled filter:', await mstate());
      await driver.findElement(By.css('#mfilter [data-f="all"]')).click();
      await driver.findElement(By.css('#mq')).sendKeys('a');
      await sleep(200);
      console.log('  search "a":', await mstate());
      await driver.findElement(By.css('#mq')).sendKeys(Key.ESCAPE);
      console.log('  toggle/delete locked:', await q("return [...document.querySelectorAll('#mdetailCard [data-state]')].every((b) => b.getAttribute('aria-disabled') === 'true')"));
      await driver.findElement(By.css('#mnew')).click();
      await sleep(300);
      console.log('  new form:', await q("return document.getElementById('mform') ? 'shown, create ' + (document.querySelector('#mform [type=submit]').getAttribute('aria-disabled') === 'true' ? 'locked' : 'enabled') : 'missing'"));
      await driver.findElement(By.css('#railMail')).click();
      await sleep(2500);
      console.log('  back to mail: rows =', (await driver.findElements(By.css('#body li'))).length);
      await drainConsole('masked');
    }

    const fresh = await driver.findElements(By.css('#body li'));
    if (fresh.length) {
      console.log('\n# reader');
      await fresh[0].click();
      await sleep(2500);
      const r = await driver.executeScript(`
        const m = document.querySelector('.cmsg.open');
        const f = m?.querySelector('.mframe');
        const img = m?.querySelector('[data-images]');
        const orig = m?.querySelector('[data-orig]');
        return {
          sliding: document.body.classList.contains('reading'),
          subject: document.getElementById('rsubj').textContent.length,
          from: m?.querySelector('.mname').textContent.length ?? 0,
          srcdoc: f?.srcdoc.length ?? 0,
          sandbox: f?.getAttribute('sandbox'),
          frameHeight: f ? Math.round(f.getBoundingClientRect().height) : 0,
          contentHeight: f ? Math.ceil(f.contentDocument?.documentElement.getBoundingClientRect().height) : 'n/a',
          cspInDoc: Boolean(f?.srcdoc.includes("default-src 'none'")),
          scriptTags: ((f?.srcdoc ?? '').match(/<script/gi) || []).length,
          imagesButton: img ? img.textContent.trim() : 'hidden',
          origColors: document.getElementById('origToggle').hidden ? 'hidden' : document.getElementById('origToggle').title,
          frameBgDark: /background: #1b1e20/.test(f?.srcdoc ?? ''),
          prevDisabled: document.getElementById('prev').disabled,
          nextDisabled: document.getElementById('next').disabled,
        };
      `);
      console.log('  reader:', JSON.stringify(r));
      await driver.findElement(By.css('#next')).click();
      await sleep(2000);
      console.log('  after next: prevDisabled =', await driver.executeScript("return document.getElementById('prev').disabled"));
      await driver.findElement(By.css('#back')).click();
      await sleep(500);
      console.log('  after back: reading =', await driver.executeScript("return document.body.classList.contains('reading')"));
      // Mouse forward/back buttons (WebDriver buttons 4 and 3), over the list and over the message.
      const reading = () => driver.executeScript("return document.body.classList.contains('reading')");
      const mouse = async (button, el) => {
        await driver.actions({ async: true }).move({ origin: el }).press(button).release(button).perform();
        await sleep(800);
      };
      await mouse(Button.FORWARD, await driver.findElement(By.css('#body')));
      const fwd = await reading();
      await mouse(Button.BACK, await driver.findElement(By.css('.rhead, #rsubj')));
      const back = await reading();
      console.log(`  mouse: forward reopens = ${fwd} | back leaves = ${!back}`);
      // Over the message itself (events in the frame are passed on), and keys with focus in it.
      await mouse(Button.FORWARD, await driver.findElement(By.css('#body')));
      await sleep(1500);
      const overFrame = await driver.findElement(By.css('#msgs .cmsg.open .mframe'));
      await mouse(Button.BACK, overFrame);
      const backOverFrame = !(await reading());
      await mouse(Button.FORWARD, await driver.findElement(By.css('#body')));
      await sleep(1500);
      await driver.executeScript("document.querySelector('#msgs .cmsg.open .mframe').contentDocument.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await sleep(800);
      console.log(`  over the message: mouse back leaves = ${backOverFrame} | Esc inside it leaves = ${!(await reading())}`);
      // Reopening the dropdown comes back to the open message.
      await mouse(Button.FORWARD, await driver.findElement(By.css('#body')));
      await sleep(1000);
      const openId = await driver.executeScript("return document.getElementById('rsubj').textContent");
      await driver.navigate().refresh();
      await sleep(3000);
      console.log(`  reopened: reading=${await reading()} | same message=${(await driver.executeScript("return document.getElementById('rsubj').textContent")) === openId} | expand all: ${await driver.executeScript("const b = document.getElementById('expandAll'); return b.hidden ? 'hidden (single message)' : b.title")}`);
      await driver.findElement(By.css('#back')).click();
      await sleep(800);
      // Notification click: the background leaves `pendingOpen`; a freshly opened dropdown shows it.
      await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        browser.storage.session.set({ pendingOpen: { id: 'f2', at: Date.now() } }).then(done);`);
      await reloadFresh();
      await sleep(2000);
      console.log('  notification click → reader open:', await reading(), '| request cleared:', await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        browser.storage.session.get('pendingOpen').then((r) => done(!r.pendingOpen));`));
      await drainConsole('reader');
    }
  }

  if (WATCH) {
    const until = WATCH === Infinity ? 'until the window is closed' : `for ${WATCH}s`;
    console.log(`\n# watching background ${until} (debugLog from extension storage)`);
    let lastLine;
    let builtAt = manifestMtime();
    let readFrom = await driver.getWindowHandle();
    let warned;
    for (let t = 0; t <= WATCH; t += 5) {
      let lines;
      try {
        // Rebuilt? Reinstall (reload) the extension and restore the token, like a dev server would.
        const m = manifestMtime();
        if (m && m !== builtAt) {
          await sleep(2000); // let the build finish writing
          builtAt = manifestMtime();
          await driver.installAddon(EXT_DIR, true);
          console.log('# rebuilt: extension reloaded');
          await sleep(1000);
          if (!FRESH) {
            await saveToken();
            await openTab('popup.html');
            readFrom = await driver.getWindowHandle();
          }
        }
        lines = FRESH ? await debugLogViaChrome() : await driver.executeAsyncScript(`
          const done = arguments[arguments.length - 1];
          browser.storage.local.get('debugLog').then((r) => done(r.debugLog ?? []), (e) => done(['ERR ' + e.message]));
        `);
        await drainConsole('errors');
      } catch (e) {
        if (FRESH && !warned) console.log('# background log unavailable:', (warned = e.message));
        // WebDriver calls can fail while a passkey prompt is up; just try again later. Reopen our tab
        // only if it's gone, in the background: taking focus would cancel the prompt.
        try {
          const handles = await driver.getAllWindowHandles();
          if (!FRESH && !handles.includes(readFrom)) {
            await openTab('popup.html', { select: false });
            readFrom = await driver.getWindowHandle();
          }
        } catch {
          console.log('# browser closed, stopping');
          break;
        }
        if (t < WATCH) await sleep(5_000);
        continue;
      }
      // debugLog is a ring buffer, so resume after the last line printed rather than by index.
      for (const l of lines.slice(lines.lastIndexOf(lastLine) + 1)) console.log('   ', l.slice(11, 19), l.slice(25));
      lastLine = lines.at(-1) ?? lastLine;
      if (t < WATCH) await sleep(5_000);
    }
  }
} catch (e) {
  console.log('SCRIPT ERROR:', e.message);
  process.exitCode = 1; // so a release stops here
} finally {
  await driver.quit().catch(() => {});
  await fake?.close();
}
