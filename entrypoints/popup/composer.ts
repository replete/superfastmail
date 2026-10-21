// The compose view: a new message (its own pane) or a reply/forward (inline under the conversation).
//
// Drafts are the core of it, because the dropdown closes on any outside click: every edit is
// snapshotted locally at once (and restored when the dropdown reopens), and saved to the Drafts
// folder after a pause, one save at a time. Sending uses the final content in one request that also
// removes the last saved draft (see lib/compose.ts for undo and Bcc).
import { browser } from 'wxt/browser';
import {
  AlreadySent,
  cancelSend,
  discardDraft,
  getIdentities,
  parseAddresses,
  saveDraft,
  SendError,
  scheduleChoices,
  sendMessage,
  signatureInner,
  startDraft,
  whenLabel,
  type ComposeMode,
  type Draft,
  type Identity,
  type Sent,
} from '@/lib/compose';
import { listContacts, type Contact } from '@/lib/contacts';
import { escapeHtml, sanitizeForEditor } from '@/lib/email-view';
import { html, insert, raw, render as renderHtml, type Html } from '@/lib/html';
import { ICONS } from '@/lib/icons';
import { mailboxRoles, uploadBlob, type Address, type FullEmail, type MailboxRole, type Session } from '@/lib/jmap';
import { getCachedSession, getUnlockedToken } from '@/lib/storage';
import { fmtSize } from './ui';

/** Seconds Fastmail holds a sent message, so Undo can stop it. */
const UNDO_SECONDS = 10;
const SNAPSHOT = 'compose';
const FIELDS = ['to', 'cc', 'bcc'] as const;
type Field = (typeof FIELDS)[number];

interface Snapshot {
  mode: ComposeMode;
  draft: Draft;
  draftId?: string;
  /** What it started as (recipients, subject, body): unchanged means nothing written. */
  initial: string;
  /** Popping out: reopen it even if nothing's been written yet. */
  popout?: boolean;
  at: number;
}

export interface ComposerHooks {
  toast(msg: string, kind?: '' | 'err', undo?: () => Promise<void>): void;
  /** Where a new message (or a restored draft) is shown; called before it's mounted. */
  showNewPane(): HTMLElement;
  /** The composer closed (sent, discarded or put away). */
  closed(): void;
}

let hooks: ComposerHooks;
let el: HTMLElement | undefined;
/** `existing`: a draft opened from Drafts (putting it away untouched leaves it as it was). */
let state: { mode: ComposeMode; draft: Draft; draftId?: string; initial: string; dirty: boolean; existing?: boolean } | undefined;
let identities: Identity[] = [];
let roles: Partial<Record<MailboxRole, string>> | undefined;
let contacts: Contact[] | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let snapTimer: ReturnType<typeof setTimeout> | undefined;
/** Server saves run one at a time. */
let saving: Promise<void> = Promise.resolve();
let sending = false;

export const composerOpen = () => Boolean(state);

async function conn(): Promise<{ token: string; session: Session }> {
  const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
  if (!token || !session) throw new Error('Not connected');
  return { token, session };
}

const $c = <T extends HTMLElement = HTMLElement>(sel: string) => el!.querySelector<T>(sel)!;

function status(msg: string, kind: '' | 'err' = '') {
  if (!el) return;
  const s = $c('.cstatus');
  s.textContent = msg;
  s.className = `cstatus ${kind}`;
}

// --- Reading the form ----------------------------------------------------------------------------

function chips(field: Field): (Address & { invalid?: boolean })[] {
  return [...el!.querySelectorAll<HTMLElement>(`.chips[data-field="${field}"] .chip`)].map((c) => JSON.parse(c.dataset.addr!));
}

/** The form as a draft. Only sending turns half-typed addresses into chips (people often don't press Enter). */
function readDraft({ commitTyped = false } = {}): Draft {
  if (commitTyped) for (const f of FIELDS) commitInput(f, { keepFocus: true });
  return {
    ...state!.draft,
    identityId: $c<HTMLSelectElement>('.cfrom').value || state!.draft.identityId,
    to: chips('to'),
    cc: chips('cc'),
    bcc: chips('bcc'),
    subject: $c<HTMLInputElement>('.csubject').value,
    html: $c('.cbody').innerHTML,
  };
}

// --- Saving --------------------------------------------------------------------------------------

