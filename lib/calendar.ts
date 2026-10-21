// Calendars over CalDAV (Fastmail offers them to apps only that way), with the DAV app password.
// tsdav does the protocol (discovery, queries, conditional writes) and ical.js the iCalendar.
// Display ranges use server-side expansion (`<C:expand>`: Fastmail returns each occurrence of a
// recurring event in UTC with its RECURRENCE-ID, and keeps its VALARMs), so no RRULE maths here.
// Loaded on demand (dynamic import), so the popup doesn't pay for it until Calendar opens.
import ICAL from 'ical.js';
import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from 'tsdav';
import type { Session } from './jmap';
import { localTimezone } from './timezone';

export interface Calendar {
  url: string;
  name: string;
  color: string;
  ctag?: string;
  /** For writes (etag checks) and queries. */
  dav: DAVCalendar;
}

export interface CalEvent {
  /** Unique per occurrence. */
  id: string;
  /** The stored object (all occurrences of a recurring event share it). */
  url: string;
  etag?: string;
  calendarUrl: string;
  uid: string;
  title: string;
  location: string;
  notes: string;
  allDay: boolean;
  /** Timed: instants. All-day: local dates, `end` exclusive (the day after the last day). */
  start: Date;
  end: Date;
  recurring: boolean;
  /** Reminders, as minutes before the start (negative = after). */
  alarms: number[];
}

type Client = Awaited<ReturnType<typeof createDAVClient>>;
let client: { key: string; dav: Client; auth: string } | undefined;

/** A signed-in CalDAV client (cached while the password and user stay the same). */
export async function calendarClient(username: string, password: string): Promise<Client> {
  const key = `${username}\n${password}`;
  if (client?.key === key) return client.dav;
  const dav = await createDAVClient({
    serverUrl: __CALDAV_URL__,
    credentials: { username, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
    // Never let a 401 open the browser's own login box.
    fetch: (url, init) => fetch(url, { ...init, credentials: 'omit' }),
  });
  client = { key, dav, auth: `Basic ${btoa(`${username}:${password}`)}` };
  return dav;
}

export const forgetClient = () => (client = undefined);

/** A DAV property's text: tsdav gives a string, or an object for CDATA (Fastmail's colours) or mixed content. */
function davText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as { _cdata?: unknown; _text?: unknown };
    return davText(o._cdata) ?? davText(o._text);
  }
  return undefined;
}

/** Calendars that hold events (task lists are left out), in the server's order. */
export async function listCalendars(dav: Client): Promise<Calendar[]> {
  const cals = await dav.fetchCalendars();
  return cals
    .filter((c) => (c.components ?? []).includes('VEVENT'))
    .map((c) => ({
      url: c.url,
      name: davText(c.displayName)?.trim() || 'Calendar',
      // Apple's calendar-color is #RRGGBB or #RRGGBBAA.
      color: /^#[0-9a-f]{6}/i.test(davText(c.calendarColor)?.trim() ?? '') ? davText(c.calendarColor)!.trim().slice(0, 7) : '#3d8fd9',
      ctag: davText(c.ctag),
      dav: c,
    }));
}

/** Minutes before the start, from a relative VALARM trigger (absolute ones aren't used here). */
function alarmMinutes(vevent: ICAL.Component): number[] {
  return vevent
    .getAllSubcomponents('valarm')
    .map((a) => a.getFirstProperty('trigger'))
    .filter((t) => t?.getParameter('related') !== 'END')
    .map((t) => t?.getFirstValue())
    .filter((t): t is ICAL.Duration => t instanceof ICAL.Duration)
    .map((d) => -Math.round(d.toSeconds() / 60));
}

/** All-day dates are local calendar days (not instants): build them as local midnights. */
const localDay = (t: ICAL.Time) => new Date(t.year, t.month - 1, t.day);

