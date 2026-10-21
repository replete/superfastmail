// The Calendar app: agenda, week and month views of the CalDAV calendars (EventCalendar for the
// grid, lib/calendar.ts for the data). Loaded on demand when Calendar opens, with EventCalendar's
// prebuilt script (a global) and stylesheet from the extension's vendor/ folder.
import { browser } from 'wxt/browser';
import {
  connectCalendar,
  createEvent,
  deleteEvent,
  EditConflict,
  eventsBetween,
  listCalendars,
  NoCalendarPassword,
  updateEvent,
  type CalEvent,
  type Calendar,
  type EventInput,
} from '@/lib/calendar';
import { getPrefs, updatePrefs } from '@/lib/prefs';
import { getCachedSession, getUnlocked } from '@/lib/storage';
import { html, insert, render, type Html } from '@/lib/html';

type CalView = 'list' | 'week' | 'month';
const EC_VIEW: Record<CalView, string> = { list: 'listWeek', week: 'timeGridWeek', month: 'dayGridMonth' };

declare global {
  interface Window {
    EventCalendar?: { create(el: HTMLElement, options: Record<string, unknown>): any; destroy(cal: any): void };
  }
}

const $ = (id: string) => document.getElementById(id)!;
let ec: any;
let calendars: Calendar[] = [];
let dav: Awaited<ReturnType<typeof connectCalendar>> | undefined;
let hiddenCals = new Set<string>();
let byId = new Map<string, CalEvent>();
/** The event form, while it's open. */
let editing: { event?: CalEvent; initial: string } | undefined;
let defaultCal: string | undefined;

function loadVendor(): Promise<void> {
  if (window.EventCalendar) return Promise.resolve();
  const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: browser.runtime.getURL('/vendor/event-calendar.min.css' as any) });
  document.head.append(css);
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src: browser.runtime.getURL('/vendor/event-calendar.min.js' as any) });
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Calendar view failed to load'));
    document.head.append(script);
  });
}

function message(h?: Html) {
  if (h) render($('calMsg'), h);
  else $('calMsg').replaceChildren();
  $('calMsg').hidden = !h;
  $('calHost').hidden = Boolean(h);
  $('calNew').hidden = Boolean(h) || !calendars.length;
}

const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d: Date) => d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

/** "Tue 20 Oct, 09:00–10:00", or for all-day "Tue 20 Oct" / "Tue 20 – Thu 22 Oct". */
function whenText(e: CalEvent) {
  if (e.allDay) {
    const last = new Date(e.end.getFullYear(), e.end.getMonth(), e.end.getDate() - 1);
    return last.getTime() > e.start.getTime() ? `${fmtDay(e.start)} – ${fmtDay(last)}` : `${fmtDay(e.start)}, all day`;
  }
  const sameDay = e.start.toDateString() === e.end.toDateString();
  return sameDay ? `${fmtDay(e.start)}, ${fmtTime(e.start)}–${fmtTime(e.end)}` : `${fmtDay(e.start)} ${fmtTime(e.start)} – ${fmtDay(e.end)} ${fmtTime(e.end)}`;
}