/** Every edit: a local snapshot right away (survives the dropdown closing), a server save later. */
function edited() {
  if (!state) return;
  state.dirty = true;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(snapshot, 250);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToServer(), 4000);
}

/** The parts someone writes; a draft equal to how it opened has nothing worth keeping. */
const written = (d: Draft) => JSON.stringify([d.to, d.cc, d.bcc, d.subject, d.html, (d.attachments ?? []).map((a) => a.blobId)]);
const isEmpty = (d: Draft, initial: string) => written(d) === initial;

function snapshot({ popout = false } = {}) {
  if (!state || !el) return;
  state.draft = readDraft();
  const snap: Snapshot = { mode: state.mode, draft: state.draft, draftId: state.draftId, initial: state.initial, popout, at: Date.now() };
  browser.storage.local.set({ [SNAPSHOT]: snap }).catch(() => {});
}

function saveToServer(): Promise<void> {
  clearTimeout(saveTimer);
  if (!state?.dirty) return saving;
  state.draft = readDraft();
  const draft = state.draft;
  if (isEmpty(draft, state.initial)) return saving; // nothing to keep
  state.dirty = false;
  saving = saving.then(async () => {
    if (!state) return;
    const identity = identities.find((i) => i.id === draft.identityId);
    if (!identity) return;
    try {
      const { token, session } = await conn();
      roles ??= await mailboxRoles(token, session);
      state.draftId = await saveDraft(token, session, draft, identity, roles, state.draftId);
      snapshot();
      status(`Draft saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    } catch (e) {
      state.dirty = true; // try again next time
      status(`Couldn't save the draft: ${(e as Error).message}`, 'err');
    }
  });
  return saving;
}

const clearSnapshot = () => browser.storage.local.remove(SNAPSHOT).catch(() => {});

// --- Recipients ----------------------------------------------------------------------------------

function chipHtml(a: Address & { invalid?: boolean }): Html {
  const label = a.name ? `${a.name} <${a.email}>` : a.email;
  return html`<span class="chip${a.invalid ? ' invalid' : ''}" data-addr='${JSON.stringify(a)}' title="${label}">${a.name || a.email}<button class="x" title="Remove" tabindex="-1">${ICONS.x}</button></span>`;
}

function setChips(field: Field, list: Address[]) {
  const box = $c(`.chips[data-field="${field}"]`);
  box.querySelectorAll('.chip').forEach((c) => c.remove());
  insert(box.querySelector('input')!, 'beforebegin', html`${list.map(chipHtml)}`);
  if (list.length && field !== 'to') $c(`.cfield[data-row="${field}"]`).hidden = false;
}

function commitInput(field: Field, { keepFocus = false } = {}) {
  const input = el!.querySelector<HTMLInputElement>(`.chips[data-field="${field}"] input`);
  if (!input?.value.trim()) return;
  const parsed = parseAddresses(input.value);
  input.value = '';
  insert(input, 'beforebegin', html`${parsed.map(chipHtml)}`);
  hideSuggest();
  if (!keepFocus) edited();
}

let suggestFor: { field: Field; items: Address[]; index: number } | undefined;

function hideSuggest() {
  suggestFor = undefined;
  if (el) $c('.suggest').hidden = true;
}

async function suggest(field: Field, query: string) {
  const q = query.trim().toLowerCase();
  if (q.length < 1) return hideSuggest();
  if (!contacts) {
    contacts = [];
    conn()
      .then(({ token, session }) => (session.contactsAccountId ? listContacts(token, session) : []))
      .then((c) => {
        contacts = c;
        // Typed while they were loading: suggest now.
        const input = el?.querySelector<HTMLInputElement>(`.chips[data-field="${field}"] input`);
        if (input && document.activeElement === input && input.value.trim()) suggest(field, input.value);
      })
      .catch(() => {});
  }
  const items: Address[] = [];
  for (const c of contacts) {
    for (const e of c.emails) {
      if ((c.name.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)) && items.length < 6) items.push({ name: c.name, email: e.value });
    }
  }
  if (!items.length) return hideSuggest();
  suggestFor = { field, items, index: 0 };
  const box = $c('.suggest');
  const input = $c(`.chips[data-field="${field}"] input`);
  box.style.top = `${input.getBoundingClientRect().bottom - el!.getBoundingClientRect().top + 2}px`;
  renderHtml(box, html`${items.map((a, i) => html`<button class="sitem${i === 0 ? ' on' : ''}" data-i="${i}"><b>${a.name}</b> <span>${a.email}</span></button>`)}`);
  box.hidden = false;
}

