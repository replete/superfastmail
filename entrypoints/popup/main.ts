import '@/assets/theme.css';
import '@/assets/settings.css';
import '@fontsource/metropolis/400.css';
import '@fontsource/metropolis/500.css';
import '@fontsource/metropolis/600.css';
import '@fontsource/metropolis/700.css';
import { browser } from 'wxt/browser';
import { avatarFor } from '@/lib/avatar';
import { debugLog } from '@/lib/debuglog';
import { renderEmail } from '@/lib/email-view';
import {
  conversationFlags,
  destroyEmails,
  downloadBlob,
  fetchEmail,
  fetchInbox,
  mailboxList,
  type Mailbox,
  fetchThread,
  mailboxRoles,
  searchEmails,
  updateEmails,
  viewFilter,
  type Address,
  type FullEmail,
  type MailboxRole,
  type MailSummary,
  type ThreadMessage,
} from '@/lib/jmap';
import { DONE, MOVES, patchFor, undoPatch, type MailAction } from '@/lib/mail-actions';
import { closeComposer, composerEmpty, composerOpen, discardComposer, initComposer, openComposer, openDraft, restoreComposer, saveComposer } from './composer';
import { fmtSize } from './ui';
import type { ComposeMode } from '@/lib/compose';
import { html, insert, render as renderHtml, type Html } from '@/lib/html';
import { applyIcons, ICONS } from '@/lib/icons';
import { contactsKey, fixtureContacts, initContacts, loadContacts } from './contacts-view';
import { fixtureMasked, initMasked, loadMasked, maskedKey } from './masked-view';
import { matches } from '@/lib/keymap';
import { passkeyName } from '@/lib/passkey';
import { openPasskeyWindow } from '@/lib/passkey-window';
import { lockMethodOf, openVault } from '@/lib/vault';
import { aboutHtml, initSections, keysHtml, sectionsHtml } from '@/lib/settings-ui';
import { dndActive, dndLabel, dndUntilFor, getPrefs, updatePrefs, type DndChoice, type Prefs } from '@/lib/prefs';
import {
  getCachedSession,
  getConn,
  getSettings,
  getStatus,
  getUnlocked,
  getUnlockedToken,
  lockNow,
  setUnlocked,
} from '@/lib/storage';

const body = document.getElementById('body')!;

function when(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const $ = (id: string) => document.getElementById(id)!;
const popout = new URLSearchParams(location.search).has('popout');
if (popout) document.body.classList.add('popout');
// A fake-server build looks just like the real one: say so, so the two test windows can't be confused.
if (__FAKE__) insert($('account'), 'afterend', html`<span class="fakechip" title="Made-up mail from the test server">FAKE</span>`);
applyIcons();
for (const b of document.querySelectorAll<HTMLElement>('.pill.write')) {
  b.dataset.title = b.title;
  b.title = 'Needs an API token with write access';
}

/** Whether the token can change mail (archive, delete…) and send it, from the cached session. */
let canWrite = false;
let canSend = false;
function applyWriteAccess(on: boolean) {
  const changed = on !== canWrite;
  canWrite = on;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#listPane .pill.write, #readPane .pill.write')) {
    const soon = b.classList.contains('soon');
    b.disabled = soon || !on;
    const label = b.dataset.title || b.textContent!.trim();
    b.title = !on ? `${label} — needs an API token with write access` : soon ? `${label} — coming soon` : label;
  }
  if (changed) render();
}

