// The Files app: browse Fastmail Files (folders, breadcrumbs, sizes, dates), download files, preview
// images inside the dropdown, and change things: upload (button or drag and drop), new folder,
// rename, move (pick it up, go to the folder, Move here) and delete (asked first). Loaded on demand.
// Listings are cached in session storage (memory only, dropped on lock) so a folder shows at once
// while it's checked again.
import { browser } from 'wxt/browser';
import {
  badName,
  connectFiles,
  download,
  FilesAuthError,
  listFolder,
  makeFolder,
  moveTo,
  NameTaken,
  NoFilesPassword,
  remove,
  upload,
  within,
  parentOf,
  previewable,
  rootUrl,
  trail,
  type FileEntry,
  type Listing,
} from '@/lib/files';
import { ICONS } from '@/lib/icons';
import { getCachedSession, getUnlocked } from '@/lib/storage';
import { html, render as renderHtml, type Html } from '@/lib/html';
import { fmtSize } from './ui';

const $ = (id: string) => document.getElementById(id)!;
let here = '';
let listing: Listing | undefined;
let selected = -1;
let previewUrl: string | undefined;
/** Picked up to move: shown in the bar until it's put down (Move here) or dropped (Cancel). */
let moving: FileEntry | undefined;
/** A row being renamed, or a new folder being named (-1). */
let naming: number | undefined;
const popout = new URLSearchParams(location.search).has('popout');

// --- Cache ---------------------------------------------------------------------------------------
type Stored = Omit<Listing, 'entries' | 'folder'> & { folder: StoredEntry; entries: StoredEntry[]; at: number };
type StoredEntry = Omit<FileEntry, 'modified'> & { modified?: string };
const store = (e: FileEntry): StoredEntry => ({ ...e, modified: e.modified?.toISOString() });
const revive = (e: StoredEntry): FileEntry => ({ ...e, modified: e.modified ? new Date(e.modified) : undefined });

async function cached(url: string): Promise<Listing | undefined> {
  const { filesCache } = (await browser.storage.session.get('filesCache')) as { filesCache?: Record<string, Stored> };
  const s = filesCache?.[url];
  return s && { folder: revive(s.folder), entries: s.entries.map(revive), quota: s.quota };
}
/** After a change: other folders' listings may be out of date too. */
const forgetOthers = () => browser.storage.session.remove('filesCache');

async function remember(url: string, l: Listing) {
  const { filesCache = {} } = (await browser.storage.session.get('filesCache')) as { filesCache?: Record<string, Stored> };
  filesCache[url] = { folder: store(l.folder), entries: l.entries.map(store), quota: l.quota, at: Date.now() };
  // The last 30 folders.
  const keep = Object.entries(filesCache).sort((a, b) => b[1].at - a[1].at).slice(0, 30);
  await browser.storage.session.set({ filesCache: Object.fromEntries(keep) });
}

// --- Rendering -------------------------------------------------------------------------------------

function message(h?: Html) {
  if (h) renderHtml($('filesMsg'), h);
  else $('filesMsg').replaceChildren();
  $('filesMsg').hidden = !h;
  $('filesList').hidden = Boolean(h);
}

