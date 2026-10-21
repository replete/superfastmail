// Calendar reminders as desktop notifications, run by the background. Every 15 minutes (and when
// unlocking, or after an edit) it reads the reminders due in the next day and sets an alarm for
// each. The schedule (titles included) lives in session storage, which the browser keeps in memory
// only, and it's dropped on lock. A reminder missed by more than 10 minutes (the computer was
// asleep, say) is skipped rather than shown late.
import { browser } from 'wxt/browser';
import { calendarClient, eventsBetween, listCalendars, type CalEvent } from './calendar';
import { getPrefs } from './prefs';
import { getCachedSession, getUnlocked } from './storage';

export const SYNC_ALARM = 'cal-reminders';
const PREFIX = 'rem|';
const LATE = 10 * 60e3;
const HORIZON = 24 * 3600e3;
/** The longest reminder offered (a week), so events that far out are read too. */
const LONGEST = 7 * 24 * 3600e3;

export interface Due {
  title: string;
  location: string;
  allDay: boolean;
  start: number;
  end: number;
  /** When to show it. */
  at: number;
}

type Store = { calDue?: Record<string, Due>; calFired?: Record<string, number>; calSyncedAt?: number };

export const isReminderAlarm = (name: string) => name.startsWith(PREFIX);

/** Drop the schedule and its alarms (locked, switched off, or no Calendar password). */
export async function clearReminders() {
  for (const a of await browser.alarms.getAll()) if (isReminderAlarm(a.name)) await browser.alarms.clear(a.name);
  await browser.storage.session.remove(['calDue', 'calSyncedAt']);
}

/** Reminders due between `now - LATE` and `now + HORIZON`, keyed by occurrence and offset. */
export function dueReminders(events: CalEvent[], now: number): Record<string, Due> {
  const out: Record<string, Due> = {};
  for (const e of events)
    for (const m of e.alarms) {
      const at = e.start.getTime() - m * 60e3;
      if (at < now - LATE || at > now + HORIZON) continue;
      out[`${e.id}|${m}`] = { title: e.title, location: e.location, allDay: e.allDay, start: e.start.getTime(), end: e.end.getTime(), at };
    }
  return out;
}

/** Sync unless it happened in the last 15 minutes (the background wakes often; each sync is several requests). */
export async function syncRemindersIfStale(log: (...a: unknown[]) => void = () => {}) {
  const { calSyncedAt = 0 } = (await browser.storage.session.get('calSyncedAt')) as Store;
  if (Date.now() - calSyncedAt > 15 * 60e3) await syncReminders(log);
}

/** Read the coming reminders and (re)set their alarms. */
export async function syncReminders(log: (...a: unknown[]) => void = () => {}) {
  const [prefs, unlocked, session] = await Promise.all([getPrefs(), getUnlocked(), getCachedSession()]);
  const password = unlocked?.secrets.davPassword;
  if (!prefs.calReminders || !password || !session?.username) return clearReminders();
  const now = Date.now();
  const dav = await calendarClient(session.username, password);
  // Calendars switched off in the Calendar view don't remind either.
  const hidden = new Set(prefs.calHidden ?? []);
  const calendars = (await listCalendars(dav)).filter((c) => !hidden.has(c.url));
  const events = await eventsBetween(dav, calendars, new Date(now - LATE - LONGEST), new Date(now + HORIZON + LONGEST));
  const due = dueReminders(events, now);
  const { calFired = {} } = (await browser.storage.session.get('calFired')) as Store;
  // Remember what's been shown for two days, so a re-sync doesn't show it again.
  for (const [k, at] of Object.entries(calFired)) if (at < now - 2 * HORIZON) delete calFired[k];
  for (const a of await browser.alarms.getAll()) if (isReminderAlarm(a.name) && !due[a.name.slice(PREFIX.length)]) await browser.alarms.clear(a.name);
  let set = 0;
  for (const [key, d] of Object.entries(due)) {
    if (calFired[key] === d.at) continue;
    await browser.alarms.create(PREFIX + key, { when: Math.max(d.at, now + 1000) });
    set++;
  }
  await browser.storage.session.set({ calDue: due, calFired, calSyncedAt: now });
  log('reminders: synced,', set, 'due in the next day');
}

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "In 15 minutes · 10:00–10:30 · High Street", "Tomorrow, all day", … */
export function reminderText(d: Due, now = Date.now()): string {
  const day = (t: number) => new Date(t).toDateString();
  const tomorrow = new Date(now + 864e5).toDateString();
  let when: string;
  if (d.allDay) when = day(d.start) === day(now) ? 'Today, all day' : day(d.start) === tomorrow ? 'Tomorrow, all day' : new Date(d.start).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  else {
    const mins = Math.round((d.start - now) / 60e3);
    const span = `${time(d.start)}–${time(d.end)}`;
    when =
      mins <= 0 ? `Now · ${span}` : mins < 60 ? `In ${mins} minute${mins === 1 ? '' : 's'} · ${span}` : day(d.start) === day(now) ? `Today, ${span}` : day(d.start) === tomorrow ? `Tomorrow, ${span}` : `${new Date(d.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${span}`;
  }
  return d.location ? `${when} · ${d.location}` : when;
}

/** A reminder alarm went off: what to show, or nothing (shown already, too late, or gone). */
export async function takeReminder(alarmName: string): Promise<{ key: string; due: Due } | undefined> {
  const key = alarmName.slice(PREFIX.length);
  const { calDue = {}, calFired = {} } = (await browser.storage.session.get(['calDue', 'calFired'])) as Store;
  const due = calDue[key];
  if (!due || calFired[key] === due.at || Date.now() - due.at > LATE) return undefined;
  calFired[key] = due.at;
  await browser.storage.session.set({ calFired });
  return { key, due };
}