const isDark = () =>
  prefs?.theme === 'dark' || (prefs?.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

let prefs: Prefs;

async function applyPrefs() {
  const view = prefs?.view;
  const box = prefs?.mailbox;
  prefs = await getPrefs();
  // Read messages stay in the Unread list until the tab changes (see markRead).
  if (view && (view !== prefs.view || box !== prefs.mailbox)) stickyRead.clear();
  if (box !== prefs.mailbox || (view !== prefs.view && (folderId() || view === 'all' || prefs.view === 'all'))) loadFolder();
  updateSearchLabel();
  document.body.classList.toggle('compact', prefs.density === 'compact');
  showAppView();
  const locked = document.body.classList.contains('locked');
  if (prefs.app === 'contacts' && !locked) loadContacts();
  if (prefs.app === 'masked' && !locked) loadMasked();
  if (prefs.app === 'calendar' && !locked) loadCalendar();
  if (prefs.app === 'files' && !locked) loadFiles();
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = prefs.theme;
  if (reading) renderConversation(); // plain-text mail follows the theme
  for (const group of document.querySelectorAll<HTMLElement>('[data-pref]')) {
    const value = prefs[group.dataset.pref as 'view' | 'density' | 'theme'];
    for (const b of group.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.v === value);
  }
  const dnd = dndActive(prefs);
  $('dndBtn').classList.toggle('on', dnd);
  $('dndBtn').title = dnd ? `Do Not Disturb ${dndLabel(prefs)}` : 'Do Not Disturb';
  $('dndState').textContent = dnd ? dndLabel(prefs) : '';
  $('dndOff').hidden = !dnd;
}

/** The Do Not Disturb menu. */
function toggleMenu(open = $('menu').hidden) {
  $('menu').hidden = !open;
  $('dndBtn').setAttribute('aria-expanded', String(open));
}

/** Ids of the messages currently listed, newest first (for prev/next in the reader). */
let listIds: string[] = [];
/** Checked rows for bulk actions (Fastmail's checkboxes), kept by id across re-renders. */
const checked = new Set<string>();

function updateBulk() {
  for (const id of [...checked]) if (!listIds.includes(id)) checked.delete(id);
  for (const li of body.querySelectorAll<HTMLElement>('li[data-id]')) {
    const on = checked.has(li.dataset.id!);
    li.classList.toggle('checked', on);
    li.querySelector<HTMLInputElement>('input.cb')!.checked = on;
  }
  const all = $('selAll') as HTMLInputElement;
  all.checked = listIds.length > 0 && checked.size === listIds.length;
  all.indeterminate = checked.size > 0 && checked.size < listIds.length;
  $('bulk').hidden = checked.size === 0;
  document.querySelector<HTMLElement>('.tabs')!.hidden = checked.size > 0;
  $('bulkCount').textContent = `${checked.size} selected`;
}

function toggleChecked(id: string) {
  if (checked.has(id)) checked.delete(id);
  else checked.add(id);
  updateBulk();
}

/** Keyboard selection in the list (Fastmail-style j/k), kept by id across re-renders. */
let selectedId: string | undefined;

function select(id: string | undefined) {
  selectedId = id;
  for (const li of body.querySelectorAll<HTMLElement>('li[data-id]')) {
    const on = li.dataset.id === id;
    li.classList.toggle('sel', on);
    if (on) li.scrollIntoView({ block: 'nearest' });
  }
}

function moveSelection(delta: number) {
  const i = selectedId ? listIds.indexOf(selectedId) : -1;
  const next = listIds[Math.min(Math.max(i + delta, 0), listIds.length - 1)];
  if (next) select(next);
}

const LEGEND = ['● Green: live updates (push)', '● Orange: polling only', '● Red: error'].join('\n');

async function renderDot() {
  const conn = await getConn();
  const dot = $('dot');
  dot.className = `dot ${conn?.mode ?? ''}`;
  const since = conn ? new Date(conn.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  dot.title = `${LEGEND}\n\nNow: ${conn ? `${conn.detail} (since ${since})` : 'starting…'}`;
}
/** One message of the open conversation; `email` is loaded when it's first expanded. */
interface MsgView {
  email?: FullEmail;
  remoteAllowed: boolean;
  /** Inline (cid:) images as data: URLs, once fetched. */
  inlineImages?: Map<string, string>;
}

/**
 * The open conversation: `listId` is the row it was opened from (list navigation and actions use
 * it). Messages expand in place, several at once; `focus` is the one keys act on (n / p, Shift+L).
 */
let reading:
  | {
      listId: string;
      subject: string;
      mailboxIds: Record<string, boolean>;
      thread: ThreadMessage[];
      open: Map<string, MsgView>;
      focus: string;
      showAll?: boolean;
      /** Dark theme: show HTML mail in its own colours (one switch for the whole conversation). */
      original?: boolean;
    }
  | undefined;

function fmtAddrs(list: Address[]) {
  return list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
}

/** "15 Oct (57 minutes ago)", like Fastmail. */
function fullDate(iso: string) {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  const rel =
    mins < 1 ? 'just now'
    : mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'} ago`
    : mins < 24 * 60 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'} ago`
    : mins < 7 * 24 * 60 ? `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? '' : 's'} ago`
    : '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return rel ? `${day} (${rel})` : `${day}, ${time}`;
}

/**
 * Email frames share the dropdown's origin so it can size them to their content and listen in them
 * (mouse back/forward, reader keys). Nothing from the email runs: the CSP in the srcdoc is
 * `default-src 'none'` (no scripts at all, inline handlers included, and no loads unless remote
 * images are allowed), and the sanitiser strips scripts, handlers and any link that isn't
 * web/mailto/tel (see email-view.ts). The sandbox has allow-scripts only so the dropdown's own
 * listeners fire (with scripting off in a frame, they never do). Links open in a new tab (popups
 * escape the sandbox, noopener).
 */
function mountFrame(host: HTMLElement, srcdoc: string) {
  const frame = document.createElement('iframe');
  frame.className = 'mframe';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = srcdoc;
  // Content sized to the frame (e.g. min-height: 100vh) grows each time the frame does; stop
  // following growth that comes faster than real content (images, fonts) ever arrives.
  // Once tripped, this frame stops following growth for good.
  let grows = 0;
  let windowStart = 0;
  let runaway = false;
  const fit = () => {
    const doc = frame.contentDocument;
    if (!doc?.documentElement) return;
    // The content's own height (html is height:auto), so frames shrink as well as grow.
    const h = Math.min(Math.ceil(doc.documentElement.getBoundingClientRect().height), 50_000);
    if (Math.abs(frame.offsetHeight - h) < 1) return;
    if (h > frame.offsetHeight) {
      if (runaway) return;
      const now = performance.now();
      if (now - windowStart > 1000) (windowStart = now), (grows = 0);
      if (++grows > 6) return void (runaway = true);
    }
    frame.style.height = `${h}px`;
  };
  frame.addEventListener('load', () => {
    fit();
    const doc = frame.contentDocument;
    if (doc?.body) new ResizeObserver(fit).observe(doc.body);
    if (doc) listenInFrame(doc);
    // Late layout (fonts, images): measure again a little later too.
    for (const ms of [150, 600, 2000]) setTimeout(fit, ms);
  });
  host.replaceChildren(frame);
}

/**
 * Events inside a message don't reach the dropdown, so pass on the ones it needs: mouse back/forward,
 * and keys (j / k, r, Esc…) when the message has focus. A key the reader uses is stopped there.
 */
function listenInFrame(doc: Document) {
  for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) doc.addEventListener(type, (e) => navButton(e, 'message'), true);
  doc.addEventListener('keydown', (e) => {
    const copy = new KeyboardEvent('keydown', {
      key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat, cancelable: true,
    });
    document.dispatchEvent(copy);
    if (copy.defaultPrevented) e.preventDefault();
  });
}

function senderName(from: Address[]) {
  return from[0]?.name || from[0]?.email || 'Unknown';
}

/** The conversation: open messages in full, the others as one-line rows; long runs of closed ones fold. */
function renderConversation() {
  if (!reading) return;
  const r = reading;
  $('rsubj').textContent = r.subject;
  renderHtml($('rlabels'), inboxId && r.mailboxIds[inboxId] ? html`<span class="mailbox-chip">Inbox</span>` : html``);
  const firstOpen = r.thread.findIndex((m) => r.open.has(m.id));
  const parts: Html[] = [];
  r.thread.forEach((m, i) => {
    // Fold closed messages before the first open one: show the first and last, count the rest.
    const fold = !r.showAll && firstOpen > 3;
    if (fold && i > 0 && i < firstOpen - 1) {
      if (i === 1) parts.push(html`<button class="tmore" data-more>${firstOpen - 2} more messages</button>`);
      return;
    }
    const open = r.open.get(m.id);
    const name = senderName(m.from);
    const av = avatarFor(name);
    parts.push(html`<article class="cmsg ${open ? 'open' : 'closed'}${m.unread ? ' unread' : ''}${m.id === r.focus ? ' focus' : ''}" data-msg="${m.id}">
      <button class="tmsg" data-toggle title="Show this message"><span class="avatar" style="background:${av.bg}">${av.initials}</span>
        <span class="tn">${name}</span><span class="tp">${m.preview}</span><span class="td">${when(m.receivedAt)}</span></button>
      <div class="mhead" data-toggle title="Collapse"><div class="avatar" style="background:${av.bg}">${av.initials}</div>
        <div><div class="mname"></div><div class="mto"></div></div><div class="mdate"></div></div>
      <div class="mbody"><div class="mframe-host"></div><div class="mfoot"></div></div>
    </article>`);
  });
  renderHtml($('msgs'), html`${parts}`);
  for (const [id, view] of r.open) if (view.email) showBody(id);
  updateOrigToggle();
  updateNav();
}

/** Fill in an open message's header, frame and buttons. */
function showBody(id: string) {
  const view = reading?.open.get(id);
  const el = $('msgs').querySelector<HTMLElement>(`.cmsg[data-msg="${CSS.escape(id)}"]`);
  if (!view?.email || !el) return;
  const email = view.email;
  const name = senderName(email.from);
  const av = avatarFor(name);
  renderHtml(
    el.querySelector('.mname')!,
    html`<span style="color:${isDark() ? av.name : av.bg}">${name}</span>${email.from[0]?.name ? html`<span class="addr">${email.from[0].email}</span>` : ''}`,
  );
  el.querySelector('.mto')!.textContent = `to ${fmtAddrs(email.to)}${email.cc.length ? `, cc ${fmtAddrs(email.cc)}` : ''}`;
  const date = el.querySelector<HTMLElement>('.mdate')!;
  date.textContent = fullDate(email.receivedAt);
  date.title = new Date(email.receivedAt).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
  // Inline images are part of the message (no remote load): swap cid: references for the fetched data.
  const shown = view.inlineImages?.size && email.html
    ? { ...email, html: email.html.replace(/cid:([^"'\s)>]+)/gi, (m, cid) => view.inlineImages!.get(cid.replace(/^<|>$/g, '')) ?? m) }
    : email;
  const { srcdoc, remote } = renderEmail(shown, view.remoteAllowed, isDark(), Boolean(reading!.original));
  if (email.inline?.length && email.html && !view.inlineImages) loadInlineImages(id, view);
  mountFrame(el.querySelector('.mframe-host')!, srcdoc);
  renderHtml(
    el.querySelector('.mfoot')!,
    html`${(email.attachments ?? []).map(
      (a, i) => html`<button class="att" data-att="${i}" title="Download ${a.name}">${ICONS.paperclip}<span class="aname">${a.name}</span><span class="asize">${fmtSize(a.size)}</span></button>`,
    )}${remote && !view.remoteAllowed ? html`<button class="pill" data-images title="Display blocked images (Shift+L)">${ICONS.image}Load images (${remote})</button>` : ''}`,
  );
  updateOrigToggle();
}

/** The one Original / Dark colours switch: shown in the dark theme when an open message is HTML. */
/** Expand all / Collapse all (all but the focused one), for conversations of two or more. */
function updateExpandAll() {
  const b = $('expandAll');
  const r = reading;
  b.hidden = !r || r.thread.length < 2;
  const allOpen = Boolean(r?.thread.every((m) => r.open.has(m.id)));
  renderHtml(b, ICONS[allOpen ? 'fold' : 'unfold']);
  b.title = allOpen ? 'Collapse all' : 'Expand all';
}
$('expandAll').onclick = () => {
  const r = reading;
  if (!r) return;
  const allOpen = r.thread.every((m) => r.open.has(m.id));
  if (allOpen) for (const m of r.thread) m.id !== r.focus && r.open.delete(m.id);
  else {
    r.showAll = true;
    for (const m of r.thread) if (!r.open.has(m.id)) r.open.set(m.id, { remoteAllowed: false });
  }
  renderConversation();
  for (const [id, v] of r.open) if (!v.email) loadMessage(id);
  updateExpandAll();
};

function updateOrigToggle() {
  updateExpandAll();
  const btn = $('origToggle');
  btn.hidden = !(isDark() && reading && [...reading.open.values()].some((v) => v.email?.html));
  btn.classList.toggle('on', Boolean(reading?.original));
  btn.title = reading?.original ? 'Show emails in dark colours' : 'Show emails in their original colours';
}
$('origToggle').onclick = () => {
  if (!reading) return;
  reading.original = !reading.original;
  for (const [id, v] of reading.open) if (v.email) showBody(id);
  updateOrigToggle();
};

const msgEl = (id: string) => $('msgs').querySelector<HTMLElement>(`.cmsg[data-msg="${CSS.escape(id)}"]`);

/**
 * Scroll the conversation column (only) to a message. Not scrollIntoView: while the reader slides
 * in it's still off to the side, and that would scroll the whole panel sideways too.
 */
function scrollToMessage(el: HTMLElement | null | undefined, mode: 'start' | 'nearest', smooth = false) {
  if (!el) return;
  const conv = $('conv');
  const box = conv.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  let delta = r.top - box.top;
  if (mode === 'nearest') {
    if (r.top >= box.top && r.bottom <= box.bottom) return; // already in view
    if (r.bottom > box.bottom && r.height < box.height) delta = r.bottom - box.bottom;
  }
  conv.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'instant' });
}

function setFocus(id: string) {
  if (!reading) return;
  reading.focus = id;
  for (const el of $('msgs').querySelectorAll<HTMLElement>('.cmsg')) el.classList.toggle('focus', el.dataset.msg === id);
}

/** Load an open message's full text (once) and show it. */
async function loadMessage(id: string) {
  const view = reading?.open.get(id);
  if (!reading || !view || view.email) return;
  const listId = reading.listId;
  try {
    const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
    if (!token || !session) return;
    view.email = await fetchEmail(token, session, id);
    if (reading?.listId === listId && reading.open.get(id) === view) showBody(id);
  } catch (e) {
    toast(`Couldn't load message: ${(e as Error).message}`, 'err');
  }
}

/** Expand a message in place (loading it the first time) or collapse it; the others stay as they are. */
function toggleMessage(id: string, { scroll = true } = {}) {
  if (!reading) return;
  const el = msgEl(id);
  if (!el) {
    // Folded away ("N more messages"): unfold, then open it.
    reading.showAll = true;
    reading.open.set(id, reading.open.get(id) ?? { remoteAllowed: false });
    renderConversation();
    setFocus(id);
    return void loadMessage(id);
  }
  setFocus(id);
  if (reading.open.has(id)) {
    reading.open.delete(id);
    el.classList.replace('open', 'closed');
    return updateExpandAll();
  }
  const view: MsgView = { remoteAllowed: false };
  reading.open.set(id, view);
  el.classList.replace('closed', 'open');
  updateExpandAll();
  if (scroll) scrollToMessage(el, 'nearest', true);
  loadMessage(id);
}

/** Fetch a message's inline images once, then show it again with them in place. */
async function loadInlineImages(id: string, view: MsgView) {
  view.inlineImages = new Map();
  const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
  if (!token || !session || !view.email?.inline) return;
  for (const a of view.email.inline) {
    if (a.size > 5_000_000) continue;
    try {
      const blob = await downloadBlob(token, session, a);
      const url = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
      if (url.startsWith('data:image/')) view.inlineImages.set(String(a.cid).replace(/^<|>$/g, ''), url);
    } catch {
      /* leave that image out */
    }
  }
  if (view.inlineImages.size && reading?.open.get(id) === view) showBody(id);
}

/** Fetch an attachment with the token and save it (the browser's usual download). */
async function downloadAttachment(id: string, i: number) {
  const a = reading?.open.get(id)?.email?.attachments?.[i];
  if (!a) return;
  const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
  if (!token || !session) return;
  try {
    const url = URL.createObjectURL(await downloadBlob(token, session, a));
    const link = Object.assign(document.createElement('a'), { href: url, download: a.name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    toast(`Couldn't download ${a.name}: ${(e as Error).message}`, 'err');
  }
}

/** n / p: the next or previous message in the conversation (expanding it). */
function stepMessage(delta: number) {
  if (!reading) return;
  const i = reading.thread.findIndex((m) => m.id === reading!.focus);
  const next = reading.thread[i + delta];
  if (!next) return;
  if (reading.open.has(next.id) && msgEl(next.id)) {
    setFocus(next.id);
    scrollToMessage(msgEl(next.id), 'nearest', true);
  } else toggleMessage(next.id);
}

/** Per message: show the email's own colours, or load its remote images. */
function messageOption(id: string, change: (v: MsgView) => void) {
  const view = reading?.open.get(id);
  if (!view) return;
  change(view);
  showBody(id);
}

$('msgs').addEventListener('click', (e) => {
  const t = e.target as Element;
  const id = t.closest<HTMLElement>('.cmsg')?.dataset.msg;
  if (t.closest('[data-more]') && reading) {
    reading.showAll = true;
    return renderConversation();
  }
  if (!id) return;
  if (t.closest('[data-images]')) return messageOption(id, (v) => (v.remoteAllowed = true));
  const att = t.closest<HTMLElement>('[data-att]')?.dataset.att;
  if (att !== undefined) return void downloadAttachment(id, Number(att));
  if (t.closest('[data-toggle]')) toggleMessage(id, { scroll: false });
});

function updateNav() {
  const i = reading ? listIds.indexOf(reading.listId) : -1;
  ($('prev') as HTMLButtonElement).disabled = i <= 0;
  ($('next') as HTMLButtonElement).disabled = i < 0 || i >= listIds.length - 1;
}

let inboxId: string | undefined;
browser.storage.local.get('inboxId').then((r) => (inboxId = r.inboxId as string | undefined));

// --- Folders ---------------------------------------------------------------------------------------
// The list shows the Inbox (from the background's poll, which also drives the badge and
// notifications) or another folder the popup loads itself.

let mailboxes: Mailbox[] | undefined;
/** The folder being shown, when it isn't the Inbox. */
let folder: { id: string; items: MailSummary[] } | undefined;
const folderId = () => (prefs?.mailbox && prefs.mailbox !== inboxId ? prefs.mailbox : undefined);
const currentBox = () => mailboxes?.find((m) => m.id === (folderId() ?? inboxId));
const folderRole = () => (folderId() ? currentBox()?.role ?? undefined : 'inbox');
/** The popup loads the list itself for All and for folders; the Inbox tabs come from the background's poll. */
const ownList = () => prefs?.view === 'all' || Boolean(folderId());
/** Trash and Spam: left out of All. */
const awayIds = () => [roles?.trash, roles?.junk].filter((r): r is string => Boolean(r));

async function loadMailboxes() {
  const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
  if (!token || !session) return;
  mailboxes = await mailboxList(token, session).catch(() => mailboxes);
  updateFolderTab();
}

let folderLoad = 0;
async function loadFolder() {
  const id = prefs?.view === 'all' ? 'all' : folderId();
  const n = ++folderLoad;
  if (!id) {
    folder = undefined;
    applyFolderUi();
    return render();
  }
  if (folder?.id !== id) {
    folder = { id, items: [] };
    renderHtml(body, html`<div class="msg">Loading…</div>`);
  }
  applyFolderUi();
  const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
  if (!token || !session) return;
  const { vipEmails } = (await browser.storage.local.get('vipEmails')) as { vipEmails?: { emails: string[] } };
  try {
    roles ??= await mailboxRoles(token, session).catch(() => ({}));
    const st =
      id === 'all'
        ? await fetchInbox(token, session, inboxId ?? roles.inbox ?? '', { view: 'all', away: awayIds() })
        : await fetchInbox(token, session, id, { view: prefs.view, vipEmails: vipEmails?.emails ?? [] });
    if (n !== folderLoad) return; // switched again meanwhile
    folder = { id, items: st.recent };
  } catch (e) {
    toast(`Couldn't load the folder: ${(e as Error).message}`, 'err');
  }
  render();
}

function updateFolderTab() {
  $('folderName').textContent = currentBox()?.name ?? 'Inbox';
  updateSearchLabel();
}

const TAB_NAMES: Record<string, string> = { unread: 'Unread', pinned: 'Pinned', vips: 'VIPs' };
/** What search looks through: the tab on show ("Inbox", "Unread in Work", "all mail"). */
function searchScopeName() {
  const box = currentBox()?.name ?? 'Inbox';
  if (!prefs || prefs.view === 'all') return 'all mail';
  if (prefs.view === 'inbox') return box;
  return folderId() ? `${TAB_NAMES[prefs.view]} in ${box}` : TAB_NAMES[prefs.view]!;
}
function updateSearchLabel() {
  const label = `Search ${searchScopeName()}`;
  ($('q') as HTMLInputElement).placeholder = label;
  $('q').closest('label')!.title = `${label} (/)`;
}
/** The JMAP filter for searching within the tab on show. */
async function searchScope(): Promise<Record<string, unknown> | undefined> {
  if (!prefs || prefs.view === 'all') return viewFilter('all', '', [], awayIds());
  const box = folderId() ?? inboxId;
  if (!box) return undefined;
  const { vipEmails } = (await browser.storage.local.get('vipEmails')) as { vipEmails?: { emails: string[] } };
  const vips = vipEmails?.emails ?? [];
  return viewFilter(prefs.view === 'vips' && !vips.length ? 'inbox' : prefs.view, box, vips);
}

/** Actions follow the folder: Trash restores or deletes for good, Spam has "Not spam", no Archive in Archive. */
function applyFolderUi() {
  updateFolderTab();
  const role = folderRole();
  for (const b of document.querySelectorAll<HTMLElement>('#readPane .bar [data-act], #bulk [data-act]')) {
    b.dataset.base ??= b.dataset.act;
    b.dataset.baseLabel ??= b.lastChild?.textContent ?? '';
    const base = b.dataset.base!;
    let act = base;
    let label = b.dataset.baseLabel!;
    let hide = false;
    if (base === 'archive') {
      if (role === 'trash') (act = 'restore'), (label = 'Restore');
      else if (role === 'junk') (act = 'notspam'), (label = 'Not spam');
      else hide = role === 'archive' || role === 'drafts' || (prefs?.view === 'all' && !searchResults);
    }
    if (base === 'delete' && (role === 'trash' || role === 'junk')) label = 'Delete forever';
    b.dataset.act = act;
    if (b.lastChild) b.lastChild.textContent = label;
    b.hidden = hide;
  }
}

function renderFolderMenu(filter = '') {
  const q = filter.trim().toLowerCase();
  const list = (mailboxes ?? []).filter((m) => !q || m.name.toLowerCase().includes(q));
  const current = folderId() ?? inboxId;
  renderHtml(
    $('folderList'),
    list.length
      ? html`${list.map(
          (m, i) => html`<button class="mi fitem${m.id === current ? ' on' : ''}${i === 0 && q ? ' first' : ''}" role="menuitem" data-box="${m.id}" style="padding-left:${12 + (q ? 0 : m.depth) * 14}px">
            <span class="label">${m.name}</span><span class="hint">${m.unreadEmails || ''}</span></button>`,
        )}`
      : html`<div class="mhint">No folder matches</div>`,
  );
}

async function toggleFolderMenu(open = $('folderMenu').hidden) {
  $('folderMenu').hidden = !open;
  $('folderBtn').setAttribute('aria-expanded', String(open));
  if (!open) return;
  const input = $('folderFilter') as HTMLInputElement;
  input.value = '';
  renderFolderMenu();
  input.focus();
  await loadMailboxes(); // fresh counts
  if (!$('folderMenu').hidden) renderFolderMenu(input.value);
}

function pickFolder(id: string) {
  toggleFolderMenu(false);
  clearSearch();
  updatePrefs({ mailbox: id === inboxId ? undefined : id, ...(prefs.view === 'vips' || prefs.view === 'all' ? { view: 'inbox' as const } : {}) });
}

// Move to: the folder list again (minus the one being viewed), from a button or m / v.
let moveIds: string[] = [];
function renderMoveMenu(filter = '') {
  const q = filter.trim().toLowerCase();
  const here = folderId() ?? inboxId;
  const list = (mailboxes ?? []).filter((m) => m.id !== here && m.role !== 'drafts' && (!q || m.name.toLowerCase().includes(q)));
  renderHtml(
    $('moveList'),
    list.length
      ? html`${list.map(
          (m, i) => html`<button class="mi${i === 0 && q ? ' first' : ''}" role="menuitem" data-target="${m.id}" style="padding-left:${12 + (q ? 0 : m.depth) * 14}px"><span class="label">${m.name}</span></button>`,
        )}`
      : html`<div class="mhint">No folder matches</div>`,
  );
}
async function openMoveMenu(anchor?: HTMLElement) {
  moveIds = targets();
  if (!moveIds.length || !canWrite) return;
  if (!mailboxes) await loadMailboxes();
  const menu = $('moveMenu');
  const r = anchor?.getBoundingClientRect();
  menu.style.left = `${Math.round(r ? r.left : 120)}px`;
  menu.style.top = `${Math.round(r ? r.bottom + 4 : 90)}px`;
  menu.hidden = false;
  ($('moveFilter') as HTMLInputElement).value = '';
  renderMoveMenu();
  $('moveFilter').focus();
}
function closeMoveMenu() {
  $('moveMenu').hidden = true;
}
function moveTo(target: string) {
  closeMoveMenu();
  mailAct('move', moveIds, { target });
}
for (const b of document.querySelectorAll<HTMLElement>('[data-move]')) {
  b.onclick = (e) => {
    e.stopPropagation();
    if ($('moveMenu').hidden) openMoveMenu(b);
    else closeMoveMenu();
  };
}
$('moveList').onclick = (e) => {
  const t = (e.target as Element).closest<HTMLElement>('[data-target]')?.dataset.target;
  if (t) moveTo(t);
};
$('moveFilter').addEventListener('input', () => renderMoveMenu(($('moveFilter') as HTMLInputElement).value));
$('moveFilter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMoveMenu();
  } else if (e.key === 'Enter') {
    const first = $('moveList').querySelector<HTMLElement>('[data-target]');
    if (first) moveTo(first.dataset.target!);
  }
});
document.addEventListener('click', (e) => {
  if (!(e.target as Element).closest('#moveMenu, [data-move]')) closeMoveMenu();
});

$('folderBtn').onclick = (e) => {
  e.stopPropagation();
  toggleFolderMenu();
};
$('folderList').onclick = (e) => {
  const id = (e.target as Element).closest<HTMLElement>('[data-box]')?.dataset.box;
  if (id) pickFolder(id);
};
$('folderFilter').addEventListener('input', () => renderFolderMenu(($('folderFilter') as HTMLInputElement).value));
$('folderFilter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    toggleFolderMenu(false);
  } else if (e.key === 'Enter') {
    const first = $('folderList').querySelector<HTMLElement>('[data-box]');
    if (first) pickFolder(first.dataset.box!);
  }
});
document.addEventListener('click', (e) => {
  if (!(e.target as Element).closest('#folderMenu, #folderBtn')) $('folderMenu').hidden = true;
});

// Back/forward (mouse buttons, swipe, keys) work on the dropdown's own history: opening a message
// adds one entry, so back leaves it and forward reopens it. Stepping to the next message replaces
// that entry, so there are never more than two.
async function openEmail(id: string, { fromHistory = false } = {}) {
  // Reopening the dropdown comes back to it (until it's closed, or the browser is).
  browser.storage.session.set({ reading: { id } });
  if (!fromHistory) {
    if (history.state?.email) history.replaceState({ email: id }, '');
    else history.pushState({ email: id }, '');
  }
  document.body.classList.add('reading');
  $('rsubj').textContent = 'Loading…';
  $('rlabels').replaceChildren();
  $('msgs').replaceChildren();
  try {
    const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
    if (!token || !session) throw new Error('Not connected yet');
    const email = await fetchEmail(token, session, id);
    let thread = await fetchThread(token, session, email.threadId).catch(() => [] as ThreadMessage[]);
    // Leave out messages in Trash or Spam, unless this one is there too (as Fastmail does).
    roles ??= await mailboxRoles(token, session).catch(() => ({}));
    const away = [roles.trash, roles.junk].filter((r): r is string => Boolean(r));
    const isAway = (boxes: Record<string, boolean>) => away.some((r) => boxes[r]);
    if (!isAway(email.mailboxIds)) thread = thread.filter((m) => m.id === id || !isAway(m.mailboxIds));
    if (!thread.some((m) => m.id === id)) thread = [...thread, { id, from: email.from, receivedAt: email.receivedAt, preview: '', unread: false, mailboxIds: email.mailboxIds }];
    // Open the chosen message and any unread ones, as Fastmail does.
    const open = new Map<string, MsgView>(
      thread.filter((m) => m.id === id || m.unread).map((m) => [m.id, { remoteAllowed: false, ...(m.id === id ? { email } : {}) }]),
    );
    reading = { listId: id, subject: email.subject, mailboxIds: email.mailboxIds, thread, open, focus: id };
    renderConversation();
    for (const [mid, v] of open) if (!v.email) loadMessage(mid);
    // Start at the first unread message (as Fastmail does), else the chosen one. Frames grow below
    // that point as they load, so it stays in view.
    const start = thread.find((m) => m.unread)?.id ?? id;
    scrollToMessage(msgEl(start), 'start');
    markRead(id);
  } catch (e) {
    browser.storage.session.remove('reading'); // (gone, say: don't come back to it)
    $('rsubj').textContent = `Couldn't load message: ${(e as Error).message}`;
  }
}

/** Leave the message (Back button, Esc, u): through history, so forward can reopen it. */
function closeEmail() {
  if (history.state?.email) history.back();
  else leaveEmail();
}

function leaveEmail() {
  browser.storage.session.remove('reading');
  if (composerOpen() && !document.body.classList.contains('composeNew')) closeComposer();
  document.body.classList.remove('reading');
  reading = undefined;
  $('msgs').replaceChildren();
}

addEventListener('popstate', (e) => {
  const id = (e.state as { email?: string } | null)?.email;
  if (!id || prefs?.app !== 'mail') return leaveEmail();
  select(id);
  openEmail(id, { fromHistory: true });
});
// Mouse back/forward buttons, in case the browser doesn't send them to the dropdown's history.
// (If it does as well, the second step is a no-op: there are only two entries.) Mouse utilities may
// send Cmd+[ / Cmd+] or Alt+←/→ instead; see navKey.
let lastNav = 0;
function navButton(e: MouseEvent, where: string) {
  if (e.button !== 3 && e.button !== 4) return;
  debugLog(`popup: ${e.type} button ${e.button} (${where})`);
  e.preventDefault();
  if (e.type !== 'mouseup' && e.type !== 'auxclick') return;
  // mouseup and auxclick both come for one press: act once.
  if (performance.now() - lastNav < 300) return;
  lastNav = performance.now();
  if (e.button === 3) history.back();
  else history.forward();
}
for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) addEventListener(type, (e) => navButton(e, 'page'), true);

