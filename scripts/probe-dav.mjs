// Checks the DAV app password in .env (DAV_PASS) against Fastmail's CalDAV, CardDAV and WebDAV
// servers, and looks for somewhere notes might live. Prints HTTP statuses and counts only: no
// usernames, calendar/file names or content. The username comes from the JMAP session.
//
//   pnpm probe:dav
const token = process.env.FASTMAIL_API_KEY;
const pass = process.env.DAV_PASS;
if (!token || !pass) throw new Error('FASTMAIL_API_KEY and DAV_PASS must be set (run via `pnpm probe:dav`)');

const session = await (await fetch('https://api.fastmail.com/jmap/session', { headers: { Authorization: `Bearer ${token}` } })).json();
const user = session.username;
const basic = { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };

/** All <response> blocks in a multistatus body, whatever the namespace prefix. */
const responses = (xml) => xml.split(/<(?:[\w-]+:)?response[\s>]/).slice(1);
const has = (block, tag) => new RegExp(`<(?:[\\w-]+:)?${tag}[\\s/>]`).test(block);
const href = (block) => block.match(/<(?:[\w-]+:)?href>([^<]+)</)?.[1];

async function dav(method, url, body, depth = '0') {
  const res = await fetch(url, {
    method,
    headers: { ...basic, Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
    body,
  });
  return { status: res.status, url: res.url, xml: await res.text() };
}

const PROP = (inner) => `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="urn:ietf:params:xml:ns:carddav"><d:prop>${inner}</d:prop></d:propfind>`;

/** Discover the home collection via /.well-known → current-user-principal → home-set. */
async function home(host, kind, homeProp) {
  const wk = await dav('PROPFIND', `https://${host}/.well-known/${kind}`, PROP('<d:current-user-principal/>'));
  const principal = href(responses(wk.xml).find((b) => has(b, 'current-user-principal'))?.split(/current-user-principal/)[1] ?? '');
  console.log(`${kind}: well-known ${wk.status}, principal ${principal ? 'found' : 'missing'}`);
  if (!principal) return;
  const p = await dav('PROPFIND', new URL(principal, `https://${host}/`).href, PROP(`<${homeProp}/>`));
  const homeHref = href(p.xml.split(homeProp.replace(/^\w+:/, ''))[1] ?? '');
  console.log(`${kind}: principal ${p.status}, home ${homeHref ? 'found' : 'missing'}`);
  return homeHref && new URL(homeHref, `https://${host}/`).href;
}

// CalDAV
const calHome = await home('caldav.fastmail.com', 'caldav', 'c:calendar-home-set');
if (calHome) {
  const list = await dav('PROPFIND', calHome, PROP('<d:resourcetype/><c:supported-calendar-component-set/>'), '1');
  const cals = responses(list.xml).filter((b) => has(b, 'calendar'));
  const todo = cals.filter((b) => /name="VTODO"/.test(b)).length;
  console.log(`caldav: list ${list.status}, calendars ${cals.length} (${todo} accept tasks)`);
  const now = new Date();
  const ics = (d) => d.toISOString().replace(/[-:]|\.\d+/g, '');
  const week = new Date(now.getTime() + 7 * 864e5);
  let events = 0;
  for (const c of cals) {
    const r = await dav(
      'REPORT',
      new URL(href(c), calHome).href,
      `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${ics(now)}" end="${ics(week)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      '1',
    );
    events += responses(r.xml).length;
  }
  console.log(`caldav: events in the next 7 days: ${events}`);
}

// CardDAV
const cardHome = await home('carddav.fastmail.com', 'carddav', 'a:addressbook-home-set');
if (cardHome) {
  const list = await dav('PROPFIND', cardHome, PROP('<d:resourcetype/>'), '1');
  console.log(`carddav: list ${list.status}, address books ${responses(list.xml).filter((b) => has(b, 'addressbook')).length}`);
}

// WebDAV files
for (const url of ['https://myfiles.fastmail.com/', 'https://webdav.fastmail.com/']) {
  const r = await dav('PROPFIND', url, PROP('<d:resourcetype/>'), '1').catch((e) => ({ status: e.message, xml: '' }));
  const items = responses(r.xml).slice(1); // first is the folder itself
  const notes = items.some((b) => /\/notes\/?<|\/notes\/?$/i.test(href(b) ?? ''));
  console.log(`files ${new URL(url).host}: ${r.status}, top-level items ${items.length}${notes ? ', has a Notes folder' : ''}`);
}

// Notes: Fastmail syncs notes over IMAP (Apple Notes style), so look for a Notes mailbox via JMAP.
const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
const mb = await (
  await fetch(session.apiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Mailbox/get', { accountId, properties: ['name', 'role', 'totalEmails'] }, '0']],
    }),
  })
).json();
const noteBoxes = mb.methodResponses[0][1].list.filter((m) => /^notes$/i.test(m.name));
console.log(`notes (JMAP): ${noteBoxes.length ? noteBoxes.map((m) => `mailbox role=${m.role ?? '-'} items=${m.totalEmails}`).join('; ') : 'no Notes mailbox'}`);
console.log('session capabilities mentioning notes:', Object.keys(session.capabilities).filter((c) => /note/i.test(c)).join(', ') || 'none');
