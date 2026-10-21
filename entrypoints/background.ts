import { browser } from 'wxt/browser';
import {
  AuthError,
  fetchInbox,
  fetchVipEmails,
  findInboxId,
  getSession,
  SESSION_VERSION,
  type Session,
} from '@/lib/jmap';
import { debugLog } from '@/lib/debuglog';
import { DND_CHOICES, dndActive, dndLabel, dndUntilFor, getPrefs, updatePrefs, type DndChoice, type Prefs } from '@/lib/prefs';
import { clearReminders, isReminderAlarm, reminderText, SYNC_ALARM, syncReminders, syncRemindersIfStale, takeReminder } from '@/lib/reminders';
import { connectPush, ServerClosedError } from '@/lib/push';
import { playFromBackground } from '@/lib/sounds';
import { passkeyName } from '@/lib/passkey';
import { getSettings, getUnlockedToken, saveSettings, setUnlocked, type Conn, type Status } from '@/lib/storage';
import { createVault, openVault, type Vault } from '@/lib/vault';

const ALARM = 'poll';
const log = debugLog;

/** Set while this script unlocks a "don't lock" vault itself, so the storage listener ignores it. */
let selfUnlocking = false;

function lockedMessage(vault?: Vault) {
  if (!vault) return 'No API token set';
  const w = vault.wrap;
  if (w.method === 'passphrase') return 'Locked: enter your password';
  if (w.method === 'passkey') return `Locked: unlock with your ${passkeyName(w.kind)}`;
  return "Locked: couldn't unlock automatically";
}

// Push stream (lives only as long as this background context; the alarm restarts it).
let push: AbortController | undefined;
let pushConnected = false;
let pushFailures = 0;
let pushPausedUntil = 0;
let pushPausedReason = '';

let lastConn = '';
async function setConn(mode: Conn['mode'], detail: string) {
  if (lastConn === mode + detail) return;
  lastConn = mode + detail;
  await browser.storage.local.set({ conn: { mode, detail, since: Date.now() } satisfies Conn });
}

function pollingDetail(intervalMinutes: number, pushEnabled: boolean) {
  const every = intervalMinutes === 1 ? 'every minute' : `every ${intervalMinutes} min`;
  if (!pushEnabled) return `Polling ${every} (live updates are off in Settings)`;
  if (Date.now() < pushPausedUntil) {
    const until = new Date(pushPausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `Polling ${every}; push paused until ${until} (${pushPausedReason})`;
  }
  return `Polling ${every}; connecting push…`;
}

function startPush(token: string, session: Session) {
  if (push || !session.eventSourceUrl || Date.now() < pushPausedUntil) return;
  const ac = connectPush({
    token,
    session,
    onOpen: () => {
      pushConnected = true;
      log('push: connected');
      setConn('push', 'Live: push connected');
    },
    onEvent: (type) => {
      log('push: event', type);
      // Only a ping proves the stream is healthy (a stream can open and be closed seconds later).
      if (type === 'ping') pushFailures = 0;
    },
    onChange: () => {
      log('push: change');
      schedulePoll();
    },
    onClose: (err) => {
      if (push !== ac) return; // stopped or superseded
      push = undefined;
      pushConnected = false;
      log('push: closed', err instanceof Error ? err.message : '');
      if (err instanceof AuthError) return;
      // Reconnect via poll (which restarts push), backing off on repeated failures. If the server
      // closed us (another client holds this token's stream), wait much longer; alarms keep polling.
      const delay =
        err instanceof ServerClosedError
          ? Math.min(30 * 60_000, 15_000 * 2 ** pushFailures++)
          : Math.min(60_000, 2_000 * 2 ** pushFailures++);
      pushPausedUntil = Date.now() + delay;
      pushPausedReason =
        err instanceof ServerClosedError ? 'this token is streaming elsewhere' : 'connection dropped';
      log('push: retry in', Math.round(delay / 1000), 's');
      getSettings().then((s) => setConn('poll', pollingDetail(s.intervalMinutes, true)));
      setTimeout(poll, delay);
    },
  });
  push = ac;
}

function stopPush() {
  const ac = push;
  push = undefined;
  pushConnected = false;
  pushPausedUntil = 0;
  pushFailures = 0;
  ac?.abort();
}

let debounce: ReturnType<typeof setTimeout> | undefined;
function schedulePoll() {
  clearTimeout(debounce);
  debounce = setTimeout(poll, 300);
}

// Serialise polls; a request that arrives mid-poll triggers exactly one more.
let polling: Promise<void> | undefined;
let pollAgain = false;
function poll(): Promise<void> {
  if (polling) {
    pollAgain = true;
    // Resolve after the follow-up poll too, so callers see fresh results. (Our .then runs after
    // the .finally below has already started that poll.)
    return polling.then(() => polling);
  }
  polling = doPoll().finally(() => {
    polling = undefined;
    if (pollAgain) {
      pollAgain = false;
      poll();
    }
  });
  return polling;
}

const ICON = { 16: '/icon/toolbar-16.png', 32: '/icon/toolbar-32.png' };
const LOCKED_ICON = { 16: '/icon/toolbar-off-16.png', 32: '/icon/toolbar-off-32.png' };

async function setStatus(status: Status) {
  await browser.storage.local.set({ status });
  // Locked or not set up: red-tinted icon, no badge (there's nothing to count).
  const off = Boolean(status.locked || (status.error && !(await getSettings()).vault));
  await browser.action.setIcon({ path: off ? LOCKED_ICON : ICON });
  await browser.action.setTitle({ title: off ? `Super Fastmail · ${status.locked ? 'locked' : 'not set up'}` : 'Super Fastmail' });
  await browser.action.setBadgeTextColor({ color: '#ffffff' });
  if (off) {
    await browser.action.setBadgeText({ text: '' });
  } else if (status.error) {
    await browser.action.setBadgeText({ text: '!' });
    await browser.action.setBadgeBackgroundColor({ color: '#888888' });
  } else {
    const n = status.state?.unread ?? 0;
    await browser.action.setBadgeText({ text: n ? String(n) : '' });
    await browser.action.setBadgeBackgroundColor({ color: '#d33' });
  }
}

// Notification high-water mark: newest receivedAt already considered, so switching views or
// list sizes never re-notifies old mail.
async function cached(): Promise<{ session?: Session; inboxId?: string; highWater?: string }> {
  return (await browser.storage.local.get(['session', 'inboxId', 'highWater'])) as any;
}

const FASTMAIL_URL = 'https://app.fastmail.com/mail/';

async function notify(id: string, title: string, message: string, sound: boolean) {
  const prefs = await getPrefs();
  await browser.notifications.create(id, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png' as any),
    title,
    message,
    // Chrome would add the OS sound on top of ours; Firefox rejects the option.
    ...(import.meta.env.BROWSER === 'chrome' && prefs.sound !== 'none' ? { silent: true } : {}),
  });
  if (sound) await chime(prefs);
}