function pickSuggestion(i: number) {
  if (!suggestFor) return;
  const a = suggestFor.items[i]!;
  const input = $c<HTMLInputElement>(`.chips[data-field="${suggestFor.field}"] input`);
  input.value = '';
  insert(input, 'beforebegin', chipHtml(a));
  hideSuggest();
  input.focus();
  edited();
}

// --- The view ------------------------------------------------------------------------------------

const TOOLS: [keyof typeof ICONS, string, string][] = [
  ['bold', 'bold', 'Bold (Ctrl+B)'],
  ['italic', 'italic', 'Italic (Ctrl+I)'],
  ['underline', 'underline', 'Underline (Ctrl+U)'],
  ['link', 'link', 'Link (Ctrl+K)'],
  ['list', 'insertUnorderedList', 'Bulleted list'],
  ['listOrdered', 'insertOrderedList', 'Numbered list'],
  ['quote', 'quote', 'Quote'],
];

function render(host: HTMLElement) {
  el?.remove();
  el = document.createElement('div');
  el.className = `composer ${state!.mode === 'new' ? 'standalone' : 'inline'}`;
  const d = state!.draft;
  renderHtml(
    el,
    html`
    <div class="cbar">
      <span class="csendwrap">
        <button class="pill primary csend" title="Send (Ctrl+Enter)">${ICONS.send}Send</button>${
          canSchedule && html`<button class="pill primary ccaret" title="Schedule send" aria-haspopup="menu">${ICONS.down}</button>`
        }
        <div class="cschedule dropmenu" role="menu" hidden></div>
      </span>
      <span class="cstatus" aria-live="polite"></span>
      <span class="spacer"></span>
      <button class="icon cattach" title="Attach files">${ICONS.paperclip}</button><input class="cfile" type="file" multiple hidden>
      <button class="icon cpop" title="Pop out">${ICONS.popout}</button>
      <button class="icon cdiscard" title="Discard draft">${ICONS.trash}</button>
      <button class="icon cclose" title="Close, keeping the draft (Esc)">${ICONS.x}</button>
    </div>
    <div class="cfield"><label>From</label><select class="cfrom">${identities.map(
      (i) => html`<option value="${i.id}"${i.id === d.identityId && html` selected`}>${i.name ? `${i.name} <${i.email}>` : i.email}</option>`,
    )}</select></div>
    ${FIELDS.map(
      (f) => html`<div class="cfield" data-row="${f}"${f !== 'to' && html` hidden`}><label>${f === 'to' ? 'To' : f === 'cc' ? 'Cc' : 'Bcc'}</label>
        <div class="chips" data-field="${f}"><input type="text" autocomplete="off" spellcheck="false" aria-label="${f}"></div>
        ${f === 'to' && html`<button class="ctoggle" data-show="cc">Cc</button><button class="ctoggle" data-show="bcc">Bcc</button>`}</div>`,
    )}
    <div class="cfield"><label>Subject</label><input class="csubject" type="text" value="${d.subject}"></div>
    <div class="ctools">${TOOLS.map(([icon, cmd, label]) => html`<button class="icon" data-cmd="${cmd}" title="${label}">${ICONS[icon]}</button>`)}
      <span class="clink" hidden><input type="url" placeholder="https://…"><button class="pill">Add link</button></span></div>
    <div class="cbody" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message">${
      // Editor HTML: built from sanitizeForEditor / escapeHtml output (lib/compose.ts, openDraft), or our own snapshot of it.
      raw(d.html)
    }</div>
    <div class="catts"></div>
    <div class="suggest" hidden></div>`,
  );
  host.append(el);
  for (const f of FIELDS) setChips(f, d[f]);
  renderAttachments();
  wire();
}

