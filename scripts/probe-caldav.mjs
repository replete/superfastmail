// READ-ONLY CalDAV probe (PROPFIND / REPORT only — the DAV password can write, so nothing else).
// Prints counts and structure only: no event titles, places, people or calendar names.
//   node --env-file=.env scripts/probe-caldav.mjs
const token = process.env.FASTMAIL_API_KEY;
const pass = process.env.DAV_PASS;
if (!token || !pass) throw new Error('FASTMAIL_API_KEY and DAV_PASS must be set');
const session = await (await fetch('https://api.fastmail.com/jmap/session', { headers: { Authorization: `Bearer ${token}` } })).json();
const auth = { Authorization: `Basic ${Buffer.from(`${session.username}:${pass}`).toString('base64')}` };
const HOST = 'https://caldav.fastmail.com';

async function dav(method, url, body, depth = '0') {
  if (!['PROPFIND', 'REPORT'].includes(method)) throw new Error('read-only probe');
  const res = await fetch(url, { method, headers: { ...auth, Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body });
  return { status: res.status, xml: await res.text() };
}
const responses = (xml) => xml.split(/<(?:[\w-]+:)?response[\s>]/).slice(1);
const href = (b) => b.match(/<(?:[\w-]+:)?href>([^<]+)</)?.[1];
const PF = (inner) => `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${inner}</d:prop></d:propfind>`;

const wk = await dav('PROPFIND', `${HOST}/.well-known/caldav`, PF('<d:current-user-principal/>'));
const principal = href(wk.xml.split('current-user-principal')[1] ?? '');
const p = await dav('PROPFIND', new URL(principal, HOST).href, PF('<c:calendar-home-set/>'));
const home = new URL(href(p.xml.split('calendar-home-set')[1] ?? ''), HOST).href;
const list = await dav('PROPFIND', home, PF('<d:resourcetype/><c:supported-calendar-component-set/>'), '1');
const cals = responses(list.xml).filter((b) => /<(?:[\w-]+:)?calendar[\s/>]/.test(b) && /name="VEVENT"/.test(b)).map((b) => new URL(href(b), HOST).href);
console.log(`calendars with events: ${cals.length}`);

const ics = (d) => d.toISOString().replace(/[-:]|\.\d+/g, '');
const start = new Date(), end = new Date(Date.now() + 14 * 864e5);
const query = (expand) => `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/>
  <c:calendar-data>${expand ? `<c:expand start="${ics(start)}" end="${ics(end)}"/>` : ''}</c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${ics(start)}" end="${ics(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;

const tally = {};
for (const expand of [false, true]) {
  const t = { objects: 0, vevents: 0, rrule: 0, valarm: 0, vtimezone: 0, tzid: 0, utcStart: 0, allDay: 0, recurrenceId: 0, status: new Set() };
  for (const cal of cals) {
    const r = await dav('REPORT', cal, query(expand), '1');
    t.status.add(r.status);
    for (const b of responses(r.xml)) {
      const data = (b.match(/calendar-data[^>]*>([\s\S]*?)<\//)?.[1] ?? '').replace(/&#13;/g, '');
      if (!data) continue;
      t.objects++;
      t.vevents += (data.match(/BEGIN:VEVENT/g) ?? []).length;
      t.rrule += /^RRULE:/m.test(data) ? 1 : 0;
      t.valarm += /BEGIN:VALARM/.test(data) ? 1 : 0;
      t.vtimezone += /BEGIN:VTIMEZONE/.test(data) ? 1 : 0;
      t.tzid += /^DTSTART;TZID=/m.test(data) ? 1 : 0;
      t.utcStart += (data.match(/^DTSTART:\d{8}T\d{6}Z/gm) ?? []).length;
      t.allDay += /^DTSTART;VALUE=DATE:/m.test(data) ? 1 : 0;
      t.recurrenceId += (data.match(/^RECURRENCE-ID/gm) ?? []).length;
    }
  }
  t.status = [...t.status].join(',');
  tally[expand ? 'expanded' : 'as stored'] = t;
}
console.log(JSON.stringify(tally, null, 1));