const chime = (prefs: Prefs) =>
  playFromBackground(prefs.sound, prefs.volume).then(
    () => log('sound: played', prefs.sound),
    (e) => log('sound: failed', (e as Error).message),
  );

// VIP addresses (members of the "VIPs" contact group), cached briefly.
const VIP_TTL = 10 * 60_000;
async function vipAddresses(token: string, session: Session): Promise<string[]> {
  const { vipEmails } = (await browser.storage.local.get('vipEmails')) as { vipEmails?: { at: number; emails: string[] } };
  if (vipEmails && Date.now() - vipEmails.at < VIP_TTL) return vipEmails.emails;
  const emails = await fetchVipEmails(token, session);
  await browser.storage.local.set({ vipEmails: { at: Date.now(), emails } });
  return emails;
}

async function openOptions() {
  try {
    await browser.runtime.openOptionsPage();
  } catch {
    await browser.tabs.create({ url: browser.runtime.getURL('/options.html' as any) });
  }
}

// Toolbar right-click menu (Checker Plus style).
async function createMenus() {
  await browser.contextMenus.removeAll();
  const ctx = { contexts: ['action'] as ['action'] };
  browser.contextMenus.create({ id: 'open', title: 'Open Fastmail', ...ctx });
  browser.contextMenus.create({ id: 'refresh', title: 'Refresh', ...ctx });
  browser.contextMenus.create({ id: 'dnd', title: 'Do Not Disturb', ...ctx });
  for (const [choice, title] of DND_CHOICES) {
    browser.contextMenus.create({ id: `dnd:${choice}`, parentId: 'dnd', title, ...ctx });
  }
  browser.contextMenus.create({ id: 'sep', type: 'separator', ...ctx });
  browser.contextMenus.create({ id: 'options', title: 'Options', ...ctx });
  await updateDndMenu();
}

async function updateDndMenu() {
  const p = await getPrefs();
  const on = dndActive(p);
  await browser.contextMenus.update('dnd', { title: on ? `Do Not Disturb (${dndLabel(p)})` : 'Do Not Disturb' });
}