function wire() {
  const body = $c('.cbody');
  el!.addEventListener('input', (e) => {
    const t = e.target as HTMLElement;
    const field = t.closest<HTMLElement>('.chips')?.dataset.field as Field | undefined;
    if (field) suggest(field, (t as HTMLInputElement).value);
    edited();
  });
  el!.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t.matches('.cfile')) return void attachFiles(t as HTMLInputElement);
    if (t.matches('.cfrom')) swapSignature();
    edited();
  });
  el!.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.csendwrap')) hideSchedule();
    if (t.closest('.chip .x')) {
      t.closest('.chip')!.remove();
      return edited();
    }
    const show = t.closest<HTMLElement>('[data-show]')?.dataset.show;
    if (show) {
      $c(`.cfield[data-row="${show}"]`).hidden = false;
      $c<HTMLInputElement>(`.chips[data-field="${show}"] input`).focus();
      return;
    }
    if (t.closest('.chips') && !t.closest('.chip')) return t.closest('.chips')!.querySelector('input')!.focus();
    const item = t.closest<HTMLElement>('.sitem');
    if (item) return pickSuggestion(Number(item.dataset.i));
    const cmd = t.closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
    if (cmd) return format(cmd);
    if (t.closest('.csend')) return void send();
    if (t.closest('.ccaret')) return toggleSchedule();
    const when = t.closest<HTMLElement>('[data-when]')?.dataset.when;
    if (when) return void send(new Date(Number(when)));
    if (t.closest('.cpick')) return showPicker();
    if (t.closest('.cpickgo')) return pickTime();
    if (t.closest('.cclose')) return void close();
    if (t.closest('.cdiscard')) return void discard();
    if (t.closest('.cpop')) return void popOut();
    if (t.closest('.cattach')) return $c<HTMLInputElement>('.cfile').click();
    const drop = t.closest<HTMLElement>('[data-drop]')?.dataset.drop;
    if (drop !== undefined) return removeAttachment(Number(drop));
    if (t.closest('.clink button')) return applyLink();
  });
  el!.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') return e.preventDefault(), void send();
    if (mod && e.key.toLowerCase() === 'k' && t === body) return e.preventDefault(), format('link');
    if (e.key === 'Escape') {
      e.preventDefault(); // Esc would close the dropdown
      e.stopPropagation();
      if (!$c('.cschedule').hidden) return hideSchedule();
      if (suggestFor) return hideSuggest();
      if (!$c('.clink').hidden) return void ($c('.clink').hidden = true);
      return void close();
    }
    const field = t.closest<HTMLElement>('.chips')?.dataset.field as Field | undefined;
    if (!field || !(t instanceof HTMLInputElement)) return;
    if (suggestFor?.field === field && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      suggestFor.index = (suggestFor.index + (e.key === 'ArrowDown' ? 1 : -1) + suggestFor.items.length) % suggestFor.items.length;
      $c('.suggest').querySelectorAll('.sitem').forEach((b, i) => b.classList.toggle('on', i === suggestFor!.index));
      return;
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && t.value.trim())) {
      if (!t.value.trim() && e.key !== 'Enter') return;
      e.preventDefault();
      if (suggestFor?.field === field) pickSuggestion(suggestFor.index);
      else commitInput(field);
      return;
    }
    if (e.key === 'Backspace' && !t.value) {
      t.previousElementSibling?.classList.contains('chip') && t.previousElementSibling.remove();
      edited();
    }
  });
  el!.addEventListener('focusout', (e) => {
    const t = e.target as HTMLElement;
    const field = t.closest<HTMLElement>('.chips')?.dataset.field as Field | undefined;
    // Leaving a recipient box commits what's typed (after a click on a suggestion lands).
    if (field) setTimeout(() => el && !el.contains(document.activeElement?.closest('.suggest') ?? null) && commitInput(field), 150);
  });
  // Pasted mail is untrusted HTML going into this page: same allowlist as quotes.
  body.addEventListener('paste', (e) => {
    const html = e.clipboardData?.getData('text/html');
    const text = e.clipboardData?.getData('text/plain');
    e.preventDefault();
    if (html) document.execCommand('insertHTML', false, sanitizeForEditor(html));
    else if (text) document.execCommand('insertText', false, text);
    edited();
  });
  body.addEventListener('drop', (e) => e.preventDefault()); // no dropped HTML or files (attachments later)
}

// --- Attachments -------------------------------------------------------------------------------------

let uploading = 0;

function renderAttachments() {
  if (!el) return;
  const list = state?.draft.attachments ?? [];
  renderHtml(
    $c('.catts'),
    html`${list.map(
      (a, i) =>
        html`<span class="catt">${ICONS.paperclip}<span class="cname">${a.name}</span><span class="csize">${fmtSize(a.size)}</span><button class="x" data-drop="${i}" title="Remove">${ICONS.x}</button></span>`,
    )}${uploading > 0 && html`<span class="catt busy">Uploading ${uploading} file${uploading === 1 ? '' : 's'}…</span>`}`,
  );
}