/** Back / forward keys: Cmd+[ / Cmd+] (Mac), Alt+← / Alt+→. */
function navKey(e: KeyboardEvent): boolean {
  const back = (e.metaKey && e.key === '[') || (e.altKey && e.key === 'ArrowLeft');
  const fwd = (e.metaKey && e.key === ']') || (e.altKey && e.key === 'ArrowRight');
  if (!back && !fwd) return false;
  debugLog(`popup: ${back ? 'back' : 'forward'} key`);
  if (back) history.back();
  else history.forward();
  return true;
}
addEventListener('popstate', () => debugLog('popup: popstate', history.state?.email ? 'to a message' : 'to the list'));

function step(delta: number) {
  if (!reading) return;
  const id = listIds[listIds.indexOf(reading.listId) + delta];
  if (!id) return;
  select(id);
  openEmail(id);
}

function folderEmpty() {
  if (prefs?.view === 'all') return 'No mail';
  const name = currentBox()?.name ?? 'This folder';
  return { all: '', inbox: `${name} is empty`, unread: `No unread mail in ${name}`, pinned: `No pinned messages in ${name}`, vips: `No messages from VIPs in ${name}` }[
    prefs?.view ?? 'inbox'
  ]!;
}

const EMPTY: Record<string, string> = {
  inbox: 'Inbox is empty',
  unread: 'No unread mail 🎉',
  pinned: 'No pinned messages in your inbox',
  vips: 'No messages from VIPs in your inbox',
};