function onMenuClick(id: string) {
  if (id === 'open') browser.tabs.create({ url: FASTMAIL_URL });
  else if (id === 'refresh') poll();
  else if (id === 'options') openOptions();
  else if (id.startsWith('dnd:')) updatePrefs({ dndUntil: dndUntilFor(id.slice(4) as DndChoice) });
}

async function doPoll() {
  const { vault, intervalMinutes, push: pushEnabled } = await getSettings();
  const prefs = await getPrefs();
  let token = await getUnlockedToken();
  // "Don't lock": unlock without asking, once per browser session.
  if (!token && vault?.wrap.method === 'none') {
    try {
      const unlocked = await openVault(vault);
      selfUnlocking = true;
      await setUnlocked(unlocked);
      token = unlocked.secrets.token;
      log('vault: unlocked (no lock)');
    } catch (e) {
      log('vault: auto-unlock failed:', (e as Error).message);
    }
  }
  if (!token) {
    stopPush();
    const error = lockedMessage(vault);
    await setConn('error', error);
    return setStatus({ error, locked: Boolean(vault), checkedAt: Date.now() });
  }
  try {
    let { session, inboxId, highWater } = await cached();
    if (session?.v !== SESSION_VERSION) session = await getSession(token);
    if (!inboxId) inboxId = await findInboxId(token, session);
    const vipEmails = prefs.view === 'vips' ? await vipAddresses(token, session) : [];
    // All mail is loaded by the popup itself; the poll keeps to the Inbox.
    const state = await fetchInbox(token, session, inboxId, { view: prefs.view === 'all' ? 'inbox' : prefs.view, vipEmails });

    // Notifications follow new unread inbox mail whatever the view. The first run only records the
    // baseline so existing mail doesn't spam notifications.
    const unread = state.newestUnread ?? [];
    const fresh = highWater ? unread.filter((m) => m.receivedAt > highWater!) : [];
    const newest = unread.reduce((max, m) => (m.receivedAt > max ? m.receivedAt : max), highWater ?? '');
    delete state.newestUnread; // not needed by the popup
    if (dndActive(prefs) && fresh.length) log('notify: suppressed by do not disturb,', fresh.length);
    // One sound per batch of new mail, on the first notification (or on its own with them off).
    if (!dndActive(prefs) && fresh.length && !prefs.mailNotify) await chime(prefs);
    for (const [i, m] of (dndActive(prefs) || !prefs.mailNotify ? [] : fresh.slice(0, 3)).entries()) {
      await notify(`mail-${m.id}`, `✉️ ${m.from}`, m.subject, i === 0);
    }
    await browser.storage.local.set({ session, inboxId, highWater: newest });
    await setStatus({ state, checkedAt: Date.now() });
    log('poll: ok, unread', state.unread);
    if (pushEnabled) startPush(token, session);
    else stopPush();
    await setConn(
      pushConnected ? 'push' : 'poll',
      pushConnected ? 'Live: push connected' : pollingDetail(intervalMinutes, pushEnabled),
    );
    await browser.alarms.create(ALARM, { periodInMinutes: Math.max(intervalMinutes, 0.5) });
  } catch (e) {
    log('poll: failed', (e as Error).message);
    await setConn('error', (e as Error).message);
    if (e instanceof AuthError) {
      stopPush();
      await browser.storage.local.remove(['session', 'inboxId']);
    }
    await setStatus({ error: (e as Error).message, checkedAt: Date.now() });
  }
}

function remindersSync() {
  return syncReminders(log).catch((e) => log('reminders: sync failed', (e as Error).message));
}

async function showReminder(alarmName: string) {
  const r = await takeReminder(alarmName);
  if (!r) return;
  if (dndActive(await getPrefs())) return log('reminders: suppressed by do not disturb');
  // An emoji says what kind of notification it is at a glance: ⏰ an event, 📅 an all-day one.
  await notify(`cal-${r.key}`, `${r.due.allDay ? '📅' : '⏰'} ${r.due.title}`, reminderText(r.due), true);
}

/** Fake-data builds for other browsers (pnpm fake:chrome): signed in to the fake server, no lock. */
async function fakeSetup() {
  const s = await getSettings();
  if (s.vault) return;
  const secrets = { token: 'fake-token', davPassword: 'fake-dav-password' };
  const { vault, dataKey } = await createVault(secrets, { method: 'none' });
  await setUnlocked({ secrets, dataKey });
  await saveSettings({ ...s, vault });
  log('fake setup: signed in to the fake server');
}

