// The settings that save as they change — Notifications, Appearance, Updates, Vacation response —
// for the dropdown's Settings view, plus the shortcuts and About (About is on the full settings page too,
// which is otherwise just the connection). `sectionsHtml()` is the markup; `initSections()` wires it up.
import { browser } from 'wxt/browser';
import { html, render, type Html } from './html';
import { getSession, getVacation, setVacation, type Vacation } from './jmap';
import { DEFAULT_KEYS, KEY_HELP, keyLabel } from './keymap';
import { DND_CHOICES, dndActive, dndLabel, dndUntilFor, getPrefs, updatePrefs, type DndChoice } from './prefs';
import { playHere, SOUNDS, validSound, type SoundId } from './sounds';
import { getCachedSession, getSettings, getUnlocked, saveSettings } from './storage';

const seg = (pref: string, options: [string, string][]): Html =>
  html`<div class="seg" data-seg="${pref}" role="radiogroup">${options.map(([v, label]) => html`<button data-v="${v}" role="radio">${label}</button>`)}</div>`;

export function sectionsHtml(): Html {
  return html`
    <section id="secNotify">
      <h2>Notifications</h2>
      <label class="inline"><input id="mailNotify" type="checkbox"> Desktop notifications for new mail</label>
      <div id="calRemRow" hidden>
        <label class="inline"><input id="calReminders" type="checkbox"> Calendar reminders</label>
        <span class="help">At each event's reminder time, for the calendars switched on in Calendar.</span>
      </div>
      <button class="pill btn" id="testNotify">Send a test notification</button>
      <div class="sounds" id="sounds" role="radiogroup" aria-label="New mail sound"></div>
      <div class="row"><span>Volume</span><input id="volume" type="range" min="0" max="1" step="0.05"></div>
      <span class="help">Plays once per batch of new mail and with each reminder, never during Do Not Disturb.</span>
      <div class="row dndrow"><span>Do Not Disturb</span><span id="dndNow" class="help"></span></div>
      ${seg('dnd', DND_CHOICES.map(([c, l]) => [c, c === 'off' ? 'Off' : l.replace('For ', '').replace('Until tomorrow 8:00', 'Till 8:00')]))}
    </section>
    <section id="secLook">
      <h2>Appearance</h2>
      <div class="row"><span>Theme</span>${seg('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']])}</div>
      <div class="row"><span>List</span>${seg('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']])}</div>
    </section>
    <section id="vacation" hidden>
      <h2>Vacation response</h2>
      <label class="inline"><input id="vacOn" type="checkbox"> Reply automatically while I'm away</label>
      <div class="grid2">
        <div><label for="vacFrom">From <em>(optional)</em></label><input id="vacFrom" type="date"></div>
        <div><label for="vacTo">Until <em>(optional)</em></label><input id="vacTo" type="date"></div>
      </div>
      <label for="vacSubject">Subject</label>
      <input id="vacSubject" type="text" placeholder="Out of office">
      <label for="vacBody">Message</label>
      <textarea id="vacBody" rows="4" placeholder="I'm away until…"></textarea>
      <span id="vacNote" class="help"></span>
    </section>
    <section id="secUpdates">
      <h2>Updates</h2>
      <label class="inline"><input id="push" type="checkbox"> Live updates (push)</label>
      <span class="help">New mail shows up instantly. Fastmail allows one live connection per token, so use a separate token in each browser.</span>
      <label class="inline">Also check every <input id="interval" type="number" min="0.5" step="0.5"> minutes</label>
    </section>`;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Each change is confirmed with a toast at the bottom centre (the page's own, or a small one here).
let notify: (text: string) => void = pageToast;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function pageToast(text: string) {
  let el = document.getElementById('settingsToast');
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'settingsToast', className: 'settings-toast' });
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el!.hidden = true), 1800);
}
export const savedTick = (_control?: Element) => notify('✓ Saved');