const NEEDS_WRITE = 'needs an API token with write access';
const act = (icon: keyof typeof ICONS, action: MailAction, label: string): Html =>
  canWrite
    ? html`<button data-act="${action}" title="${label}">${ICONS[icon]}</button>`
    : html`<button aria-disabled="true" title="${label} — ${NEEDS_WRITE}">${ICONS[icon]}</button>`;

/** The row's hover icons, for the folder being viewed. */
function hoverActions(m: MailSummary): Html[] {
  const role = searchResults ? 'inbox' : folderRole();
  const read = m.unread ? act('mailOpen', 'read', 'Mark read (Shift+I)') : act('mail', 'unread', 'Mark unread (Shift+U)');
  if (role === 'trash') return [act('inbox', 'restore', 'Restore to Inbox'), act('trash', 'delete', 'Delete forever')];
  if (role === 'junk') return [act('inbox', 'notspam', 'Not spam'), act('trash', 'delete', 'Delete forever')];
  if (role === 'drafts') return [act('trash', 'delete', 'Delete draft (d)')];
  // All mail still lists archived mail, so no Archive there.
  const noArchive = role === 'archive' || (!searchResults && prefs?.view === 'all');
  return [read, ...(noArchive ? [] : [act('archive', 'archive', 'Archive (y)')]), act('trash', 'delete', 'Delete (d)'), act('spam', 'spam', 'Report spam (!)')];
}

