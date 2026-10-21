// Fastmail Files over WebDAV, with the Calendar/Files password (Basic auth; the username is the JMAP
// session's). A small client of our own: listing (PROPFIND), download (GET) and the changes (PUT,
// MKCOL, MOVE, DELETE, conditional on ETags). Uses DOMParser, so it runs in pages (popup, options),
// never in the background.
//
// URLs: hrefs from the server are used as they come (resolved against the request URL, never
// re-encoded); names this app makes are encoded one path segment at a time.
import type { Session } from './jmap';

const ROOT = __FILES_URL__;
const D = 'DAV:';

export interface FileEntry {
  /** Absolute URL, as the server gave it (folders end in "/"). */
  url: string;
  name: string;
  folder: boolean;
  size?: number;
  modified?: Date;
  type?: string;
  etag?: string;
}

export interface Listing {
  folder: FileEntry;
  /** Folders first, then files, each in natural order ("file2" before "file10"). */
  entries: FileEntry[];
  quota?: { used: number; available: number };
}

export class FilesAuthError extends Error {}
export class NoFilesPassword extends Error {}
export class FileConflict extends Error {}

let auth: string | undefined;

/** Sign in with what the vault holds; a clear error if there's no Calendar/Files password yet. */
export function connectFiles(session: Session | undefined, davPassword: string | undefined) {
  if (!davPassword) throw new NoFilesPassword('Add a Calendar/Files password in settings to see your files.');
  if (!session?.username) throw new Error('Not connected yet');
  auth = `Basic ${btoa(`${session.username}:${davPassword}`)}`;
}

export const rootUrl = () => ROOT;

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  if (!auth) throw new Error('Not signed in to Files');
  const res = await fetch(url, { ...init, credentials: 'omit', headers: { Authorization: auth, ...init.headers } });
  if (res.status === 401 || res.status === 403)
    throw new FilesAuthError("Fastmail didn't accept the Calendar/Files password for Files. It needs an app password with Files access: check it in settings.");
  if (res.status === 412) throw new FileConflict('That changed somewhere else, or the name is taken. Refresh and try again.');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const PROPS =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/>' +
  '<d:getcontenttype/><d:getetag/><d:quota-used-bytes/><d:quota-available-bytes/></d:prop></d:propfind>';

/** The decoded path, with one trailing slash for folders: for comparing hrefs written differently. */
const norm = (url: string) => decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '');
const nameOf = (url: string) => norm(url).split('/').pop() || 'Files';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A folder's contents (and the folder itself). */
export async function listFolder(url = ROOT): Promise<Listing> {
  const res = await request(url, { method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPS });
  const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
  const text = (el: Element, tag: string) => el.getElementsByTagNameNS(D, tag)[0]?.textContent?.trim() || undefined;
  let folder: FileEntry | undefined;
  let quota: Listing['quota'];
  const entries: FileEntry[] = [];
  for (const r of doc.getElementsByTagNameNS(D, 'response')) {
    const href = text(r, 'href');
    if (!href) continue;
    const abs = new URL(href, url).href;
    const isFolder = r.getElementsByTagNameNS(D, 'collection').length > 0;
    const size = text(r, 'getcontentlength');
    const modified = text(r, 'getlastmodified');
    const entry: FileEntry = {
      url: isFolder && !abs.endsWith('/') ? `${abs}/` : abs,
      name: nameOf(abs),
      folder: isFolder,
      size: size ? Number(size) : undefined,
      modified: modified ? new Date(modified) : undefined,
      type: text(r, 'getcontenttype'),
      etag: text(r, 'getetag'),
    };
    // The folder lists itself too: that's the folder, not an entry.
    if (norm(abs) === norm(url)) {
      folder = entry;
      const used = text(r, 'quota-used-bytes');
      const available = text(r, 'quota-available-bytes');
      if (used && available) quota = { used: Number(used), available: Number(available) };
    } else entries.push(entry);
  }
  entries.sort((a, b) => (a.folder === b.folder ? collator.compare(a.name, b.name) : a.folder ? -1 : 1));
  return { folder: folder ?? { url, name: nameOf(url), folder: true }, entries, quota };
}

