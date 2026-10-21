// Fastmail's DAV servers, used with an app password (Basic auth; the username is the JMAP session's).
// Fastmail offers calendars and files to apps only over CalDAV and WebDAV, not to API tokens.
// Uses DOMParser, so it runs in pages (options, popup), not in a Chrome service worker.
const CALDAV = __CALDAV_URL__;
const FILES = __FILES_URL__;
const D = 'DAV:';
const C = 'urn:ietf:params:xml:ns:caldav';

export class DavAuthError extends Error {}

const propfind = (inner: string) =>
  `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="${C}"><d:prop>${inner}</d:prop></d:propfind>`;

async function dav(url: string, user: string, pass: string, body: string, depth = '0') {
  const res = await fetch(url, {
    method: 'PROPFIND',
    // Never let the browser show its own login prompt for a 401.
    credentials: 'omit',
    headers: {
      Authorization: `Basic ${btoa(`${user}:${pass}`)}`,
      Depth: depth,
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body,
  });
  if (res.status === 401 || res.status === 403) throw new DavAuthError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new DOMParser().parseFromString(await res.text(), 'application/xml');
}

const hrefIn = (doc: Document, ns: string, tag: string) =>
  doc.getElementsByTagNameNS(ns, tag)[0]?.getElementsByTagNameNS(D, 'href')[0]?.textContent ?? undefined;

/** Check an app password: how many calendars it can see, and whether it can reach Files. */
export async function testDav(user: string, pass: string): Promise<{ calendars: number; files: boolean }> {
  const wk = await dav(new URL('/.well-known/caldav', CALDAV).href, user, pass, propfind('<d:current-user-principal/>'));
  const principal = hrefIn(wk, D, 'current-user-principal');
  if (!principal) throw new Error('no calendar account found');
  const p = await dav(new URL(principal, CALDAV).href, user, pass, propfind('<c:calendar-home-set/>'));
  const home = hrefIn(p, C, 'calendar-home-set');
  if (!home) throw new Error('no calendars found');
  const list = await dav(new URL(home, CALDAV).href, user, pass, propfind('<d:resourcetype/>'), '1');
  const calendars = [...list.getElementsByTagNameNS(D, 'response')].filter(
    (r) => r.getElementsByTagNameNS(C, 'calendar').length,
  ).length;
  const files = await dav(FILES, user, pass, propfind('<d:resourcetype/>')).then(
    () => true,
    () => false,
  );
  return { calendars, files };
}