function row(m: MailSummary): Html {
  const pinTitle = canWrite ? (m.flagged ? 'Unpin (s)' : 'Pin (s)') : m.flagged ? 'Pinned' : `Pin — ${NEEDS_WRITE}`;
  return html`<li data-id="${m.id}"${m.unread ? '' : html` class="read"`}>
    <input type="checkbox" class="cb" aria-label="Select">
    <span class="pin${m.flagged ? ' on' : ''}" title="${pinTitle}"${canWrite ? html` data-act="${m.flagged ? 'unpin' : 'pin'}"` : html` aria-disabled="true"`}>${ICONS.pin}</span>
    <span class="udot"></span>
    <span class="from">${m.from}</span>
    <span class="main"><div class="subj">${m.subject}</div><div class="prev">${m.preview}</div></span>
    <span class="att" title="${m.hasAttachment ? 'Has attachments' : ''}">${m.hasAttachment ? ICONS.paperclip : ''}</span>
    <span class="time">${when(m.receivedAt)}</span>
    <span class="hover-actions">${hoverActions(m)}</span>
  </li>`;
}

// Search (Fastmail's "/"): results replace the list until cleared.
let searchResults: MailSummary[] | undefined;
/** Summaries as last listed, by id. */
const listed = new Map<string, MailSummary>();
/**
 * Messages read from the Unread tab. They stay listed (shown as read) until the tab changes, so
 * going back to the list doesn't make the message you just read vanish.
 */
const stickyRead = new Map<string, MailSummary>();

/** Opening a message marks it read, with a token that can change mail (quietly: no toast). */
async function markRead(id: string) {
  const known = listed.get(id);
  if ((known && !known.unread) || !canWrite) return;
  await mailAct('read', [id], { quiet: true });
}

// --- Mail actions --------------------------------------------------------------------------------

/** Messages moved away (archived, deleted…), hidden until the server's list agrees. */
const hidden = new Set<string>();
/** Local read/pinned state, shown until the server's list agrees. */
const overrides = new Map<string, Partial<MailSummary>>();
let roles: Partial<Record<MailboxRole, string>> | undefined;
let undoLast: (() => Promise<void>) | undefined;

const LOCAL: Partial<Record<MailAction, Partial<MailSummary>>> = {
  read: { unread: false },
  unread: { unread: true },
  pin: { flagged: true },
  unpin: { flagged: false },
};

function pollSoon() {
  browser.runtime.sendMessage('poll-now').catch(() => {}); // counts and badge
}

/**
 * Archive, delete, report spam, mark read/unread, pin/unpin: shown straight away, then sent; an
 * undo toast puts the messages back exactly as they were.
 */
async function mailAct(action: MailAction, ids: string[], { quiet = false, target }: { quiet?: boolean; target?: string } = {}) {
  if (!ids.length) return;
  if (!canWrite) return toast(`That ${NEEDS_WRITE}`, 'err');
  const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
  if (!token || !session) return;
  // Moved away: no longer kept listed as read in the Unread tab either (undo puts it back).
  const wasSticky = new Map(ids.flatMap((id) => (stickyRead.has(id) ? [[id, stickyRead.get(id)!] as const] : [])));
  const apply = () => {
    for (const id of ids) {
      if (MOVES.has(action)) {
        hidden.add(id);
        stickyRead.delete(id);
      } else overrides.set(id, { ...overrides.get(id), ...LOCAL[action] });
      // Read from the Unread tab: stays listed until the tab changes.
      const m = listed.get(id);
      if (action === 'read' && m && prefs?.view === 'unread' && !searchResults) stickyRead.set(id, { ...m, unread: false });
      checked.delete(id);
    }
    if (MOVES.has(action) && reading && ids.includes(reading.listId)) closeEmail();
    render();
  };
  const revert = () => {
    for (const id of ids) {
      hidden.delete(id);
      overrides.delete(id);
      if (action === 'read') stickyRead.delete(id);
      const kept = wasSticky.get(id);
      if (kept && MOVES.has(action)) stickyRead.set(id, kept);
    }
    render();
  };
  const role = searchResults ? undefined : folderRole();
  if (action === 'delete' && (role === 'trash' || role === 'junk')) return confirmDestroy(ids);
  apply();
  try {
    roles ??= await mailboxRoles(token, session);
    // Rows are conversations: act on the conversation's messages (moves: those in the folder being
    // viewed, as Fastmail does; read: all unread ones; unpin: all pinned ones), not just the newest.
    const before = await conversationFlags(token, session, ids);
    const from = searchResults ? roles.inbox : folderId() ?? roles.inbox;
    const applies = (id: string, f: (typeof before)[string]) =>
      ids.includes(id) ||
      (MOVES.has(action) ? Boolean(from && f.mailboxIds[from]) : action === 'read' ? !f.keywords.$seen : action === 'unpin' ? Boolean(f.keywords.$flagged) : false);
    const affected = Object.keys(before).filter((id) => applies(id, before[id]!));
    await updateEmails(token, session, Object.fromEntries(affected.map((id) => [id, patchFor(action, roles!, before[id]!, from, target)])));
    if (reading && action === 'read') for (const m of reading.thread) if (affected.includes(m.id)) m.unread = false;
    pollSoon();
    if (quiet) {
      // Marked read on opening: just drop the unread styling (no redraw, so frames don't flicker).
      if (reading) for (const el of $('msgs').querySelectorAll('.cmsg.unread')) el.classList.remove('unread');
      return;
    }
    undoLast = async () => {
      undoLast = undefined;
      await updateEmails(token, session, Object.fromEntries(affected.map((id) => [id, undoPatch(before[id]!)])));
      revert();
      pollSoon();
      toast('Undone');
    };
    const done = action === 'move' ? `Moved to ${mailboxes?.find((m) => m.id === target)?.name ?? 'folder'}` : DONE[action];
    toast(ids.length > 1 ? `${done} (${ids.length} conversations)` : done, '', undoLast);
  } catch (e) {
    revert();
    debugLog('mail action failed:', action, (e as Error).message);
    toast(`Couldn't do that: ${(e as Error).message}`, 'err');
  }
}

/** Trash and Spam: delete for good, after a confirmation (there's no undo). */
function confirmDestroy(ids: string[]) {
  const n = ids.length > 1 ? `${ids.length} conversations` : 'this conversation';
  toast(`Delete ${n} forever? This can't be undone.`, 'err', async () => {
    const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
    if (!token || !session) return;
    try {
      const flags = await conversationFlags(token, session, ids);
      const from = folderId();
      const all = Object.keys(flags).filter((id) => ids.includes(id) || (from && flags[id]!.mailboxIds[from]));
      for (const id of ids) hidden.add(id);
      if (reading && ids.includes(reading.listId)) closeEmail();
      render();
      await destroyEmails(token, session, all);
      toast(ids.length > 1 ? `Deleted ${ids.length} conversations` : 'Deleted');
      loadFolder();
      pollSoon();
    } catch (e) {
      for (const id of ids) hidden.delete(id);
      render();
      toast(`Couldn't delete: ${(e as Error).message}`, 'err');
    }
  }, 'Delete forever');
}

/** What an action applies to: the open message, else the checked ones, else the selected one. */
function targets(): string[] {
  if (reading) return [reading.listId];
  if (checked.size) return [...checked];
  return selectedId ? [selectedId] : [];
}

/** Pin or unpin, whichever the (first) target isn't. */
function togglePin(ids = targets()) {
  const m = ids[0] ? listed.get(ids[0]) : undefined;
  mailAct(m?.flagged ? 'unpin' : 'pin', ids);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, kind: '' | 'err' = '', undo?: () => Promise<void>, actionLabel = 'Undo') {
  $('toastMsg').textContent = msg;
  $('toast').className = `toast ${kind}`;
  $('toastUndo').hidden = !undo;
  $('toastUndo').textContent = actionLabel;
  $('toastUndo').onclick = () => {
    $('toast').hidden = true;
    undo?.().catch((e) => toast(`Couldn't undo: ${(e as Error).message}`, 'err'));
  };
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), undo ? 8000 : 4000);
}
$('toastClose').onclick = () => ($('toast').hidden = true);
let searchQuery = '';
let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** The last results, kept when a tab is picked: the search box brings them back (search is like a tab). */
let lastSearch: { q: string; results: MailSummary[]; scope: string } | undefined;
let searchScopeShown = '';

