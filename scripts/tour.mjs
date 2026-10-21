// The README screenshots: a walk through the popup on the fake server, each scene shown as a fake
// dropdown (the popup in a rounded box with a caret, on a soft light backdrop), in dark and light, then
// encoded into animated AVIFs (docs/tour-dark.avif, docs/tour-light.avif) with a PNG of the first scene.
// Run from the e2e harness:  pnpm tour   (needs avifenc: brew install libavif)
// Only made-up mail from scripts/fake-fastmail.mjs is ever shown.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HOLD = 26; // per scene, in tenths of a second (timescale 10)
const POPUP = { w: 680, h: 580 };
const MARGIN = { x: 28, top: 34, bottom: 30 };

/** The popup as a dropdown: rounded, shadowed, with a caret towards the toolbar icon, on a soft backdrop. */
const FRAME_CSS = (dark) => `
  html { overflow: visible !important; position: relative; min-height: 100vh;
    background: linear-gradient(160deg, #e3e8f0, #c8d0de) !important; }
  html::before { content: ''; position: absolute; top: ${MARGIN.top - 11}px; left: calc(50% + 258px); border: 11px solid transparent;
    border-top: 0; border-bottom-color: var(--bar); }
  body { margin: ${MARGIN.top}px auto ${MARGIN.bottom}px !important; border-radius: 12px; overflow: hidden;
    box-shadow: 0 20px 50px rgba(0,0,0,${dark ? '.4' : '.3'}), 0 0 0 1px rgba(0,0,0,${dark ? '.25' : '.16'}); }
  .fakechip, .caltip, .toast { display: none !important; }
  ::-webkit-scrollbar { display: none; }
`;

/** The full settings page as a card of the same size (header hidden, a little smaller, so the credentials and the lock options fit). */
const OPTIONS_CSS = (dark) => `
  html { overflow: visible !important; min-height: 100vh; background: linear-gradient(160deg, #e3e8f0, #c8d0de) !important; }
  body { width: ${POPUP.w}px; height: ${POPUP.h}px; margin: ${MARGIN.top}px auto ${MARGIN.bottom}px !important; border-radius: 12px; overflow: hidden;
    box-shadow: 0 20px 50px rgba(0,0,0,${dark ? '.4' : '.3'}), 0 0 0 1px rgba(0,0,0,${dark ? '.25' : '.16'}); }
  main { zoom: 0.8; max-width: none !important; padding: 18px 20px !important; }
  header, .chip, section:has(#about) { display: none !important; }
  ::-webkit-scrollbar { display: none; }
`;

/** Round the image's own corners (transparent outside), softly, so it sits on any page background. */
function roundCorners(file, r = 24) {
  const out = `${file}.round.png`;
  const alpha = `clip((${r}-hypot(max(abs(X-W/2)-(W/2-${r}),0),max(abs(Y-H/2)-(H/2-${r}),0)))*170+85,0,255)`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'`, out]);
  fs.renameSync(out, file);
}