/** Parse one stored (or expanded) object into its occurrences. */
export function parseObject(obj: DAVCalendarObject, calendarUrl: string): CalEvent[] {
  if (!obj.data) return [];
  const root = new ICAL.Component(ICAL.parse(obj.data));
  return root.getAllSubcomponents('vevent').map((vevent) => {
    const e = new ICAL.Event(vevent);
    const allDay = e.startDate.isDate;
    const start = allDay ? localDay(e.startDate) : e.startDate.toJSDate();
    let end: Date;
    if (e.endDate) end = allDay ? localDay(e.endDate) : e.endDate.toJSDate();
    else end = allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) : new Date(start.getTime() + 3600e3);
    const rid = vevent.getFirstPropertyValue('recurrence-id') as ICAL.Time | null;
    return {
      id: `${obj.url}#${rid ? rid.toString() : ''}`,
      url: obj.url,
      etag: obj.etag,
      calendarUrl,
      uid: e.uid,
      title: e.summary || '(no title)',
      location: e.location || '',
      notes: e.description || '',
      allDay,
      start,
      end,
      recurring: Boolean(rid) || vevent.hasProperty('rrule'),
      alarms: alarmMinutes(vevent),
    };
  });
}

/** Every occurrence between `from` and `to` in the given calendars (expanded by the server). */
export async function eventsBetween(dav: Client, calendars: Calendar[], from: Date, to: Date): Promise<CalEvent[]> {
  const lists = await Promise.all(
    calendars.map(async (c) => {
      const objs = await dav.fetchCalendarObjects({
        calendar: c.dav,
        timeRange: { start: from.toISOString(), end: to.toISOString() },
        expand: true,
      });
      return objs.flatMap((o) => parseObject(o, c.url));
    }),
  );
  return lists.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
}

// --- Writing ------------------------------------------------------------------------------------
// Single events only (not repeating ones). Edits change the stored object in place, so whatever this
// app doesn't show (guests, other apps' properties) is kept. Every write is conditional on the ETag
// the event was shown with: if it changed elsewhere meanwhile, the server refuses (412) instead of
// overwriting.

/** What the event form edits. All-day: local dates with `end` exclusive, as in CalEvent. */
export interface EventInput {
  calendarUrl: string;
  title: string;
  location: string;
  notes: string;
  allDay: boolean;
  start: Date;
  end: Date;
  /** Minutes before the start. */
  alarms: number[];
}

export class EditConflict extends Error {}

const PRODID = '-//replete//Super Fastmail//EN';

async function davFetch(url: string, init: RequestInit): Promise<Response> {
  if (!client) throw new Error('Not signed in to calendars');
  const res = await fetch(url, { ...init, credentials: 'omit', headers: { Authorization: client.auth, ...init.headers } });
  if (res.status === 412) throw new EditConflict('This event was changed somewhere else. Reopen it and try again.');
  if (res.status === 403) throw new Error("Fastmail didn't allow this change (read-only calendar or password).");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const dateOnly = (d: Date) => ICAL.Time.fromData({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), isDate: true });
const wallTime = (d: Date) =>
  ICAL.Time.fromData({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: 0, isDate: false });

function setTime(vevent: ICAL.Component, name: 'dtstart' | 'dtend', d: Date, allDay: boolean, tz: { tzid: string } | undefined) {
  vevent.removeAllProperties(name);
  const p = new ICAL.Property(name);
  if (allDay) p.setValue(dateOnly(d));
  else if (tz) {
    p.setValue(wallTime(d));
    p.setParameter('tzid', tz.tzid);
  } else p.setValue(ICAL.Time.fromJSDate(d, true));
  vevent.addProperty(p);
}

function setText(vevent: ICAL.Component, name: string, value: string) {
  vevent.removeAllProperties(name);
  if (value) vevent.addPropertyWithValue(name, value);
}