/** Fastmail matches whole words; a trailing * makes the last one a prefix, as you type ("hotuk" → hotukdeals). */
const asYouType = (q: string) => (/(^|\s)[^\s"*:()]{2,}$/.test(q) ? `${q}*` : q);

async function runSearch() {
  const q = ($('q') as HTMLInputElement).value.trim();
  if (!q) return clearSearch();
  renderHtml(body, html`<div class="msg">Searching…</div>`);
  try {
    const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
    if (!token || !session) throw new Error('Not connected yet');
    roles ??= await mailboxRoles(token, session).catch(() => ({}));
    const scope = searchScopeName();
    const results = await searchEmails(token, session, asYouType(q), await searchScope());
    if (($('q') as HTMLInputElement).value.trim() !== q) return; // superseded by newer typing
    searchResults = results;
    searchQuery = q;
    searchScopeShown = scope;
    lastSearch = { q, results, scope };
  } catch (e) {
    renderHtml(body, html`<div class="msg">Search failed: ${(e as Error).message}</div>`);
    return;
  }
  document.body.classList.add('searching');
  render();
}

function clearSearch() {
  clearTimeout(searchTimer);
  lastSearch = undefined;
  ($('q') as HTMLInputElement).value = '';
  $('qClear').hidden = true;
  leaveSearch();
}

/** Back to the tab's list; the query stays in the box and the results come back when it's clicked. */
function leaveSearch() {
  clearTimeout(searchTimer);
  if (!searchResults) return;
  searchResults = undefined;
  searchQuery = '';
  document.body.classList.remove('searching');
  render();
}

/** The search box, clicked or focused with the last query still in it: its results again. */
function backToSearch() {
  const s = lastSearch;
  if (!s || searchResults || ($('q') as HTMLInputElement).value.trim() !== s.q) return;
  searchResults = s.results;
  searchQuery = s.q;
  searchScopeShown = s.scope;
  document.body.classList.add('searching');
  render();
}

/**
 * Locked (or not set up yet): nothing but Mail can show anything, so pin the view to Mail (where the
 * unlock / welcome screen is) and disable the view changers and search until it's unlocked.
 */
function gate(on: boolean) {
  const was = document.body.classList.contains('locked');
  document.body.classList.toggle('locked', on);
  for (const id of ['railMail', 'railContacts', 'railMasked', 'railCalendar', 'railFiles'])
    ($(id) as HTMLButtonElement).disabled = on;
  ($('q') as HTMLInputElement).disabled = on;
  if (on && reading) leaveEmail();
  showAppView();
  // Just unlocked: load the app that was waiting behind the lock, or the message a notification asked for.
  if (was && !on && prefs?.app === 'contacts') loadContacts();
  if (was && !on && prefs?.app === 'masked') loadMasked();
  if (was && !on && prefs?.app === 'calendar') loadCalendar();
  if (was && !on && prefs?.app === 'files') loadFiles();
  if (was && !on) openRequested();
}

/** Message to open from a notification click: ?open= (standalone window) or a fresh `pendingOpen`. */
let openParam = new URLSearchParams(location.search).get('open') ?? undefined;
async function openRequested() {
  if (document.body.classList.contains('locked')) return; // after unlocking (see gate)
  const { pendingOpen } = (await browser.storage.session.get('pendingOpen')) as { pendingOpen?: { id: string; at: number } };
  const fresh = openParam ?? (pendingOpen && Date.now() - pendingOpen.at < 60_000 ? pendingOpen.id : undefined);
  openParam = undefined;
  if (pendingOpen) await browser.storage.session.remove('pendingOpen');
  // Else the message that was open when the dropdown last closed.
  const { reading: was } = (await browser.storage.session.get('reading')) as { reading?: { id: string } };
  const id = fresh ?? (prefs?.app === 'mail' ? was?.id : undefined);
  if (!id) return;
  if (prefs?.app !== 'mail') await updatePrefs({ app: 'mail' });
  select(id);
  openEmail(id);
}

/** The app on screen: the chosen one, or Mail while locked. Compose has its own rail button. */
function showAppView() {
  // Locked: Mail (where unlocking is), though Settings and Help still open.
  const chosen = prefs?.app ?? 'mail';
  const app = document.body.classList.contains('locked') && chosen !== 'settings' && chosen !== 'help' ? 'mail' : chosen;
  document.body.dataset.app = app;
  const composing = app === 'mail' && document.body.classList.contains('composeNew');
  $('railCompose').classList.toggle('on', composing);
  $('railCompose').classList.toggle('waiting', composeAside);
  $('railMail').classList.toggle('on', app === 'mail' && !composing);
  $('railContacts').classList.toggle('on', app === 'contacts');
  $('railCalendar').classList.toggle('on', app === 'calendar');
  $('railFiles').classList.toggle('on', app === 'files');
  $('railSettings').classList.toggle('on', app === 'settings');
  $('railHelp').classList.toggle('on', app === 'help');
  if (app === 'settings') showSettings();
  if (app === 'help') showHelp();
  $('railMasked').classList.toggle('on', app === 'masked');
}

async function render() {
  const { state, error, locked } = await getStatus();
  const { vault } = await getSettings();
  gate(Boolean((locked && vault) || (error && !vault)));
  if (locked && vault) {
    $('unreadCount').textContent = '';
    const w = vault.wrap;
    const how =
      w.method === 'passkey'
        ? html`<button id="pkUnlock" class="pill primary">${w.kind === 'security-key' ? ICONS.key : ICONS.fingerprint}Unlock with ${passkeyName(w.kind)}</button>`
        : w.method === 'passphrase'
          ? html`<form id="unlock"><input id="pp" type="password" placeholder="Password" autocomplete="current-password"><button class="pill">Unlock</button></form>`
          : html`<p>Couldn't unlock automatically. Paste your token again in settings.</p>`;
    renderHtml(
      body,
      html`<div class="lock">${ICONS.lock}<h3>Super Fastmail is locked</h3>
      <p>New mail isn't checked while it's locked.</p>${how}<div id="uerr" class="err"></div>
      <button id="startOver" class="linkish">Forgot it? Start over with your token</button></div>`,
    );
    const err = (m: string) => (document.getElementById('uerr')!.textContent = m);
    document.getElementById('startOver')!.onclick = openOptions;
    if (w.method === 'passkey') {
      const btn = document.getElementById('pkUnlock') as HTMLButtonElement;
      btn.focus();
      btn.onclick = () => openPasskeyWindow({ reopen: !popout });
    } else if (w.method === 'passphrase') {
      const pp = document.getElementById('pp') as HTMLInputElement;
      pp.focus();
      (document.getElementById('unlock') as HTMLFormElement).onsubmit = async (e) => {
        e.preventDefault();
        err('');
        try {
          await setUnlocked(await openVault(vault, pp.value));
        } catch {
          err('Wrong password');
        }
      };
    }
    return;
  }
  if (error && !vault) {
    // First run: say what to do, not just what's missing.
    $('unreadCount').textContent = '';
    renderHtml(
      body,
      html`<div class="lock">${ICONS.mail}<h3>Welcome to Super Fastmail</h3>
      <p>Connect your Fastmail account with an API token to see your mail here.</p>
      <button id="setup" class="pill primary">${ICONS.settings}Open settings</button></div>`,
    );
    document.getElementById('setup')!.onclick = openOptions;
    return;
  }
  if (error) {
    renderHtml(body, html`<div class="msg">${error}</div>`);
    $('unreadCount').textContent = '';
    return;
  }
  if (!state) {
    renderHtml(body, html`<div class="msg">Checking…</div>`);
    return;
  }
  $('unreadCount').textContent = state.unread ? `(${state.unread})` : '';
  // Drop local changes the server has caught up with; apply the rest.
  const source = searchResults ?? (folder ? folder.items : state.recent);
  const server = new Map(source.map((m) => [m.id, m]));
  for (const id of hidden) if (!server.has(id) && !searchResults) hidden.delete(id);
  for (const [id, o] of overrides) {
    const m = server.get(id);
    if (!m || Object.entries(o).every(([k, v]) => m[k as keyof MailSummary] === v)) overrides.delete(id);
  }
  let items = source.filter((m) => !hidden.has(m.id)).map((m) => ({ ...m, ...overrides.get(m.id) }));
  if (!searchResults && prefs?.view === 'unread' && stickyRead.size) {
    // Keep messages read from here in place (as read) until the tab changes.
    const ids = new Set(items.map((m) => m.id));
    items = [...items.map((m) => stickyRead.get(m.id) ?? m), ...[...stickyRead.values()].filter((m) => !ids.has(m.id) && !hidden.has(m.id))].sort(
      (a, b) => b.receivedAt.localeCompare(a.receivedAt),
    );
  }
  listed.clear();
  for (const m of items) listed.set(m.id, m);
  listIds = items.map((m) => m.id);
  updateNav();
  const header = searchResults
    ? html`<div class="results">${items.length === 25 ? 'Newest 25' : items.length} result${items.length === 1 ? '' : 's'} for “${searchQuery}” in ${searchScopeShown}</div>`
    : '';
  renderHtml(
    body,
    html`${header}${
      items.length
        ? html`<ul>${items.map(row)}</ul>`
        : html`<div class="msg">${searchResults ? 'Nothing found' : folder ? folderEmpty() : EMPTY[prefs?.view ?? 'unread']}</div>`
    }`,
  );
  if (selectedId && listIds.includes(selectedId)) select(selectedId);
  updateBulk();
}


// App switcher (logo): Mail is this view; the other Fastmail apps open in a tab.
function toggleApps(open = $('appsMenu').hidden) {
  $('appsMenu').hidden = !open;
  $('apps').setAttribute('aria-expanded', String(open));
}
$('apps').onclick = (e) => {
  e.stopPropagation();
  toggleMenu(false);
  toggleApps();
};
for (const b of document.querySelectorAll<HTMLElement>('.app[data-app]')) {
  b.onclick = () => {
    browser.tabs.create({ url: `https://app.fastmail.com/${b.dataset.app}/` });
    toggleApps(false);
  };
}
// Calendar loads on demand (CalDAV, iCalendar and the calendar grid are big; most opens are for mail).
let calendarModule: Promise<typeof import('./calendar-view')> | undefined;
function calendarView() {
  if (!calendarModule) calendarModule = import('./calendar-view').then((m) => (m.initCalendar(), m));
  return calendarModule;
}
let calendarLoaded: typeof import('./calendar-view') | undefined;
// Files loads on demand too.
let filesModule: Promise<typeof import('./files-view')> | undefined;
let filesLoaded: typeof import('./files-view') | undefined;
// The upload window opens at a folder: ?popout=1&files=<folder URL>.
let filesAt = new URLSearchParams(location.search).get('files') ?? undefined;
async function loadFiles(refresh = false) {
  filesModule ??= import('./files-view').then((m) => (m.initFiles(), m));
  filesLoaded = await filesModule;
  const at = filesAt;
  filesAt = undefined;
  await filesLoaded.showFiles({ refresh, at });
}
async function loadCalendar(refresh = false) {
  const m = await calendarView();
  calendarLoaded = m;
  await m.showCalendar({ refresh });
}

const showApp = (app: Prefs['app']) => {
  toggleApps(false);
  // Writing a new message: set it aside (Compose brings it back), or let it go if nothing's written.
  if (newComposeShown()) composerEmpty() ? closeComposer() : setComposeAside(true);
  else if (app === 'mail' && prefs?.app === 'mail') closeEmail();
  switchApp(app);
};

/** Show an app now (not waiting for the saved preference to come back round). */
function switchApp(app: Prefs['app']) {
  if (prefs) prefs.app = app;
  showAppView();
  updatePrefs({ app });
}

// A new message is its own view (the Compose rail button). Going to another view sets it aside,
// still open; Compose (or c) brings it back. Replies stay inline in their conversation.
let composeAside = false;
const newComposerOpen = () => composerOpen() && Boolean($('composeNew').querySelector('.composer'));
const newComposeShown = () => newComposerOpen() && !composeAside;
function setComposeAside(aside: boolean) {
  composeAside = aside;
  document.body.classList.toggle('composeNew', !aside);
  document.body.classList.toggle('composing', !aside);
  if (!aside) document.body.classList.add('reading');
  else if (!reading) document.body.classList.remove('reading');
  showAppView();
}
$('railMail').onclick = () => showApp('mail');
$('railContacts').onclick = () => showApp('contacts');
$('railMasked').onclick = () => showApp('masked');
$('railCalendar').onclick = () => showApp('calendar');
$('railFiles').onclick = () => showApp('files');
initContacts();
initMasked();
if (__FIXTURES__) Object.assign(window, { __fixtureContacts: fixtureContacts, __fixtureMasked: fixtureMasked });
$('railSettings').onclick = () => showApp('settings');
$('railHelp').onclick = () => showApp('help');

// --- Settings and Help views ---------------------------------------------------------------------
// The sections that save as they change (lib/settings-ui.ts), under a summary of the connection;
// changing that happens on the full settings page.
let settingsReady = false;
async function showSettings() {
  if (!settingsReady) {
    settingsReady = true;
    renderHtml($('setSections'), sectionsHtml());
    initSections({ toast: (text) => toast(text) });
    $('openConnection').onclick = openOptions;
    // Tabs: one section at a time (Vacation only where the token has it).
    $('setTabs').onclick = (e) => {
      const id = (e.target as Element).closest<HTMLElement>('[data-st]')?.dataset.st;
      if (id) settingsTab(id);
    };
    settingsTab('secConn');
  }
  const [s, unlocked, session, status] = await Promise.all([
    getSettings(),
    getUnlocked(),
    getCachedSession(),
    getConn(),
  ]);
  $('lockNow').hidden = !s.vault || lockMethodOf(s.vault) === 'none' || !unlocked;
  const LOCK: Record<string, string> = { none: "Doesn't lock", passphrase: 'Password', device: 'Passkey', 'security-key': 'Security key' };
  const row = (k: string, v: string | Html) => html`<dt>${k}</dt><dd>${v}</dd>`;
  renderHtml(
    $('connSummary'),
    !s.vault
      ? row('Account', 'Not set up yet')
      : html`${[
          row('Account', html`${session?.username ?? '—'}${session?.readOnly ? html`<span class="tag">Read only</span>` : ''}`),
          row('Status', unlocked ? (status?.mode === 'push' ? 'Connected, live' : 'Connected') : 'Locked'),
          row('Lock', LOCK[lockMethodOf(s.vault)] ?? '—'),
          row('Calendar & Files', unlocked ? (unlocked.secrets.davPassword ? 'Connected' : 'Not set up') : '—'),
        ]}`,
  );
}
function settingsTab(id: string) {
  for (const b of $('setTabs').querySelectorAll<HTMLElement>('[data-st]')) b.classList.toggle('on', b.dataset.st === id);
  for (const sec of $('settingsView').querySelectorAll<HTMLElement>(':scope > section, #setSections > section')) sec.classList.toggle('on', sec.id === id);
}
let helpReady = false;
function showHelp() {
  if (helpReady) return;
  helpReady = true;
  renderHtml($('helpKeys'), keysHtml());
  renderHtml($('about'), aboutHtml());
  $('helpTabs').onclick = (e) => {
    const id = (e.target as Element).closest<HTMLElement>('[data-st]')?.dataset.st;
    if (id) helpTab(id);
  };
  helpTab('helpAbout');
}
function helpTab(id: string) {
  for (const b of $('helpTabs').querySelectorAll<HTMLElement>('[data-st]')) b.classList.toggle('on', b.dataset.st === id);
  for (const sec of $('helpView').querySelectorAll<HTMLElement>(':scope > section')) sec.classList.toggle('on', sec.id === id);
}

async function renderAccount() {
  const session = await getCachedSession();
  $('account').textContent = session?.username ?? '';
  $('account').title = session?.username ?? '';
  applyWriteAccess(Boolean(session?.canWriteMail));
  canSend = Boolean(session?.canSend);
  // Writing mail only shows where the token can send.
  $('railCompose').hidden = !canSend;
  $('convfoot').hidden = !canSend;
  const compose = $('compose');
  compose.setAttribute('aria-disabled', String(!session?.canSend));
  compose.title = session?.canSend ? 'Compose (c)' : `Compose — ${NEEDS_WRITE}`;
}

function compose() {
  if ($('compose').getAttribute('aria-disabled') === 'true') return;
  if (prefs?.app !== 'mail') switchApp('mail');
  if (newComposerOpen()) return setComposeAside(false);
  openComposer('new');
}
$('compose').onclick = compose;
$('railCompose').onclick = compose;

/** Reply / reply all / forward: to the focused open message, else the conversation's newest. */
async function replyTo(mode: ComposeMode) {
  if (!reading || !canSend) return;
  const r = reading;
  const target = r.open.get(r.focus)?.email ? r.focus : r.thread.at(-1)?.id ?? r.focus;
  let original = r.open.get(target)?.email;
  if (!original) {
    const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
    if (!token || !session) return;
    original = await fetchEmail(token, session, target).catch(() => undefined);
  }
  if (original) openComposer(mode, original, $('replyHost'));
}
for (const b of document.querySelectorAll<HTMLElement>('[data-compose]')) b.onclick = () => replyTo(b.dataset.compose as ComposeMode);

initComposer({
  toast: (msg, kind, undo) => toast(msg, kind, undo),
  showNewPane() {
    composeAside = false;
    document.body.classList.add('reading', 'composeNew');
    showAppView();
    return $('composeNew');
  },
  closed() {
    composeAside = false;
    document.body.classList.remove('composeNew');
    // A new message opened from the list: back to the list.
    if (!reading) document.body.classList.remove('reading');
    showAppView();
  },
});

// Toolbar buttons with an action: the reader's (the open message) and the bulk bar's (checked ones).
for (const b of document.querySelectorAll<HTMLElement>('#readPane .bar [data-act], #rmoreMenu [data-act], #bulk [data-act]')) {
  b.addEventListener('click', () => {
    $('rmoreMenu').hidden = true;
    const action = b.dataset.act as MailAction;
    if (action === 'pin') return togglePin();
    mailAct(action, targets());
  });
}
$('rmore').onclick = (e) => {
  e.stopPropagation();
  const open = $('rmoreMenu').hidden;
  if (open && reading) $('rpin').querySelector('.label')!.textContent = listed.get(reading.listId)?.flagged ? 'Unpin' : 'Pin';
  $('rmoreMenu').hidden = !open;
  $('rmore').setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (e) => {
  if (!(e.target as Element).closest('.rmore-wrap')) $('rmoreMenu').hidden = true;
});
/** Ask the background to poll; the icon spins until the poll has really finished. */
async function refresh() {
  const btn = $('refresh');
  if (btn.classList.contains('spinning')) return;
  btn.classList.remove('failed');
  btn.classList.add('spinning');
  const started = Date.now();
  let res: { ok?: boolean; locked?: boolean; error?: string } | undefined;
  try {
    res =
      prefs?.app === 'contacts'
        ? await loadContacts(true).then(() => ({ ok: true }))
        : prefs?.app === 'masked'
          ? await loadMasked(true).then(() => ({ ok: true }))
          : prefs?.app === 'calendar'
            ? await loadCalendar(true).then(() => ({ ok: true }))
            : prefs?.app === 'files'
              ? await loadFiles(true).then(() => ({ ok: true }))
            : await browser.runtime.sendMessage('poll-now');
  } catch (e) {
    res = { ok: false, error: (e as Error).message };
  }
  // Show at least one full turn, then stop at the end of the current one rather than snapping.
  await new Promise((r) => setTimeout(r, Math.max(0, 700 - (Date.now() - started))));
  btn.querySelector('svg')!.addEventListener(
    'animationiteration',
    () => {
      btn.classList.remove('spinning');
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      if (res?.ok || res?.locked) btn.title = `Refresh (u) · updated ${time}`;
      else {
        btn.classList.add('failed');
        btn.title = `Refresh failed: ${res?.error ?? 'no response'} (${time})`;
      }
    },
    { once: true },
  );
}
$('refresh').onclick = refresh;
$('dndBtn').onclick = (e) => {
  e.stopPropagation();
  toggleApps(false);
  toggleMenu();
};
document.addEventListener('click', (e) => {
  if (!$('menu').hidden && !$('menu').contains(e.target as Node)) toggleMenu(false);
  if (!$('appsMenu').hidden && !$('appsMenu').contains(e.target as Node)) toggleApps(false);
});
async function openOptions() {
  try {
    await browser.runtime.openOptionsPage();
  } catch {
    await browser.tabs.create({ url: browser.runtime.getURL('/options.html' as any) });
  }
  window.close();
}
for (const group of document.querySelectorAll<HTMLElement>('[data-pref]')) {
  group.onclick = (e) => {
    const v = (e.target as HTMLElement).closest<HTMLElement>('[data-v]')?.dataset.v;
    if (!v) return;
    updatePrefs({ [group.dataset.pref!]: v });
  };
}
for (const b of document.querySelectorAll<HTMLElement>('[data-dnd]')) {
  b.onclick = () => {
    updatePrefs({ dndUntil: dndUntilFor(b.dataset.dnd as DndChoice) });
    toggleMenu(false);
  };
}
async function lockAndShowMail() {
  // Back to Mail: that's where the unlock prompt is.
  switchApp('mail');
  await lockNow();
}
$('lockNow').onclick = lockAndShowMail;
$('lockBtn').onclick = lockAndShowMail;
/** The lock button shows only when there's a lock to put back (a lock is set, and it's unlocked now). */
async function updateLockBtn() {
  const [{ vault }, token] = await Promise.all([getSettings(), getUnlockedToken()]);
  $('lockBtn').hidden = !vault || lockMethodOf(vault) === 'none' || !token;
}
updateLockBtn();
browser.storage.onChanged.addListener((c, area) => {
  if ((area === 'local' && c.settings) || (area === 'session' && c.unlocked)) updateLockBtn();
});
$('popout').hidden = popout;
$('popout').onclick = async () => {
  await browser.windows.create({
    url: browser.runtime.getURL('/popup.html?popout=1' as any),
    type: 'popup',
    width: 720,
    height: 640,
  });
  window.close();
};
body.addEventListener('click', (e) => {
  const li = (e.target as Element).closest('li[data-id]');
  if (!li) return;
  const actBtn = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (actBtn) return void mailAct(actBtn.dataset.act as MailAction, [(li as HTMLElement).dataset.id!]);
  if ((e.target as Element).closest('.hover-actions, .pin')) return; // read-only token: nothing to do
  if ((e.target as Element).matches('input.cb')) {
    toggleChecked((li as HTMLElement).dataset.id!);
    return;
  }
  select((li as HTMLElement).dataset.id!);
  if (folderRole() === 'drafts' && !searchResults) return void openDraftById(selectedId!);
  openEmail(selectedId!);
});

async function openDraftById(id: string) {
  const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
  if (!token || !session) return;
  try {
    openDraft(await fetchEmail(token, session, id));
  } catch (e) {
    toast(`Couldn't open the draft: ${(e as Error).message}`, 'err');
  }
}
const q = $('q') as HTMLInputElement;
q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  $('qClear').hidden = !q.value;
  if (!q.value.trim()) clearSearch();
  else searchTimer = setTimeout(runSearch, 350);
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(searchTimer);
    runSearch();
  } else if (e.key === 'Escape') {
    e.preventDefault(); // keep the popup open
    e.stopPropagation();
    clearSearch();
    q.blur();
  }
});
$('qClear').onclick = () => clearSearch();
q.addEventListener('focus', backToSearch);
q.addEventListener('click', backToSearch);
// Picking a tab leaves search (its results stay for the search box). The Inbox (folder) tab, clicked while it's already showing, opens the
// folder menu instead (the chevron does too).
document.querySelector<HTMLElement>('.tabs')!.addEventListener(
  'click',
  (e) => {
    const searching = Boolean(searchResults);
    leaveSearch();
    const folderTab = (e.target as Element).closest('[data-v="inbox"]');
    if (folderTab && !searching && prefs?.view === 'inbox') {
      e.stopPropagation();
      toggleFolderMenu();
    }
  },
  true,
);