export async function tour({ driver, By, Key, sleep, dir, fake, openTab }) {
  fs.mkdirSync(dir, { recursive: true });
  const js = (code, ...args) => driver.executeScript(code, ...args);
  const click = (sel) => js('document.querySelector(arguments[0])?.click()', sel);
  const prefs = (patch) =>
    js("return browser.storage.local.get('prefs').then((r) => browser.storage.local.set({ prefs: { ...r.prefs, ...arguments[0] } }))", patch);

  // A window whose page area is the popup plus its margins.
  const want = { w: POPUP.w + MARGIN.x * 2, h: POPUP.h + MARGIN.top + MARGIN.bottom };
  const win = driver.manage().window();
  await win.setRect({ width: want.w, height: want.h });
  const inner = await js('return [innerWidth, innerHeight]');
  await win.setRect({ width: want.w + (want.w - inner[0]), height: want.h + (want.h - inner[1]) });

  const frames = { dark: [], light: [] };
  for (const theme of ['dark', 'light']) {
    await prefs({ theme, app: 'mail', view: 'unread', mailbox: undefined, calView: 'list' });
    await js('browser.storage.session.remove("reading")');
    await driver.navigate().refresh();
    await sleep(2500);
    // No draft carried over from the other theme's run: if one was restored, discard it.
    await js("document.querySelector('.composer .cdiscard')?.click()");
    await sleep(1200);
    await js(`document.getElementById('tourFrame')?.remove(); const s = document.createElement('style'); s.id = 'tourFrame'; s.textContent = arguments[0]; document.head.append(s)`, FRAME_CSS(theme === 'dark'));

    let n = 0;
    const scene = async (name, settle = 1200) => {
      await sleep(settle);
      const file = path.join(dir, `${theme}-${String(++n).padStart(2, '0')}-${name}.png`);
      fs.writeFileSync(file, await driver.takeScreenshot(), 'base64');
      roundCorners(file);
      frames[theme].push(file);
    };
    const rail = (id) => click(`#rail${id}`);
    const hover = async (sel) => {
      const el = await driver.findElement(By.css(sel));
      await driver.actions({ async: true }).move({ origin: el }).perform();
    };

    // The unread list, a row under the pointer.
    await js("document.querySelector('.tabs [data-v=\"unread\"]')?.click()");
    await sleep(800);
    await hover('#body li:nth-child(2)');
    await scene('inbox');
    // Out of the way (no stray hover or tooltips in the other scenes).
    await driver.actions({ async: true }).move({ x: 4, y: 4 }).perform();
    // A conversation.
    await click('#body li[data-id="l4"] .subj');
    await scene('conversation', 2200);
    await click('#back');
    await sleep(600);
    // Search follows the tab.
    await js("const q = document.getElementById('q'); q.focus(); q.value = 'plann'; q.dispatchEvent(new Event('input'))");
    await scene('search', 2200);
    await click('#qClear');
    // Compose, set aside afterwards.
    await rail('Compose');
    await sleep(1200);
    await driver.findElement(By.css('.composer .chips[data-field="to"] input')).sendKeys('alex@example.com', Key.ENTER);
    await driver.findElement(By.css('.composer .csubject')).sendKeys('Lunch on Friday?');
    await driver.findElement(By.css('.composer .cbody')).sendKeys('Are you free around one? Thought we could try the new place.');
    await scene('compose', 800);
    await rail('Mail');
    // Calendar: agenda, then the week with an event open.
    await rail('Calendar');
    await scene('agenda', 3200);
    await js("[...document.querySelectorAll('#calHost .ec-event')].find((e) => e.textContent.includes('Dentist'))?.click()");
    await scene('event', 700);
    await driver.findElement(By.css('body')).sendKeys(Key.ESCAPE);
    await driver.findElement(By.css('body')).sendKeys('w');
    await scene('week', 1800);
    // Files, Contacts, Masked Email.
    // (The security fixture with a markup file name isn't for the README.)
    for (const k of [...fake.files.files.keys()]) if (k.includes('onerror')) fake.files.files.delete(k);
    await rail('Files');
    await click('#refresh');
    await scene('files', 2400);
    await rail('Contacts');
    await scene('contacts', 2000);
    await rail('Masked');
    await scene('masked', 2000);
    // Settings (Notifications), then Help: About (where it opens) and the shortcuts.
    await rail('Settings');
    await sleep(600);
    await click('#setTabs [data-st="secNotify"]');
    await scene('settings', 600);
    await rail('Help');
    await scene('about', 800);
    await click('#helpTabs [data-st="helpKeyboard"]');
    await scene('shortcuts', 600);
    await rail('Mail');
    // The full settings page: the token, the Calendar/Files password and how they're kept.
    const popupHandle = await driver.getWindowHandle();
    await openTab('options.html');
    await sleep(1500);
    await js(`document.getElementById('tourFrame')?.remove(); const s = document.createElement('style'); s.id = 'tourFrame'; s.textContent = arguments[0]; document.head.append(s)`, OPTIONS_CSS(theme === 'dark'));
    await scene('connection', 800);
    await driver.close();
    await driver.switchTo().window(popupHandle);
  }

  // Encode: one animated AVIF per theme, and a PNG of the first scene (for where AVIF isn't shown).
  const docs = path.resolve('docs');
  fs.mkdirSync(docs, { recursive: true });
  for (const theme of ['dark', 'light']) {
    const args = ['--fps', '10', '-q', '58', '-s', '5', '--jobs', 'all'];
    for (const f of frames[theme]) args.push('--duration', String(HOLD), f);
    const out = path.join(docs, `tour-${theme}.avif`);
    args.push(out);
    execFileSync('avifenc', args, { stdio: 'ignore' });
    fs.copyFileSync(frames[theme][0], path.join(docs, `tour-${theme}.png`));
    console.log(`  ${out}: ${frames[theme].length} scenes, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  }
}