/** Upload chosen files to Fastmail and attach them (checked against its upload limit). */
async function attachFiles(input: HTMLInputElement) {
  const files = [...(input.files ?? [])];
  input.value = '';
  if (!files.length || !state) return;
  const { token, session } = await conn();
  const max = session.maxSizeUpload || Infinity;
  for (const file of files) {
    if (file.size > max) {
      status(`${file.name} is too big (limit ${fmtSize(max)})`, 'err');
      continue;
    }
    uploading++;
    renderAttachments();
    try {
      const att = await uploadBlob(token, session, file);
      if (!state) return;
      state.draft.attachments = [...(state.draft.attachments ?? []), att];
      edited();
    } catch (e) {
      status(`Couldn't attach ${file.name}: ${(e as Error).message}`, 'err');
    } finally {
      uploading--;
      renderAttachments();
    }
  }
}

function removeAttachment(i: number) {
  if (!state?.draft.attachments) return;
  state.draft.attachments = state.draft.attachments.filter((_, n) => n !== i);
  renderAttachments();
  edited();
}

/** A different From: its signature replaces the old one (added if there wasn't one). */
function swapSignature() {
  const identity = identities.find((i) => i.id === $c<HTMLSelectElement>('.cfrom').value);
  const inner = signatureInner(identity);
  const body = $c('.cbody');
  let sig = body.querySelector<HTMLElement>('.sig');
  if (!sig && inner) {
    sig = document.createElement('div');
    sig.className = 'sig';
    // After the first (blank) line, above any quote.
    (body.firstElementChild ?? body).after(sig);
  }
  if (sig) {
    if (inner) renderHtml(sig, raw(inner)); // sanitizeForEditor or escapeHtml output (signatureInner)
    else sig.remove();
  }
}

// --- Schedule send -----------------------------------------------------------------------------------

/** The server can hold messages (Fastmail's maxDelayedSend): schedule send and Undo work. */
let canSchedule = false;
let maxDelay = 0;

function toggleSchedule() {
  const menu = $c('.cschedule');
  if (!menu.hidden) return hideSchedule();
  const now = new Date();
  const ok = (d: Date) => d > now && (d.getTime() - now.getTime()) / 1000 <= maxDelay;
  renderHtml(
    menu,
    html`<div class="mhint">Schedule send for</div>${scheduleChoices(now).map(
      ([label, d, off]) =>
        html`<button class="mi" role="menuitem" data-when="${d.getTime()}"${(off || !ok(d)) && html` disabled`}><span class="label">${label}</span><span class="hint">${whenLabel(d, now)}</span></button>`,
    )}<button class="mi cpick" role="menuitem"><span class="label">Choose a date and time…</span></button><div class="cpickrow" hidden><input type="datetime-local"><button class="pill primary cpickgo">Schedule</button></div>`,
  );
  menu.hidden = false;
}

function hideSchedule() {
  if (el) $c('.cschedule').hidden = true;
}

function showPicker() {
  const row = $c('.cpickrow');
  row.hidden = false;
  const input = row.querySelector('input')!;
  const soon = new Date(Date.now() + 3600e3);
  soon.setMinutes(0, 0, 0);
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  input.min = local(new Date());
  input.max = local(new Date(Date.now() + maxDelay * 1000));
  input.value = local(soon);
  input.focus();
}

function pickTime() {
  const value = $c<HTMLInputElement>('.cpickrow input').value;
  const d = value ? new Date(value) : undefined;
  if (!d || isNaN(+d) || d <= new Date()) return status('Choose a time in the future', 'err');
  send(d);
}

function format(cmd: string) {
  const body = $c('.cbody');
  body.focus();
  if (cmd === 'link') {
    $c('.clink').hidden = false;
    $c<HTMLInputElement>('.clink input').focus();
    return;
  }
  if (cmd === 'quote') document.execCommand('formatBlock', false, 'blockquote');
  else document.execCommand(cmd);
  edited();
}

function applyLink() {
  const input = $c<HTMLInputElement>('.clink input');
  const url = input.value.trim();
  $c('.clink').hidden = true;
  input.value = '';
  $c('.cbody').focus();
  if (/^(https?:|mailto:)/i.test(url)) document.execCommand('createLink', false, url);
  edited();
}