$('selAll').onclick = () => {
  const selectAll = checked.size < listIds.length;
  checked.clear();
  if (selectAll) listIds.forEach((id) => checked.add(id));
  updateBulk();
};
$('back').onclick = () => (document.body.classList.contains('composeNew') ? closeComposer() : closeEmail());
$('saveDraft').onclick = () => saveComposer();
$('discardDraft').onclick = () => discardComposer();
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
$('openweb').onclick = () => browser.tabs.create({ url: 'https://app.fastmail.com/mail/' });
document.addEventListener('keydown', (e) => {
  // Typing (inputs, textareas, the compose editor) never triggers shortcuts, and while a message is
  // being written the reader's keys stay off too (Esc and Ctrl/Cmd keys are the compose's own).
  const t = e.target as HTMLElement;
  const typing =
    (t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'radio') || t instanceof HTMLTextAreaElement || t.isContentEditable;
  if (typing || (t instanceof HTMLButtonElement && e.key === 'Enter')) return;
  if (prefs?.app === 'mail' && navKey(e)) return e.preventDefault();
  if (document.body.classList.contains('composing')) return;
  if (!$('rmoreMenu').hidden && e.key === 'Escape') {
    e.preventDefault();
    $('rmoreMenu').hidden = true;
    return;
  }
  if (!$('menu').hidden || !$('appsMenu').hidden) {
    if (e.key === 'Escape') {
      e.preventDefault();
      toggleMenu(false);
      toggleApps(false);
    }
    return;
  }
  const handled =
    prefs?.app === 'contacts'
      ? contactsKey(e)
      : prefs?.app === 'masked'
        ? maskedKey(e)
        : prefs?.app === 'calendar'
          ? Boolean(calendarLoaded?.calendarKey(e))
          : prefs?.app === 'files'
            ? Boolean(filesLoaded?.filesKey(e))
            : prefs?.app === 'settings' || prefs?.app === 'help'
              ? false
          : reading
            ? readerKey(e)
            : listKey(e);
  if (handled) e.preventDefault(); // e.g. stop Esc from closing the popup
});