function showDetails(id: string) {
  const e = byId.get(id);
  if (!e) return;
  const cal = calendars.find((c) => c.url === e.calendarUrl);
  const box = $('calEvent');
  render(
    box,
    html`<div class="cehead"><span class="cedot" style="background:${cal?.color ?? '#888'}"></span><h3>${e.title}</h3>
      <button class="icon" data-close title="Close (Esc)">×</button></div>
    <div class="cerow">${whenText(e)}${e.recurring && ' · repeats'}</div>
    ${e.location && html`<div class="cerow muted">${e.location}</div>`}
    ${e.alarms.length > 0 && html`<div class="cerow muted">Reminder ${e.alarms.map((m) => (m === 0 ? 'at start' : m >= 1440 && m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'} before` : m >= 60 && m % 60 === 0 ? `${m / 60} h before` : `${m} min before`)).join(', ')}</div>`}
    ${e.notes && html`<div class="cenotes">${e.notes}</div>`}
    <div class="cerow muted">${cal?.name}</div>
    ${!e.recurring && html`<div class="ceactions"><button class="pill" data-delete>Delete</button><button class="pill primary" data-edit>Edit</button></div>`}`,
  );
  box.className = 'calevent';
  box.hidden = false;
  box.dataset.id = id;
  editing = undefined;
  removeDraft();
}

function hideDetails() {
  $('calEvent').hidden = true;
  editing = undefined;
  removeDraft();
}

/** How an event of a calendar looks: a tint of its colour, with readable text (as Fastmail shows them). */
const eventLook = (color = '#3d8fd9') => ({
  backgroundColor: `color-mix(in srgb, ${color} 40%, var(--bg))`,
  textColor: 'var(--fg)',
  styles: [`--cal: ${color}`],
});

// A new event being made shows on the grid as a draft while its form is open.
const DRAFT = '__draft';
function showDraft(form: HTMLFormElement) {
  if (!ec || !editing || editing.event) return;
  const allDay = field(form, 'allDay').checked;
  const start = readStart(form);
  let end = readEnd(form);
  if (!start || !end) return;
  if (allDay) end = addDays(end, 1);
  ec.removeEventById(DRAFT);
  if (end.getTime() <= start.getTime()) return;
  const cal = calendars.find((c) => c.url === field(form, 'cal').value);
  ec.addEvent({ id: DRAFT, title: field(form, 'title').value.trim() || 'New event', start, end, allDay, ...eventLook(cal?.color), classNames: ['ec-draft'] });
}
const removeDraft = () => ec?.removeEventById(DRAFT);

/** Delete asks first, in the card: "Delete this event?" Delete / Keep. */
function confirmDelete(e: CalEvent) {
  const actions = $('calEvent').querySelector('.ceactions')!;
  render(actions, html`<span class="ceask">Delete this event?</span><button class="pill" data-keep>Keep</button><button class="pill danger" data-really>Delete</button>`);
  (actions.querySelector('[data-really]') as HTMLButtonElement).focus();
  (actions.querySelector('[data-keep]') as HTMLElement).onclick = () => showDetails(e.id);
  (actions.querySelector('[data-really]') as HTMLElement).onclick = async () => {
    render(actions, html`<span class="ceask">Deleting…</span>`);
    try {
      if (!(await ready)) throw new Error("Couldn't reach your calendars");
      await deleteEvent(e);
      hideDetails();
      changed();
      ec?.refetchEvents();
    } catch (err) {
      // Changed elsewhere: fetch the current version, so reopening it works.
      if (err instanceof EditConflict) dropCachedEvents(), ec?.refetchEvents();
      render(actions, html`<span class="ceerr">${(err as Error).message}</span><button class="pill" data-keep>OK</button>`);
      (actions.querySelector('[data-keep]') as HTMLElement).onclick = () => showDetails(e.id);
    }
  };
}

/** After a change: the background re-reads the coming reminders. */
const changed = () => {
  dropCachedEvents();
  browser.runtime.sendMessage('reminders-sync').catch(() => {});
};
/** Cached events are out of date (after a change, or a change made elsewhere). */
function dropCachedEvents() {
  if (cache) (cache.ranges = []), saveCache();
}

// --- The event form --------------------------------------------------------------------------------

const REMINDERS: [number, string][] = [
  [0, 'At the start'],
  [5, '5 minutes before'],
  [10, '10 minutes before'],
  [15, '15 minutes before'],
  [30, '30 minutes before'],
  [60, '1 hour before'],
  [120, '2 hours before'],
  [1440, '1 day before'],
  [2880, '2 days before'],
  [10080, '1 week before'],
];

const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** A local date (and time) from the form's inputs. */
function readDate(date: string, time = '00:00'): Date | undefined {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d, h || 0, min || 0);
}

function reminderSelect(minutes: number): Html {
  const known = REMINDERS.some(([m]) => m === minutes);
  const opts = [...REMINDERS, ...(known ? [] : [[minutes, `${minutes} minutes before`] as [number, string]])];
  return html`<span class="cealarm"><select name="alarm">${opts.map(([m, label]) => html`<option value="${m}"${m === minutes && ' selected'}>${label}</option>`)}</select><button type="button" class="icon" data-unalarm title="Remove">×</button></span>`;
}

/** Open the form: for `event`, or a new event with `start`/`end`/`allDay`. */
function openEditor(event: CalEvent | undefined, init?: { start: Date; end: Date; allDay: boolean }) {
  const writable = calendars;
  if (!writable.length) return;
  const calUrl = event?.calendarUrl ?? (writable.some((c) => c.url === defaultCal) ? defaultCal! : (writable.find((c) => !hiddenCals.has(c.url)) ?? writable[0]!).url);
  const allDay = event?.allDay ?? init?.allDay ?? false;
  const start = event?.start ?? init!.start;
  // All-day ends are exclusive; the form shows the last day.
  const end = event ? (allDay ? addDays(event.end, -1) : event.end) : allDay ? addDays(init!.end, -1) : init!.end;
  const box = $('calEvent');
  box.className = 'calevent editing';
  render(
    box,
    html`<form class="ceform" novalidate autocomplete="off">
      <input name="title" class="cetitle" placeholder="What" value="${event?.title === '(no title)' ? '' : event?.title}">
      <div class="cegrid">
        <span></span><label class="ceall"><input type="checkbox" name="allDay"${allDay && ' checked'}> All day</label>
        <span>Starts</span><div class="cewhen"><input type="date" name="sd" value="${dateValue(start)}" required><input type="time" name="st" step="300" value="${timeValue(start)}"></div>
        <span>Ends</span><div class="cewhen"><input type="date" name="ed" value="${dateValue(end)}" required><input type="time" name="et" step="300" value="${timeValue(end)}"></div>
        <span>Where</span><input name="location" placeholder="Add a place" value="${event?.location}">
        <span>Calendar</span><select name="cal">${writable.map((c) => html`<option value="${c.url}"${c.url === calUrl && ' selected'}>${c.name}</option>`)}</select>
        <span>Reminders</span><div class="cealarms">${(event?.alarms ?? []).filter((m) => m >= 0).map((m) => reminderSelect(m))}<button type="button" class="link" data-addalarm>Add reminder</button></div>
      </div>
      <textarea name="notes" rows="3" placeholder="Notes">${event?.notes}</textarea>
      <div class="ceerr" hidden></div>
      <div class="ceactions"><button type="button" class="pill" data-cancel>Cancel</button><button class="pill primary" data-save hidden>${event ? 'Save' : 'Create'}</button></div>
    </form>`,
  );
  box.hidden = false;
  delete box.dataset.id;
  const form = box.querySelector('form')!;
  editing = { event, initial: '' };
  syncAllDay(form);
  editing.initial = formState(form);
  // Times follow the start: moving it keeps the length.
  let prevStart = readStart(form);
  const shift = () => {
    const now = readStart(form);
    const endAt = readEnd(form);
    if (now && prevStart && endAt) {
      const moved = new Date(endAt.getTime() + (now.getTime() - prevStart.getTime()));
      (form.elements.namedItem('ed') as HTMLInputElement).value = dateValue(moved);
      (form.elements.namedItem('et') as HTMLInputElement).value = timeValue(moved);
    }
    prevStart = now;
  };
  field(form, 'sd').addEventListener('change', shift);
  field(form, 'st').addEventListener('change', shift);
  field(form, 'allDay').addEventListener('change', () => syncAllDay(form));
  form.addEventListener('input', () => onFormChange(form));
  form.addEventListener('change', () => onFormChange(form));
  form.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.closest('[data-cancel]')) return event ? showDetails(event.id) : hideDetails();
    if (t.closest('[data-addalarm]')) {
      insert(t.closest('[data-addalarm]')!, 'beforebegin', reminderSelect(event?.alarms.length ? 15 : 10));
      onFormChange(form);
    }
    if (t.closest('[data-unalarm]')) {
      t.closest('.cealarm')!.remove();
      onFormChange(form);
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save(form);
  });
  showDraft(form);
  field(form, 'title').focus();
}

const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
const readStart = (form: HTMLFormElement) => readDate(field(form, 'sd').value, field(form, 'allDay').checked ? undefined : field(form, 'st').value);
const readEnd = (form: HTMLFormElement) => readDate(field(form, 'ed').value, field(form, 'allDay').checked ? undefined : field(form, 'et').value);

function syncAllDay(form: HTMLFormElement) {
  const allDay = field(form, 'allDay').checked;
  for (const n of ['st', 'et']) field(form, n).hidden = allDay;
}

function formState(form: HTMLFormElement) {
  return JSON.stringify([...new FormData(form).entries()]);
}

/** Save (or Create) shows once there's a change to save. */
function onFormChange(form: HTMLFormElement) {
  if (!editing) return;
  showDraft(form);
  (form.querySelector('[data-save]') as HTMLElement).hidden = formState(form) === editing.initial;
  (form.querySelector('.ceerr') as HTMLElement).hidden = true;
}

function formError(form: HTMLFormElement, text: string) {
  const el = form.querySelector('.ceerr') as HTMLElement;
  el.textContent = text;
  el.hidden = false;
}

async function save(form: HTMLFormElement) {
  if (!editing || formState(form) === editing.initial) return;
  const allDay = field(form, 'allDay').checked;
  const start = readStart(form);
  let end = readEnd(form);
  if (!start || !end) return formError(form, 'Pick a date.');
  if (allDay) end = addDays(end, 1);
  if (end.getTime() <= start.getTime()) return formError(form, allDay ? 'It ends before it starts.' : 'It ends before (or as) it starts.');
  const target = calendars.find((c) => c.url === field(form, 'cal').value)!;
  const input: EventInput = {
    calendarUrl: target.url,
    title: field(form, 'title').value.trim(),
    location: field(form, 'location').value.trim(),
    notes: (form.elements.namedItem('notes') as HTMLTextAreaElement).value,
    allDay,
    start,
    end,
    alarms: [...new Set([...form.querySelectorAll<HTMLSelectElement>('select[name="alarm"]')].map((s) => Number(s.value)))],
  };
  const button = form.querySelector('[data-save]') as HTMLButtonElement;
  const label = button.textContent;
  button.textContent = 'Saving…';
  form.inert = true;
  try {
    if (!(await ready)) throw new Error("Couldn't reach your calendars");
    if (editing.event) await updateEvent(editing.event, input, target);
    else {
      await createEvent(target, input);
      defaultCal = target.url;
      updatePrefs({ calDefault: target.url });
    }
    hideDetails();
    changed();
    ec?.refetchEvents();
  } catch (e) {
    if (e instanceof EditConflict) dropCachedEvents(), ec?.refetchEvents();
    form.inert = false;
    button.textContent = label;
    formError(form, (e as Error).message);
  }
}

/** A new event: the next half hour, for an hour. */
export function newEvent(at?: Date, allDay = false, until?: Date) {
  if (!ec || !calendars.length) return;
  // Don't throw away a form with changes in it.
  const open = $('calEvent').querySelector('form');
  if (editing && open && formState(open) !== editing.initial) return field(open, 'title').focus();
  let start = at;
  if (!start) {
    start = new Date();
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() < 30 ? 30 : 60);
  }
  const end = until ?? (allDay ? addDays(start, 1) : new Date(start.getTime() + 3600e3));
  openEditor(undefined, { start, end, allDay });
}

/** The calendars as chips under the toolbar, in their colours: click one to show or hide it. */
function renderCalMenu() {
  render(
    $('calChips'),
    html`${calendars.map((c) => {
      const off = hiddenCals.has(c.url);
      return html`<button class="calchip${off && ' off'}" data-cal="${c.url}" aria-pressed="${String(!off)}" title="${off ? 'Show' : 'Hide'} ${c.name}">
        <span class="cdot" style="--cal:${c.color}"></span>${c.name}</button>`;
    })}`,
  );
  $('calChips').hidden = calendars.length === 0;
}

function setView(view: CalView) {
  for (const b of document.querySelectorAll<HTMLElement>('[data-cv]')) b.classList.toggle('on', b.dataset.cv === view);
  ec?.setOption('view', EC_VIEW[view]);
}

// --- Cache ---------------------------------------------------------------------------------------
// The calendars and the events last shown, kept in session storage (memory only; dropped on lock), so
// Calendar opens straight away with what was there before while it checks Fastmail again.

type StoredEvent = Omit<CalEvent, 'start' | 'end'> & { start: string; end: string };
interface CalCache {
  calendars: Calendar[];
  /** By range and calendars shown, newest last. */
  ranges: { key: string; at: number; events: StoredEvent[] }[];
}
const FRESH = 30e3;
let cache: CalCache | undefined;
let cacheLoaded: Promise<void> | undefined;

const loadCache = () =>
  (cacheLoaded ??= browser.storage.session.get('calCache').then((r) => void (cache = r.calCache as CalCache | undefined)));
const saveCache = () => browser.storage.session.set({ calCache: cache });
const revive = (e: StoredEvent): CalEvent => ({ ...e, start: new Date(e.start), end: new Date(e.end) });
const store = (e: CalEvent): StoredEvent => ({ ...e, start: e.start.toISOString(), end: e.end.toISOString() });

function cacheEvents(key: string, events: CalEvent[]) {
  if (!cache) return;
  cache.ranges = [...cache.ranges.filter((r) => r.key !== key), { key, at: Date.now(), events: events.map(store) }].slice(-8);
  saveCache();
}

/** Signed in and the calendar list read (from Fastmail, not the cache). */
let ready: Promise<boolean> | undefined;

async function connect(refresh: boolean): Promise<boolean> {
  const [unlocked, session] = await Promise.all([getUnlocked(), getCachedSession()]);
  try {
    dav = await connectCalendar(session, unlocked?.secrets.davPassword);
  } catch (e) {
    if (e instanceof NoCalendarPassword) {
      message(html`<p>${e.message}</p><button class="pill primary" id="calSetup">Open settings</button>`);
      document.getElementById('calSetup')!.onclick = () => browser.runtime.openOptionsPage();
    } else if (!calendars.length) message(html`<p>Couldn't reach your calendars: ${(e as Error).message}</p>`);
    return false;
  }
  try {
    const fresh = await listCalendars(dav);
    const changed = JSON.stringify(fresh.map((c) => [c.url, c.name, c.color])) !== JSON.stringify(calendars.map((c) => [c.url, c.name, c.color]));
    if (changed || refresh || !calendars.length) {
      calendars = fresh;
      cache = { calendars, ranges: changed ? [] : (cache?.ranges ?? []) };
      saveCache();
      renderCalMenu();
      if (changed && ec) ec.refetchEvents();
    }
  } catch (e) {
    const msg = /401/.test((e as Error).message) ? "Fastmail didn't accept the Calendar/Files password. Check it in settings." : (e as Error).message;
    if (!calendars.length) message(html`<p>${msg}</p>`);
    return false;
  }
  message();
  return true;
}

/** Events for a range: from the cache straight away (re-checked in the background if older than 30 s), else from Fastmail. */
async function rangeEvents(start: Date, end: Date): Promise<CalEvent[]> {
  const shown = calendars.filter((c) => !hiddenCals.has(c.url));
  const key = `${start.toISOString()}|${end.toISOString()}|${shown.map((c) => c.url).join(',')}`;
  const hit = cache?.ranges.find((r) => r.key === key);
  const fetchNow = async () => {
    if (!(await ready) || !dav) return undefined;
    const list = await eventsBetween(dav, shown, start, end);
    cacheEvents(key, list);
    return list;
  };
  if (hit) {
    if (Date.now() - hit.at > FRESH)
      fetchNow().then((list) => {
        if (list && JSON.stringify(list.map(store)) !== JSON.stringify(hit.events)) ec?.refetchEvents();
      }, () => {});
    return hit.events.map(revive);
  }
  return (await fetchNow()) ?? [];
}

/** Open (or refresh) the Calendar app. */
export async function showCalendar({ refresh = false } = {}) {
  const prefs = await getPrefs();
  hiddenCals = new Set(prefs.calHidden ?? []);
  defaultCal = prefs.calDefault;
  await loadCache();
  if (!calendars.length && cache?.calendars.length) calendars = cache.calendars;
  // With calendars from before, show them now; signing in and checking happen meanwhile.
  ready = connect(refresh);
  if (!calendars.length && !(await ready)) return;
  message();
  renderCalMenu();
  if (!ec) {
    await loadVendor();
    const view = (prefs.calView as CalView) ?? 'list';
    for (const b of document.querySelectorAll<HTMLElement>('[data-cv]')) b.classList.toggle('on', b.dataset.cv === view);
    ec = window.EventCalendar!.create($('calHost'), {
      view: EC_VIEW[view],
      headerToolbar: { start: '', center: '', end: '' },
      // The agenda is the next two weeks from today, not a calendar week.
      views: { listWeek: { duration: { days: 14 } } },
      height: '100%',
      firstDay: 1,
      nowIndicator: true,
      dayMaxEvents: true,
      scrollTime: '08:00:00',
      locale: navigator.language,
      eventTimeFormat: { hour: 'numeric', minute: '2-digit' },
      selectable: true,
      // Double-click an empty time (or day) for a new event there (an hour long; see initCalendar);
      // dragging across times or days makes one that long. A single click does nothing.
      dateClick: (info: { date: Date; allDay: boolean }) => (lastClick = { date: info.date, allDay: info.allDay, at: performance.now() }),
      select: (info: { start: Date; end: Date; allDay: boolean }) => {
        ec?.unselect();
        const span = info.end.getTime() - info.start.getTime();
        if (info.allDay ? span <= 864e5 : span <= 30 * 60e3) return;
        newEvent(info.start, info.allDay, info.end);
      },
      eventMouseEnter: (info: { event: { id: string; title: string }; el: HTMLElement }) => showTip(info.event, info.el),
      eventMouseLeave: () => hideTip(),
      eventSources: [
        {
          events: async (info: { start: Date; end: Date }) => {
            const list = await rangeEvents(info.start, info.end);
            byId = new Map(list.map((e) => [e.id, e]));
            const color = new Map(calendars.map((c) => [c.url, c.color]));
            return list.map((e) => ({
              id: e.id,
              title: e.title,
              start: e.start,
              end: e.end,
              allDay: e.allDay,
              ...eventLook(color.get(e.calendarUrl)),
            }));
          },
        },
      ],
      eventClick: (info: { event: { id: string } }) => {
        hideTip();
        if (info.event.id === DRAFT) return ($('calEvent').querySelector<HTMLInputElement>('input[name="title"]'))?.focus();
        showDetails(info.event.id);
      },
      datesSet: (info: { view: { title: string } }) => ($('calTitle').textContent = info.view.title),
      loading: (on: boolean) => $('calendarView').classList.toggle('loading', on),
    });
  } else ec.refetchEvents();
}

// --- Tooltip -------------------------------------------------------------------------------------
// Week and month cells are small: hovering an event shows it in full straight away.

let lastClick: { date: Date; allDay: boolean; at: number } | undefined;

function showTip(ev: { id: string; title: string }, el: HTMLElement) {
  const e = byId.get(ev.id);
  const tip = $('calTip');
  render(tip, e ? html`<b>${e.title}</b><div>${whenText(e)}</div>${e.location && html`<div class="muted">${e.location}</div>`}` : html`<b>${ev.title}</b>`);
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left), innerWidth - t.width - 8);
  const below = r.bottom + 6 + t.height < innerHeight;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(below ? r.bottom + 6 : r.top - t.height - 6)}px`;
}
const hideTip = () => ($('calTip').hidden = true);

/** Calendar keys (Fastmail's): t today, c new event, j / k next / previous, a / w / m views. */
export function calendarKey(e: KeyboardEvent): boolean {
  if (!ec || editing) return false;
  if (e.key === 't') ec.setOption('date', new Date());
  else if (e.key === 'c') newEvent();
  else if (e.key === 'j') ec.next();
  else if (e.key === 'k') ec.prev();
  else if (e.key === 'a') pickView('list');
  else if (e.key === 'w') pickView('week');
  else if (e.key === 'm') pickView('month');
  else return false;
  return true;
}

function pickView(view: CalView) {
  setView(view);
  updatePrefs({ calView: view });
}

export function initCalendar() {
  $('calPrev').onclick = () => ec?.prev();
  $('calNext').onclick = () => ec?.next();
  $('calToday').onclick = () => ec?.setOption('date', new Date());
  for (const b of document.querySelectorAll<HTMLElement>('[data-cv]')) b.onclick = () => pickView(b.dataset.cv as CalView);
  $('calChips').onclick = (e) => {
    const url = (e.target as Element).closest<HTMLElement>('[data-cal]')?.dataset.cal;
    if (!url) return;
    if (hiddenCals.has(url)) hiddenCals.delete(url);
    else hiddenCals.add(url);
    updatePrefs({ calHidden: [...hiddenCals] });
    renderCalMenu();
    ec?.refetchEvents();
  };
  $('calNew').onclick = () => newEvent();
  $('calHost').addEventListener('dblclick', (e) => {
    if ((e.target as Element).closest('.ec-event') || !lastClick || performance.now() - lastClick.at > 700) return;
    newEvent(lastClick.date, lastClick.allDay);
  });
  $('calHost').addEventListener('scroll', hideTip, true);
  $('calEvent').addEventListener('click', (e) => {
    const t = e.target as Element;
    const event = byId.get($('calEvent').dataset.id ?? '');
    if (t.closest('[data-close]')) hideDetails();
    else if (event && t.closest('[data-edit]')) openEditor(event);
    else if (event && t.closest('[data-delete]')) confirmDelete(event);
  });
  // Esc closes the card or form (first, in capture: EventCalendar's focused events keep their keys).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || $('calEvent').hidden || document.body.dataset.app !== 'calendar') return;
      e.preventDefault();
      e.stopPropagation();
      const back = editing?.event;
      if (back && byId.has(back.id)) showDetails(back.id);
      else hideDetails();
    },
    true,
  );
}