// --- Opening, sending, closing -------------------------------------------------------------------

async function prepare() {
  const { token, session } = await conn();
  if (!session.canSend) throw new Error('This token can’t send mail');
  maxDelay = session.maxDelayedSend ?? 0;
  canSchedule = maxDelay > 0;
  if (!identities.length) identities = await getIdentities(token, session);
  roles ??= await mailboxRoles(token, session);
}

/** Open a new message, or a reply / reply all / forward of `original` (inline in `host`). */
export async function openComposer(mode: ComposeMode, original?: FullEmail, host?: HTMLElement) {
  if (state) await close({ quiet: true });
  try {
    await prepare();
  } catch (e) {
    return hooks.toast((e as Error).message, 'err');
  }
  const draft = startDraft(mode, identities, original);
  state = { mode, draft, initial: '', dirty: false };
  document.body.classList.add('composing');
  render(mode === 'new' || !host ? hooks.showNewPane() : host);
  // As the form holds it (the browser normalises the body's markup), so "unchanged" compares like with like.
  state.initial = written(readDraft());
  const focus = mode === 'new' || mode === 'forward' ? `.chips[data-field="to"] input` : '.cbody';
  $c(focus).focus();
  if (focus === '.cbody') placeCaretAtStart($c('.cbody'));
  el!.scrollIntoView({ block: 'nearest' });
}

function placeCaretAtStart(node: HTMLElement) {
  const r = document.createRange();
  r.setStart(node, 0);
  r.collapse(true);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(r);
}

/** Carry on with a draft from the Drafts folder. */
export async function openDraft(email: FullEmail) {
  if (state) await close({ quiet: true });
  try {
    await prepare();
  } catch (e) {
    return hooks.toast((e as Error).message, 'err');
  }
  const from = email.from[0]?.email.toLowerCase();
  const identity = identities.find((i) => i.email.toLowerCase() === from) ?? identities[0];
  const draft: Draft = {
    identityId: identity?.id ?? '',
    to: email.to,
    cc: email.cc,
    bcc: email.bcc ?? [],
    subject: email.subject === '(no subject)' ? '' : email.subject,
    html: email.html ? sanitizeForEditor(email.html) : `<div>${escapeHtml(email.text ?? '').replace(/\n/g, '<br>')}</div>`,
    inReplyTo: email.inReplyTo,
    references: email.references,
    attachments: email.attachments ?? [],
  };
  state = { mode: 'new', draft, draftId: email.id, initial: '', dirty: false, existing: true };
  document.body.classList.add('composing');
  render(hooks.showNewPane());
  state.initial = written(readDraft());
  $c('.cbody').focus();
}

/** Reopen what was being written when the dropdown last closed. */
export async function restoreComposer(): Promise<boolean> {
  const snap = (await browser.storage.local.get(SNAPSHOT))[SNAPSHOT] as Snapshot | undefined;
  if (!snap?.draft) return false;
  if (!snap.popout && isEmpty(snap.draft, snap.initial)) {
    await clearSnapshot(); // an untouched compose isn't worth reopening
    return false;
  }
  try {
    await prepare();
  } catch {
    return false;
  }
  state = { mode: snap.mode === 'new' ? 'new' : snap.mode, draft: snap.draft, draftId: snap.draftId, initial: snap.initial, dirty: true };
  document.body.classList.add('composing');
  render(hooks.showNewPane());
  if (!snap.popout) status('Restored');
  return true;
}