/** Conversation actions, in the list or the reader. */
function actionKey(e: KeyboardEvent) {
  if (matches(e, 'archive')) mailAct('archive', targets());
  else if (matches(e, 'delete')) mailAct('delete', targets());
  else if (matches(e, 'spam')) mailAct('spam', targets());
  else if (matches(e, 'markRead')) mailAct('read', targets());
  else if (matches(e, 'markUnread')) mailAct('unread', targets());
  else if (matches(e, 'pin')) togglePin();
  else if (matches(e, 'move')) openMoveMenu();
  else if (matches(e, 'undo') && undoLast) undoLast();
  else return false;
  return true;
}

/** Reading: archive this one, then open the next (older) or previous message. */
function archiveAndStep(delta: number) {
  if (!reading) return;
  const id = reading.listId;
  const next = listIds[listIds.indexOf(id) + delta];
  mailAct('archive', [id]);
  if (next) {
    select(next);
    openEmail(next);
  }
}

function readerKey(e: KeyboardEvent) {
  if (actionKey(e)) return true;
  if (matches(e, 'archiveNext')) archiveAndStep(1);
  else if (matches(e, 'archivePrev')) archiveAndStep(-1);
  else if (matches(e, 'reply')) replyTo('reply');
  else if (matches(e, 'replyAll')) replyTo('replyAll');
  else if (matches(e, 'forward')) replyTo('forward');
  else if (matches(e, 'nextMessage')) stepMessage(1);
  else if (matches(e, 'prevMessage')) stepMessage(-1);
  else if (matches(e, 'back')) closeEmail();
  else if (matches(e, 'next')) step(1);
  else if (matches(e, 'prev')) step(-1);
  else if (matches(e, 'loadImages') && reading) messageOption(reading.focus, (v) => (v.remoteAllowed = true));
  else return false;
  return true;
}

function listKey(e: KeyboardEvent) {
  if (actionKey(e)) return true;
  if (matches(e, 'next')) moveSelection(1);
  else if (matches(e, 'prev')) moveSelection(-1);
  else if (matches(e, 'open') && selectedId) folderRole() === 'drafts' && !searchResults ? openDraftById(selectedId) : openEmail(selectedId);
  else if (matches(e, 'folders')) toggleFolderMenu(true);
  else if (matches(e, 'refresh')) refresh();
  else if (matches(e, 'select') && selectedId) toggleChecked(selectedId);
  else if (matches(e, 'search')) $('q').focus();
  else if (matches(e, 'compose')) compose();
  else return false;
  return true;
}

// Only the inbox status affects this view (other keys, e.g. debugLog, change constantly).
browser.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && changes.status) || (area === 'session' && changes.unlocked)) {
    render();
    if (area === 'local' && changes.status && ownList()) loadFolder(); // the server changed: refresh this list too
  }
  if (area === 'session' && changes.unlocked?.newValue) $('refresh').classList.remove('failed');
  if (area === 'local' && changes.conn) renderDot();
  if (area === 'local' && changes.session) renderAccount();
  if (area === 'local' && changes.prefs) applyPrefs().then(render);
});
// The upload window shows Files.
(filesAt ? updatePrefs({ app: 'files' }) : Promise.resolve())
  .then(applyPrefs)
  .then(() => loadMailboxes())
  .then(() => (ownList() ? loadFolder() : applyFolderUi()))
  .then(render)
  .then(openRequested)
  .then(() => restoreComposer())
  // A message restored while another app is showing waits behind Compose.
  .then(() => prefs?.app !== 'mail' && newComposerOpen() && setComposeAside(true));
renderDot();
renderAccount();
refresh();