async function load() {
  const [s, p, unlocked] = await Promise.all([getSettings(), getPrefs(), getUnlocked()]);
  $<HTMLInputElement>('interval').value = String(s.intervalMinutes);
  $<HTMLInputElement>('push').checked = s.push;
  $<HTMLInputElement>('volume').value = String(p.volume);
  const sound = validSound(p.sound);
  render(
    $('sounds'),
    html`${[['none', 'None'] as const, ...SOUNDS].map(([id, label]) => html`<button class="snd" role="radio" data-id="${id}" aria-pressed="${String(id === sound)}">${label}</button>`)}`,
  );
  // Reminders need the Calendar/Files password.
  $('calRemRow').hidden = !unlocked?.secrets.davPassword;
  $<HTMLInputElement>('mailNotify').checked = p.mailNotify;
  $<HTMLInputElement>('calReminders').checked = p.calReminders;
  const dnd = dndActive(p);
  $('dndNow').textContent = dnd ? `On, ${dndLabel(p)}` : 'Off';
  const pressed: Record<string, string> = { theme: p.theme, density: p.density, dnd: dnd ? '' : 'off' };
  for (const g of document.querySelectorAll<HTMLElement>('[data-seg]'))
    for (const b of g.querySelectorAll<HTMLElement>('[data-v]')) b.setAttribute('aria-pressed', String(b.dataset.v === pressed[g.dataset.seg!]));
}

async function saveUpdates() {
  const s = await getSettings();
  s.push = $<HTMLInputElement>('push').checked;
  s.intervalMinutes = Math.max(Number($<HTMLInputElement>('interval').value) || 1, 0.5);
  await saveSettings(s);
  savedTick($('push'));
}

// --- Vacation response (Fastmail's auto-reply) ------------------------------------------------------

/** UTC timestamps ↔ the local date inputs (from: start of that day; until: end of it). */
const toInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60e3).toISOString().slice(0, 10) : '');
const fromInput = (value: string, endOfDay = false) => (value ? new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`).toISOString() : null);

async function loadVacation() {
  const unlocked = await getUnlocked();
  const session = (await getCachedSession()) ?? (unlocked ? await getSession(unlocked.secrets.token).catch(() => undefined) : undefined);
  const section = $('vacation');
  if (!unlocked || !session) return void (section.hidden = true);
  const c = { token: unlocked.secrets.token, session };
  const [on, from, to, subject] = (['vacOn', 'vacFrom', 'vacTo', 'vacSubject'] as const).map((id) => $<HTMLInputElement>(id));
  const body = $<HTMLTextAreaElement>('vacBody');
  const note = $('vacNote');
  const controls = [on!, from!, to!, subject!, body];
  section.hidden = false;
  if (!session.scopes?.vacation) {
    controls.forEach((x) => (x.disabled = true));
    note.textContent = "Your API token doesn't include Vacation response. Create one with it ticked to use this.";
    return;
  }
  let v: Vacation;
  try {
    v = await getVacation(c.token, c.session);
  } catch {
    // Not reachable with this token right now (e.g. rejected): nothing to show.
    return void (section.hidden = true);
  }
  on!.checked = v.isEnabled;
  from!.value = toInput(v.fromDate);
  to!.value = toInput(v.toDate);
  subject!.value = v.subject ?? '';
  body.value = v.textBody ?? '';
  const readOnly = Boolean(session.readOnly);
  controls.forEach((x) => (x.disabled = readOnly));
  note.textContent = readOnly ? 'Read-only token: shown here, but it can only be changed with write access.' : '';
  const save = async (patch: Partial<Vacation>, el: Element) => {
    try {
      await setVacation(c.token, c.session, patch);
      savedTick(el);
      note.textContent = '';
    } catch (e) {
      note.textContent = `Couldn't save: ${(e as Error).message}`;
    }
  };
  on!.onchange = () => save({ isEnabled: on!.checked }, on!);
  from!.onchange = () => save({ fromDate: fromInput(from!.value) }, from!);
  to!.onchange = () => save({ toDate: fromInput(to!.value, true) }, to!);
  subject!.onchange = () => save({ subject: subject!.value || null }, subject!);
  body.onchange = () => save({ textBody: body.value || null }, body);
}

