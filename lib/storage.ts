import { browser } from 'wxt/browser';
import type { InboxState, Session } from './jmap';
import type { Secrets, Vault } from './vault';

export interface Settings {
  /** The encrypted secrets (see lib/vault.ts). Plaintext is never persisted. */
  vault?: Vault;
  intervalMinutes: number;
  /** Keep a JMAP push stream open for instant updates (polling continues as a fallback). */
  push: boolean;
}

export const DEFAULT_SETTINGS: Settings = { intervalMinutes: 1, push: true };

export async function getSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings>) };
}

export async function saveSettings(s: Settings) {
  await browser.storage.local.set({ settings: s });
}

/**
 * The unlocked vault: secrets plus the data key (to save changes without unlocking again). Kept in
 * memory only (storage.session), cleared when the browser closes.
 */
export interface Unlocked {
  secrets: Secrets;
  dataKey: string;
}

export async function getUnlocked(): Promise<Unlocked | undefined> {
  const { unlocked } = await browser.storage.session.get('unlocked');
  return unlocked as Unlocked | undefined;
}

export async function setUnlocked(u: Unlocked) {
  await browser.storage.session.set({ unlocked: u });
}

export async function getUnlockedToken(): Promise<string | undefined> {
  return (await getUnlocked())?.secrets.token;
}

/** Forget the unlocked secrets (the popup then asks to unlock again). */
export async function lockNow() {
  await browser.storage.session.remove('unlocked');
}

export interface Status {
  state?: InboxState;
  error?: string;
  /** A vault exists but isn't unlocked this browser session. */
  locked?: boolean;
  checkedAt?: number;
}

/** How updates are currently arriving; drives the popup's status dot. */
export interface Conn {
  mode: 'push' | 'poll' | 'error';
  detail: string;
  since: number;
}

export async function getConn(): Promise<Conn | undefined> {
  const { conn } = await browser.storage.local.get('conn');
  return conn as Conn | undefined;
}

export async function getStatus(): Promise<Status> {
  const { status } = await browser.storage.local.get('status');
  return (status as Status) ?? {};
}

/** JMAP session cached by the background script after its first successful poll. */
export async function getCachedSession(): Promise<Session | undefined> {
  const { session } = await browser.storage.local.get('session');
  return session as Session | undefined;
}
