import { browser } from 'wxt/browser';
import type { View } from './jmap';
import type { SoundId } from './sounds';

// UI preferences, kept apart from `settings` because a settings change resets the connection.
export interface Prefs {
  /** Which app the popup shows. */
  app: 'mail' | 'contacts' | 'masked' | 'calendar' | 'files' | 'settings' | 'help';
  view: View;
  /** The folder the list shows (a mailbox id); unset = Inbox. */
  mailbox?: string;
  /** Calendar: the view, and calendars switched off (by URL). */
  calView?: 'list' | 'week' | 'month';
  calHidden?: string[];
  /** The calendar new events go in (the last one used). */
  calDefault?: string;
  density: 'comfortable' | 'compact';
  theme: 'system' | 'light' | 'dark';
  /** Notifications are muted until this epoch ms (0 = off). */
  dndUntil: number;
  /** New-mail sound and its volume (0–1). */
  sound: SoundId;
  volume: number;
  /** A desktop notification for new mail (the sound plays either way). */
  mailNotify: boolean;
  /** Calendar reminders as desktop notifications (needs the Calendar/Files password). */
  calReminders: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  app: 'mail',
  view: 'unread',
  density: 'comfortable',
  theme: 'system',
  dndUntil: 0,
  sound: 'nice',
  volume: 0.6,
  mailNotify: true,
  calReminders: true,
};

export async function getPrefs(): Promise<Prefs> {
  const { prefs } = await browser.storage.local.get('prefs');
  return { ...DEFAULT_PREFS, ...(prefs as Partial<Prefs>) };
}

export async function updatePrefs(patch: Partial<Prefs>) {
  await browser.storage.local.set({ prefs: { ...(await getPrefs()), ...patch } });
}

export type DndChoice = '30m' | '1h' | 'tomorrow' | 'off';

export const DND_CHOICES: [DndChoice, string][] = [
  ['30m', 'For 30 minutes'],
  ['1h', 'For 1 hour'],
  ['tomorrow', 'Until tomorrow 8:00'],
  ['off', 'Turn off'],
];

export function dndUntilFor(choice: DndChoice, now = new Date()): number {
  if (choice === '30m') return now.getTime() + 30 * 60_000;
  if (choice === '1h') return now.getTime() + 60 * 60_000;
  if (choice === 'tomorrow') {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(8, 0, 0, 0);
    return t.getTime();
  }
  return 0;
}

export const dndActive = (p: Prefs) => Date.now() < p.dndUntil;

export function dndLabel(p: Prefs): string {
  if (!dndActive(p)) return 'off';
  const d = new Date(p.dndUntil);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `until ${time}` : `until tomorrow ${time}`;
}