async function send(holdUntil?: Date) {
  if (!state || sending) return;
  hideSchedule();
  const draft = readDraft({ commitTyped: true });
  const all = [...draft.to, ...draft.cc, ...draft.bcc] as (Address & { invalid?: boolean })[];
  if (!all.length) return status('Add a recipient', 'err');
  const bad = all.find((a) => a.invalid);
  if (bad) return status(`Check this address: ${bad.email}`, 'err');
  const identity = identities.find((i) => i.id === draft.identityId);
  if (!identity) return status('Choose who it’s from', 'err');
  if (uploading) return status('Wait for the attachments to finish uploading', 'err');
  sending = true;
  status('Sending…');
  clearTimeout(saveTimer);
  clearTimeout(snapTimer);
  await saving.catch(() => {}); // a save in flight: send replaces whatever it produced
  try {
    const { token, session } = await conn();
    roles ??= await mailboxRoles(token, session);
    const sent = await sendMessage(token, session, draft, identity, roles, {
      oldDraftId: state.draftId,
      holdFor: canSchedule ? UNDO_SECONDS : 0,
      holdUntil,
    });
    const mode = state.mode;
    await finish();
    const msg = holdUntil && sent.undoable ? `Scheduled for ${whenLabel(new Date(sent.sendAt!))}` : sent.undoable ? 'Message sent' : 'Sent';
    hooks.toast(msg, '', sent.undoable ? () => undoSend(sent, mode, draft) : undefined);
  } catch (e) {
    // The message it created is the draft now (the old one was removed), so retrying won't duplicate.
    if (e instanceof SendError && e.draftId && state) {
      state.draftId = e.draftId;
      snapshot();
    }
    status(`Couldn't send: ${(e as Error).message}`, 'err');
  } finally {
    sending = false;
  }
}

async function undoSend(sent: Sent, mode: ComposeMode, draft: Draft) {
  try {
    const { token, session } = await conn();
    await cancelSend(token, session, sent, roles!);
  } catch (e) {
    return hooks.toast(e instanceof AlreadySent ? 'Already sent' : `Couldn't undo: ${(e as Error).message}`, 'err');
  }
  // Back to writing it (the message is in Drafts again).
  if (state) await close({ quiet: true });
  await prepare().catch(() => {});
  state = { mode: mode === 'new' ? 'new' : mode, draft, draftId: sent.emailId, initial: '', dirty: false };
  document.body.classList.add('composing');
  render(hooks.showNewPane());
  snapshot();
  status('Not sent: back in your drafts');
}

/** Put it away (draft kept), e.g. when leaving the conversation it's replying in. */
export const closeComposer = () => close();
export const discardComposer = () => discard();
/** Nothing written since it opened. */
export const composerEmpty = () => Boolean(state && el && isEmpty(readDraft(), state.initial));

/** Save to Drafts now, staying in the message. */
export async function saveComposer() {
  if (!state) return;
  if (isEmpty(readDraft(), state.initial)) return hooks.toast('Nothing to save yet');
  if (!state.draftId) state.dirty = true;
  await saveToServer();
  if (state && !state.dirty) hooks.toast('Draft saved');
}

/** Put it away: the draft stays in Drafts. */
async function close({ quiet = false } = {}) {
  if (!state) return;
  clearTimeout(snapTimer);
  if (isEmpty(readDraft(), state.initial)) {
    // Nothing written: no draft left behind (an existing draft stays as it was), nothing to reopen.
    const id = state.existing ? undefined : state.draftId;
    await saving.catch(() => {});
    await finish();
    if (id) conn().then(({ token, session }) => discardDraft(token, session, id)).catch(() => {});
    return;
  }
  await saveToServer();
  const saved = Boolean(state.draftId) && !state.dirty;
  if (saved) await clearSnapshot();
  else snapshot(); // couldn't save: keep it locally
  await finish({ keepSnapshot: true });
  if (!quiet && saved) hooks.toast('Draft saved');
}

async function discard() {
  if (!state) return;
  clearTimeout(saveTimer);
  clearTimeout(snapTimer);
  await saving.catch(() => {});
  const id = state.draftId;
  await finish();
  if (id) {
    try {
      const { token, session } = await conn();
      await discardDraft(token, session, id);
    } catch {
      /* it stays in Drafts */
    }
  }
  hooks.toast('Draft discarded');
}

async function finish({ keepSnapshot = false } = {}) {
  clearTimeout(saveTimer);
  clearTimeout(snapTimer);
  if (!keepSnapshot) await clearSnapshot();
  state = undefined;
  el?.remove();
  el = undefined;
  document.body.classList.remove('composing');
  hooks.closed();
}

/** Keep writing in a window of its own (the snapshot carries it over). */
async function popOut() {
  snapshot({ popout: true });
  await saveToServer();
  await browser.windows.create({ url: browser.runtime.getURL('/popup.html?popout=1' as any), type: 'popup', width: 720, height: 640 });
  state = undefined;
  el?.remove();
  el = undefined;
  document.body.classList.remove('composing');
  window.close();
}

export function initComposer(h: ComposerHooks) {
  hooks = h;
  // Leaving the dropdown: make sure the latest text is in the local snapshot.
  addEventListener('pagehide', () => state && snapshot());
}