export default defineBackground(() => {
  log('background: started');
  browser.runtime.onInstalled.addListener(async () => {
    browser.storage.local.remove('seen'); // replaced by highWater
    createMenus();
    if (__FAKE_SETUP__) await fakeSetup();
    poll();
  });
  browser.runtime.onStartup.addListener(() => {
    createMenus();
    poll();
  });
  browser.contextMenus.onClicked.addListener((info) => onMenuClick(String(info.menuItemId)));
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === SYNC_ALARM) return void remindersSync();
    if (isReminderAlarm(a.name)) return void showReminder(a.name);
    if (a.name !== ALARM) return;
    log('alarm');
    poll();
  });
  browser.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c.settings) {
      const before = (c.settings.oldValue as any)?.vault?.tokenId;
      const after = (c.settings.newValue as any)?.vault?.tokenId;
      if (before !== after) {
        // New token: start from scratch. Other settings (interval, push) just need a poll.
        stopPush();
        browser.storage.local.remove(['session', 'inboxId', 'highWater', 'vipEmails']).then(poll);
      } else poll();
    } else if (area === 'local' && c.prefs) {
      const was = c.prefs.oldValue as any;
      const now = c.prefs.newValue as any;
      if (was?.view !== now?.view) poll();
      if (was?.dndUntil !== now?.dndUntil) updateDndMenu();
      if (was?.calReminders !== now?.calReminders || String(was?.calHidden) !== String(now?.calHidden)) remindersSync();
    } else if (area === 'session' && c.unlocked) {
      // Locking drops the reminder schedule; unlocking (or a new Calendar password) reads it again.
      if (!c.unlocked.newValue) clearReminders().then(() => browser.storage.session.remove(['calCache', 'filesCache']));
      else if ((c.unlocked.oldValue as any)?.secrets?.davPassword !== (c.unlocked.newValue as any)?.secrets?.davPassword || !c.unlocked.oldValue) remindersSync();
      if (selfUnlocking) return void (selfUnlocking = false);
      // Only a different token (or locking) needs a fresh start; re-saving the same one doesn't.
      if ((c.unlocked.oldValue as any)?.secrets?.token === (c.unlocked.newValue as any)?.secrets?.token) return;
      stopPush();
      poll();
    }
  });
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Settings → Notifications → Send a test notification (and the e2e harness): a notification plus the chosen sound.
    if ((msg as any)?.type === 'test-notify') {
      notify(`test-${Date.now()}`, 'Super Fastmail', 'This is how new mail will look and sound.', true).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: (e as Error).message }),
      );
      return true;
    }
    // The popup changed an event: its reminders may have moved.
    if (msg === 'reminders-sync') return void remindersSync();
    if (msg !== 'poll-now') return;
    // Reply once the poll has finished so the popup can show real progress (sendResponse +
    // `return true` works in both Firefox and Chrome, unlike returning a promise).
    poll().then(async () => {
      const status = ((await browser.storage.local.get('status')).status ?? {}) as Status;
      sendResponse({ ok: !status.error, locked: status.locked, error: status.error });
    });
    return true;
  });
  // Clicking a notification opens that message in the dropdown (the browser may not even be signed
  // in to Fastmail). The popup picks up `pendingOpen` when it loads.
  browser.notifications.onClicked.addListener(async (id) => {
    browser.notifications.clear(id);
    const emailId = id.startsWith('mail-') ? id.slice('mail-'.length) : undefined;
    if (emailId) await browser.storage.session.set({ pendingOpen: { id: emailId, at: Date.now() } });
    // A calendar reminder opens the Calendar.
    if (id.startsWith('cal-')) await updatePrefs({ app: 'calendar' });
    try {
      await browser.action.openPopup();
    } catch (e) {
      // No browser window to drop down from (or the browser refused): a standalone window instead.
      log('notify: dropdown unavailable,', (e as Error).message);
      await browser.storage.session.remove('pendingOpen');
      await browser.windows.create({
        url: browser.runtime.getURL(`/popup.html?popout=1${emailId ? `&open=${encodeURIComponent(emailId)}` : ''}` as any),
        type: 'popup',
        width: 720,
        height: 640,
      });
    }
  });
  browser.alarms.get(ALARM).then((a) => {
    if (!a) browser.alarms.create(ALARM, { periodInMinutes: 1 });
  });
  browser.alarms.get(SYNC_ALARM).then((a) => {
    if (!a) browser.alarms.create(SYNC_ALARM, { periodInMinutes: 15 });
  });
  // This runs on every wake of the background, so only when the last sync is stale.
  syncRemindersIfStale(log).catch((e) => log('reminders: sync failed', (e as Error).message));
});