/** Wire up the sections (already in the page) and keep them current; `toast` shows "Saved" (else a small toast of our own). */
export function initSections({ toast }: { toast?: (text: string) => void } = {}) {
  if (toast) notify = toast;
  $('push').onchange = saveUpdates;
  $('interval').onchange = saveUpdates;
  $('sounds').onclick = (e) => {
    const id = (e.target as Element).closest<HTMLElement>('.snd')?.dataset.id as SoundId | undefined;
    if (!id) return;
    for (const b of $('sounds').querySelectorAll<HTMLElement>('.snd')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
    updatePrefs({ sound: id }).then(() => savedTick($('sounds')));
    playHere(id, Number($<HTMLInputElement>('volume').value)).catch(() => {});
  };
  $('volume').onchange = () => updatePrefs({ volume: Number($<HTMLInputElement>('volume').value) }).then(() => savedTick($('volume')));
  $('mailNotify').onchange = (e) =>
    updatePrefs({ mailNotify: (e.target as HTMLInputElement).checked }).then(() => savedTick(e.target as Element));
  $('testNotify').onclick = () =>
    browser.runtime.sendMessage({ type: 'test-notify' }).then(
      (r: any) => notify(r?.ok ? 'Test notification sent' : `Couldn't send it: ${r?.error ?? 'no reply'}`),
      (e) => notify(`Couldn't send it: ${(e as Error).message}`),
    );
  $('calReminders').onchange = (e) =>
    updatePrefs({ calReminders: (e.target as HTMLInputElement).checked }).then(() => savedTick(e.target as Element));
  for (const g of document.querySelectorAll<HTMLElement>('[data-seg]')) {
    g.onclick = (e) => {
      const v = (e.target as Element).closest<HTMLElement>('[data-v]')?.dataset.v;
      if (!v) return;
      const key = g.dataset.seg!;
      const patch = key === 'dnd' ? { dndUntil: dndUntilFor(v as DndChoice) } : { [key]: v };
      updatePrefs(patch).then(() => savedTick(g));
    };
  }
  browser.storage.onChanged.addListener((c, area) => {
    if ((area === 'local' && (c.settings || c.prefs)) || (area === 'session' && c.unlocked)) load();
    if (area === 'session' && c.unlocked) loadVacation();
  });
  load();
  loadVacation();
}

// --- Help: keyboard shortcuts ------------------------------------------------------------------------
const OTHER_KEYS: [string, [string[], string][]][] = [
  ['Calendar', [[['t'], 'Today'], [['c'], 'New event'], [['j', 'k'], 'Next / previous'], [['a', 'w', 'm'], 'Agenda / week / month'], [['Esc'], 'Close']]],
  ['Files', [[['j', 'k'], 'Move down / up'], [['Enter'], 'Open'], [['u'], 'Up a folder'], [['Delete'], 'Delete'], [['Esc'], 'Close or cancel']]],
];

/** The shortcuts: a grid of columns per app, each key (as a keycap) right beside what it does. */
export function keysHtml(): Html {
  const row = (keys: string[], what: string) =>
    html`<div class="krow"><span class="kk">${keys.map((k) => html`<kbd>${keyLabel(k)}</kbd>`)}</span><span class="kd">${what}</span></div>`;
  const group = (title: string, rows: [string[], string][]) =>
    html`<h3>${title}</h3><div class="keygrid">${rows.map(([k, w]) => row(k, w))}</div>`;
  return html`<div class="keys">${group('Mail', KEY_HELP.map(([a, what]) => [DEFAULT_KEYS[a], what] as [string[], string]))}${OTHER_KEYS.map(([app, list]) => group(app, list))}</div>`;
}

// --- About ---------------------------------------------------------------------------------------
const REPO = 'https://github.com/replete/superfastmail';

/** The big icon, the version and where the project lives. */
export function aboutHtml(): Html {
  const link = (href: string, label: string) => html`<a class="pill btn" href="${href}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
  return html`<div class="about">
    <img src="/icon/128.png" width="96" height="96" alt="">
    <div class="aname">Super Fastmail</div>
    <div class="aver">Version ${browser.runtime.getManifest().version}</div>
    <p class="help">Fastmail in your browser's toolbar: mail, calendar, contacts, files and masked email.</p>
    <div class="alinks">${link(REPO, 'GitHub')}${link(`${REPO}/releases`, "What's new")}${link(`${REPO}/issues`, 'Report a problem')}</div>
    <p class="help">An independent project, not affiliated with Fastmail.</p>
  </div>`;
}