/** Write the form's fields into a VEVENT (and the zone they use into its VCALENDAR). */
function apply(root: ICAL.Component, vevent: ICAL.Component, input: EventInput) {
  const tz = input.allDay ? undefined : localTimezone(input.start);
  setText(vevent, 'summary', input.title);
  setText(vevent, 'location', input.location);
  setText(vevent, 'description', input.notes);
  setTime(vevent, 'dtstart', input.start, input.allDay, tz);
  vevent.removeAllProperties('duration');
  setTime(vevent, 'dtend', input.end, input.allDay, tz);

  // Reminders at or before the start are the form's; others (after the start, at a set time, or
  // relative to the end) stay as they are.
  for (const a of vevent.getAllSubcomponents('valarm')) {
    const trigger = a.getFirstProperty('trigger');
    const value = trigger?.getFirstValue();
    if (value instanceof ICAL.Duration && value.toSeconds() <= 0 && trigger!.getParameter('related') !== 'END') vevent.removeSubcomponent(a);
  }
  for (const m of input.alarms) {
    const a = new ICAL.Component('valarm');
    a.addPropertyWithValue('action', 'DISPLAY');
    a.addPropertyWithValue('description', input.title || 'Reminder');
    a.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-m * 60));
    vevent.addSubcomponent(a);
  }

  const now = ICAL.Time.fromJSDate(new Date(), true);
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
  const seq = vevent.getFirstPropertyValue('sequence');
  if (seq !== null) vevent.updatePropertyWithValue('sequence', Number(seq) + 1);

  // The object carries the definition of every zone it uses, and only those.
  if (tz && !root.getAllSubcomponents('vtimezone').some((z) => z.getFirstPropertyValue('tzid') === tz.tzid)) {
    root.addSubcomponent(new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${tz.vtimezone}\r\nEND:VCALENDAR`)).getFirstSubcomponent('vtimezone')!);
  }
  const used = new Set<string>();
  for (const v of root.getAllSubcomponents())
    for (const p of v.getAllProperties()) {
      const id = p.getParameter('tzid');
      if (typeof id === 'string') used.add(id);
    }
  for (const z of root.getAllSubcomponents('vtimezone')) if (!used.has(String(z.getFirstPropertyValue('tzid')))) root.removeSubcomponent(z);
}

const put = (url: string, ics: string, condition: Record<string, string>) =>
  davFetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...condition }, body: ics });

/** A new event in `calendar`. */
export async function createEvent(calendar: Calendar, input: EventInput): Promise<void> {
  const uid = crypto.randomUUID();
  const root = new ICAL.Component('vcalendar');
  root.addPropertyWithValue('prodid', PRODID);
  root.addPropertyWithValue('version', '2.0');
  root.addPropertyWithValue('calscale', 'GREGORIAN');
  const vevent = new ICAL.Component('vevent');
  vevent.addPropertyWithValue('uid', uid);
  vevent.addPropertyWithValue('created', ICAL.Time.fromJSDate(new Date(), true));
  root.addSubcomponent(vevent);
  apply(root, vevent, input);
  await put(new URL(`${uid}.ics`, calendar.url).href, root.toString(), { 'If-None-Match': '*' });
}

/** Change a single (not repeating) event; a new calendar moves it there. */
export async function updateEvent(event: CalEvent, input: EventInput, target: Calendar): Promise<void> {
  if (event.recurring) throw new Error("Repeating events can't be changed here yet");
  const res = await davFetch(event.url, { method: 'GET' });
  const etag = event.etag ?? res.headers.get('ETag') ?? undefined;
  const root = new ICAL.Component(ICAL.parse(await res.text()));
  const vevent = root.getFirstSubcomponent('vevent');
  if (!vevent || root.getAllSubcomponents('vevent').length > 1) throw new Error("This event can't be changed here");
  apply(root, vevent, input);
  const ics = root.toString();
  if (target.url === event.calendarUrl) return void (await put(event.url, ics, etag ? { 'If-Match': etag } : {}));
  // Moving calendars: the copy first, then the original goes (only if it's unchanged).
  const name = event.url.split('/').pop()!;
  await put(new URL(name, target.url).href, ics, { 'If-None-Match': '*' });
  await davFetch(event.url, { method: 'DELETE', headers: etag ? { 'If-Match': etag } : {} });
}

/** Delete a single (not repeating) event. */
export async function deleteEvent(event: CalEvent): Promise<void> {
  if (event.recurring) throw new Error("Repeating events can't be deleted here yet");
  await davFetch(event.url, { method: 'DELETE', headers: event.etag ? { 'If-Match': event.etag } : {} });
}

/** Sign in with what the vault holds; a clear error if there's no Calendar password yet. */
export async function connectCalendar(session: Session | undefined, davPassword: string | undefined) {
  if (!davPassword) throw new NoCalendarPassword('Add a Calendar/Files password in settings to see your calendars.');
  if (!session?.username) throw new Error('Not connected yet');
  return calendarClient(session.username, davPassword);
}

export class NoCalendarPassword extends Error {}