/** The folders from the top down to `url`, for breadcrumbs: [{ name, url }]. */
export function trail(url: string): { name: string; url: string }[] {
  const root = new URL(ROOT);
  const here = new URL(url);
  const rest = here.pathname.slice(root.pathname.length).split('/').filter(Boolean);
  const out = [{ name: 'Files', url: root.href }];
  let path = root.pathname;
  for (const seg of rest) {
    path += `${seg}/`;
    out.push({ name: decodeURIComponent(seg), url: new URL(path, root).href });
  }
  return out;
}

/** The parent folder's URL, or undefined at the top. */
export function parentOf(url: string): string | undefined {
  const t = trail(url);
  return t.length > 1 ? t[t.length - 2]!.url : undefined;
}

export async function download(entry: FileEntry): Promise<Blob> {
  return (await request(entry.url)).blob();
}

/** Image types shown inside the popup (never SVG: it can carry scripts). */
export const PREVIEWABLE = /^image\/(png|jpe?g|gif|webp)$/i;
export const previewable = (e: FileEntry) =>
  !e.folder && (PREVIEWABLE.test(e.type ?? '') || (!e.type && /\.(png|jpe?g|gif|webp)$/i.test(e.name)));

// --- Changes -----------------------------------------------------------------------------------------
// Conditional, so nothing is overwritten by accident: new names must be free (If-None-Match / Overwrite:
// F), and a file is replaced or deleted only as it was listed (If-Match on its ETag).

/** A name for a new file or folder: no slashes, not "." or "..". */
export function badName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Give it a name';
  if (n.includes('/') || n.includes('\\')) return 'Names can’t contain / or \\';
  if (n === '.' || n === '..') return 'That name isn’t allowed';
  return undefined;
}

/** The URL of `name` inside a folder (encoded as one path segment). */
const child = (folderUrl: string, name: string, folder = false) => new URL(`${encodeURIComponent(name.trim())}${folder ? '/' : ''}`, folderUrl).href;

export class NameTaken extends Error {}

async function guarded(url: string, init: RequestInit, taken: string): Promise<Response> {
  try {
    return await request(url, init);
  } catch (e) {
    if (e instanceof FileConflict || /HTTP 405/.test((e as Error).message)) throw new NameTaken(taken);
    throw e;
  }
}

/** Upload a file into a folder. `replace` (the existing entry) overwrites it, only if it's unchanged. */
export async function upload(folderUrl: string, file: File, replace?: FileEntry): Promise<void> {
  const url = replace?.url ?? child(folderUrl, file.name);
  const condition: Record<string, string> = replace ? (replace.etag ? { 'If-Match': replace.etag } : {}) : { 'If-None-Match': '*' };
  await guarded(url, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream', ...condition }, body: file }, `${file.name} is already there`);
}

export async function makeFolder(folderUrl: string, name: string): Promise<void> {
  await guarded(child(folderUrl, name, true), { method: 'MKCOL' }, `There's already something called ${name.trim()}`);
}

/** Rename (same folder) or move (another folder); never onto something that's there. */
export async function moveTo(entry: FileEntry, folderUrl: string, name = entry.name): Promise<void> {
  const dest = child(folderUrl, name, entry.folder);
  await guarded(entry.url, { method: 'MOVE', headers: { Destination: dest, Overwrite: 'F' } }, `There's already something called ${name.trim()} there`);
}

/** Delete a file (only as listed) or a folder with everything in it. */
export async function remove(entry: FileEntry): Promise<void> {
  await request(entry.url, { method: 'DELETE', headers: !entry.folder && entry.etag ? { 'If-Match': entry.etag } : {} });
}

/** Whether `url` is `folder` itself or inside it (a folder can't move into itself). */
export const within = (url: string, folder: string) => norm(url) === norm(folder) || norm(url).startsWith(`${norm(folder)}/`);