const fmtDate = (d?: Date) =>
  !d ? '' : d.getFullYear() === new Date().getFullYear() ? d.toLocaleDateString([], { day: 'numeric', month: 'short' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

function iconFor(e: FileEntry): Html {
  if (e.folder) return ICONS.folder;
  if (previewable(e) || /^image\//.test(e.type ?? '')) return ICONS.image;
  return ICONS.file;
}

function render() {
  const t = trail(here);
  renderHtml(
    $('filesTrail'),
    html`${t.map((c, i) => html`${i > 0 && html`<span class="sep">›</span>`}${i === t.length - 1 ? html`<span class="here">${c.name}</span>` : html`<button data-go="${c.url}">${c.name}</button>`}`)}`,
  );
  ($('filesUp') as HTMLButtonElement).hidden = t.length < 2;
  const q = listing?.quota;
  $('filesQuota').textContent = q ? `${fmtSize(q.used)} of ${fmtSize(q.used + q.available)}` : '';
  if (!listing) return;
  if (!listing.entries.length) {
    renderHtml($('filesList'), html`<li class="fempty">This folder is empty</li>`);
    return;
  }
  // A refresh mid-typing keeps what's typed (and where).
  const typing = $('filesList').querySelector<HTMLInputElement>('.fnameinput');
  const kept = typing && { value: typing.value, from: typing.selectionStart, to: typing.selectionEnd };
  const nameField = (value: string) => html`<input class="fnameinput" value="${kept?.value ?? value}" aria-label="Name" autocomplete="off">`;
  const newRow = naming === -1 && html`<li class="frow folder naming"><span class="ficon">${ICONS.folder}</span>${nameField('')}<span></span><span></span></li>`;
  renderHtml(
    $('filesList'),
    html`${newRow}${listing.entries.map(
      (e, i) => html`<li class="frow${e.folder && ' folder'}${i === selected && ' sel'}${moving?.url === e.url && ' moving'}${naming === i && ' naming'}" data-i="${i}" title="${e.name}">
        <span class="ficon">${iconFor(e)}</span>${naming === i ? nameField(e.name) : html`<span class="fname">${e.name}</span>`}
        <span class="fsize">${e.folder ? '' : fmtSize(e.size ?? 0)}</span><span class="fdate">${fmtDate(e.modified)}</span>
        <span class="factions"><button data-fa="rename" title="Rename">${ICONS.edit}</button><button data-fa="move" title="Move">${ICONS.move}</button><button data-fa="delete" title="Delete">${ICONS.trash}</button></span></li>`,
    )}`,
  );
  const input = $('filesList').querySelector<HTMLInputElement>('.fnameinput');
  if (input) {
    input.focus();
    // Renaming a file: the name without its extension selected.
    const dot = naming !== undefined && naming >= 0 && !listing.entries[naming]!.folder ? input.value.lastIndexOf('.') : -1;
    if (kept) input.setSelectionRange(kept.from, kept.to);
    else input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }
  renderBar();
}

// --- The bar: moving, questions and results --------------------------------------------------------

let note: { text: string; kind: '' | 'err' } | undefined;
let ask: { text: string; yes: string; danger?: boolean; then: () => void } | undefined;

function say(text: string, kind: '' | 'err' = '') {
  note = { text, kind };
  ask = undefined;
  renderBar();
  if (!kind) setTimeout(() => note?.text === text && ((note = undefined), renderBar()), 4000);
}

function renderBar() {
  const bar = $('filesBar');
  let h: Html | undefined;
  if (ask) h = html`<span class="ftext">${ask.text}</span><button class="pill" data-bar="no">Cancel</button><button class="pill ${ask.danger ? 'danger' : 'primary'}" data-bar="yes">${ask.yes}</button>`;
  else if (moving) {
    const from = parentOf(moving.url);
    const where = within(here, moving.url) ? 'it can’t go inside itself' : from && within(here, from) && within(from, here) ? 'it’s in this folder' : '';
    h = html`<span class="ftext">Moving <b>${moving.name}</b>${where ? ` (${where}): open another folder` : ': open the folder it goes in'}</span>
      <button class="pill" data-bar="cancelmove">Cancel</button>${!where && html`<button class="pill primary" data-bar="movehere">Move here</button>`}`;
  } else if (note) h = html`<span class="ftext ${note.kind}">${note.text}</span>`;
  if (h) renderHtml(bar, h);
  else bar.replaceChildren();
  bar.hidden = !h;
}

// --- Changes -------------------------------------------------------------------------------------

/** Do a change, then show the folder as it is now. */
async function change(work: () => Promise<void>, done: string) {
  naming = undefined;
  try {
    await work();
    await forgetOthers();
    say(done);
  } catch (e) {
    say(e instanceof NameTaken || e instanceof FilesAuthError ? e.message : `Couldn't do that: ${(e as Error).message}`, 'err');
  }
  await go(here, { keepBar: true });
}

async function uploadFiles(files: File[]) {
  if (!files.length) return;
  for (const [i, file] of files.entries()) {
    say(files.length > 1 ? `Uploading ${i + 1} of ${files.length}: ${file.name}…` : `Uploading ${file.name}…`);
    try {
      await upload(here, file);
    } catch (e) {
      if (!(e instanceof NameTaken)) {
        say(`Couldn't upload ${file.name}: ${(e as Error).message}`, 'err');
        continue;
      }
      // Already there: replace it only if asked.
      const existing = listing?.entries.find((x) => x.name === file.name && !x.folder);
      const replace = await new Promise<boolean>((resolve) => {
        ask = { text: `${file.name} is already here.`, yes: 'Replace', then: () => resolve(true) };
        cancelAsk = () => resolve(false);
        renderBar();
      });
      ask = undefined;
      if (replace && existing) await upload(here, file, existing).catch((err) => say(`Couldn't replace ${file.name}: ${(err as Error).message}`, 'err'));
    }
  }
  await forgetOthers();
  say(files.length > 1 ? `Uploaded ${files.length} files` : `Uploaded ${files[0]!.name}`);
  await go(here, { keepBar: true });
}
let cancelAsk: (() => void) | undefined;

function startUpload() {
  // A file picker closes the toolbar dropdown (and what was picked with it), so uploads happen in a
  // window of their own, at this folder.
  if (!popout) {
    browser.windows.create({ url: browser.runtime.getURL(`/popup.html?popout=1&files=${encodeURIComponent(here)}` as any), type: 'popup', width: 720, height: 640 });
    return window.close();
  }
  ($('filesInput') as HTMLInputElement).click();
}

function confirmDelete(e: FileEntry) {
  ask = {
    text: e.folder ? `Delete the folder ${e.name} and everything in it?` : `Delete ${e.name}?`,
    yes: 'Delete',
    danger: true,
    then: () => change(() => remove(e), `Deleted ${e.name}`),
  };
  renderBar();
}

async function finishNaming(input: HTMLInputElement) {
  const i = naming;
  const name = input.value.trim();
  naming = undefined;
  if (i === undefined) return;
  const old = i >= 0 ? listing?.entries[i] : undefined;
  if (old && name === old.name) return render();
  const bad = badName(name);
  if (bad) {
    say(bad, 'err');
    return render();
  }
  if (old) await change(() => moveTo(old, here, name), `Renamed to ${name}`);
  else await change(() => makeFolder(here, name), `Made ${name}`);
}

// --- Navigation ----------------------------------------------------------------------------------

async function go(url: string, { keepBar = false } = {}) {
  // Another folder: start afresh. The same one (a refresh): carry on with anything being named.
  if (url !== here) (selected = -1), (naming = undefined);
  here = url;
  if (!keepBar && !moving) (note = undefined), (ask = undefined);
  closePreview();
  listing = await cached(url);
  message();
  render();
  if (!listing) renderHtml($('filesList'), html`<li class="fempty">Loading…</li>`);
  try {
    const fresh = await listFolder(url);
    if (here !== url) return; // moved on meanwhile
    listing = fresh;
    remember(url, fresh);
    render();
  } catch (e) {
    if (here !== url) return;
    if (!listing) message(html`<p>${e instanceof FilesAuthError ? e.message : `Couldn't open this folder: ${(e as Error).message}`}</p>`);
  }
}

async function open(e: FileEntry) {
  if (e.folder) return go(e.url);
  if (previewable(e)) return preview(e);
  save(e);
}

async function save(e: FileEntry) {
  try {
    const url = URL.createObjectURL(await download(e));
    Object.assign(document.createElement('a'), { href: url, download: e.name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    message(html`<p>Couldn't download ${e.name}: ${(err as Error).message}</p>`);
  }
}

/** Images (PNG, JPEG, GIF, WebP only) open inside the dropdown, with Download. */
async function preview(e: FileEntry) {
  const box = $('filesPreview');
  renderHtml(
    box,
    html`<div class="fphead"><span class="fpname">${e.name}</span><button class="pill" data-download>Download</button>
    <button class="icon" data-close title="Close (Esc)">×</button></div><div class="fpbody">Loading…</div>`,
  );
  box.hidden = false;
  try {
    const blob = await download(e);
    previewUrl = URL.createObjectURL(blob);
    renderHtml(box.querySelector('.fpbody')!, html`<img alt="${e.name}" src="${previewUrl}">`);
  } catch (err) {
    box.querySelector('.fpbody')!.textContent = `Couldn't load it: ${(err as Error).message}`;
  }
  (box.querySelector('[data-download]') as HTMLElement).onclick = () => save(e);
  (box.querySelector('[data-close]') as HTMLElement).onclick = closePreview;
}

function closePreview() {
  $('filesPreview').hidden = true;
  $('filesPreview').replaceChildren();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
}

function select(i: number) {
  if (!listing?.entries.length) return;
  selected = Math.max(0, Math.min(listing.entries.length - 1, i));
  render();
  $('filesList').querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

/** Open (or refresh) the Files app; `at` opens a given folder (the upload window). */
export async function showFiles({ refresh = false, at }: { refresh?: boolean; at?: string } = {}) {
  if (at) here = at;
  const [unlocked, session] = await Promise.all([getUnlocked(), getCachedSession()]);
  try {
    connectFiles(session, unlocked?.secrets.davPassword);
  } catch (e) {
    if (e instanceof NoFilesPassword) {
      message(html`<p>${e.message}</p><button class="pill primary" id="filesSetup">Open settings</button>`);
      document.getElementById('filesSetup')!.onclick = () => browser.runtime.openOptionsPage();
    } else message(html`<p>${(e as Error).message}</p>`);
    return;
  }
  if (!here || refresh) await go(here || rootUrl());
  else go(here);
}

/** Files keys: j / k move, Enter or o opens, u or Backspace goes up, Delete / # deletes, Esc closes a preview or a question. */
export function filesKey(e: KeyboardEvent): boolean {
  if (e.key === 'Escape' && !$('filesPreview').hidden) closePreview();
  else if (e.key === 'Escape' && (ask || moving)) $('filesBar').querySelector<HTMLElement>('[data-bar="no"], [data-bar="cancelmove"]')?.click();
  else if ((e.key === 'Delete' || e.key === '#') && listing?.entries[selected]) confirmDelete(listing.entries[selected]!);
  else if (e.key === 'j' || e.key === 'ArrowDown') select(selected + 1);
  else if (e.key === 'k' || e.key === 'ArrowUp') select(selected - 1);
  else if ((e.key === 'Enter' || e.key === 'o') && listing?.entries[selected]) open(listing.entries[selected]!);
  else if ((e.key === 'u' || e.key === 'Backspace') && parentOf(here)) go(parentOf(here)!);
  else return false;
  return true;
}

export function initFiles() {
  $('filesList').addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.closest('.fnameinput')) return;
    const i = Number(t.closest<HTMLElement>('[data-i]')?.dataset.i);
    const entry = listing?.entries[i];
    if (!entry) return;
    selected = i;
    const action = t.closest<HTMLElement>('[data-fa]')?.dataset.fa;
    if (action === 'rename') return (naming = i), render();
    if (action === 'move') return (moving = entry), (ask = undefined), render();
    if (action === 'delete') return confirmDelete(entry);
    open(entry);
  });
  // Naming: Enter saves, Esc puts it back (leaving the field saves too).
  $('filesList').addEventListener('keydown', (e) => {
    const input = (e.target as Element).closest<HTMLInputElement>('.fnameinput');
    if (!input) return;
    if (e.key === 'Enter') finishNaming(input);
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      naming = undefined;
      render();
    }
  });
  $('filesList').addEventListener('focusout', (e) => {
    const input = (e.target as Element).closest<HTMLInputElement>('.fnameinput');
    // Not when the list is redrawn (the field goes, and comes back with what was typed).
    setTimeout(() => {
      if (input?.isConnected && naming !== undefined && document.activeElement !== input) finishNaming(input);
    });
  });
  $('filesBar').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-bar]')?.dataset.bar;
    if (b === 'yes' && ask) {
      const then = ask.then;
      ask = undefined;
      cancelAsk = undefined;
      renderBar();
      then();
    } else if (b === 'no') {
      ask = undefined;
      cancelAsk?.();
      cancelAsk = undefined;
      renderBar();
    } else if (b === 'cancelmove') {
      moving = undefined;
      render();
    } else if (b === 'movehere' && moving) {
      const m = moving;
      moving = undefined;
      change(() => moveTo(m, here), `Moved ${m.name}`);
    }
  });
  $('filesNew').onclick = () => {
    naming = -1;
    render();
  };
  $('filesUpload').onclick = startUpload;
  $('filesInput').addEventListener('change', () => {
    const input = $('filesInput') as HTMLInputElement;
    uploadFiles([...(input.files ?? [])]);
    input.value = '';
  });
  // Drag and drop files from the computer onto the folder.
  const view = $('filesView');
  view.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    view.classList.add('dropping');
  });
  view.addEventListener('dragleave', (e) => {
    if (!view.contains(e.relatedTarget as Node)) view.classList.remove('dropping');
  });
  view.addEventListener('drop', (e) => {
    view.classList.remove('dropping');
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    uploadFiles([...e.dataTransfer.files]);
  });
  $('filesTrail').addEventListener('click', (e) => {
    const url = (e.target as Element).closest<HTMLElement>('[data-go]')?.dataset.go;
    if (url) go(url);
  });
  $('filesUp').onclick = () => parentOf(here) && go(parentOf(here)!);
}
