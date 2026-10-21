// A fake Fastmail JMAP server for tests: the extension talks to it exactly as it talks to
// api.fastmail.com, so write actions (archive, delete, send…) can be tested end to end without
// touching a real mailbox. All data is made up. State lives in memory and resets on restart.
//
//   node scripts/fake-fastmail.mjs [port]      (standalone, for manual UI work)
//   import { startFakeFastmail } from './fake-fastmail.mjs'   (from the e2e harness)
//
// Tokens: "fake-token" (read/write) and "fake-read-only". Anything else gets 401.
// Implements what the extension uses: Mailbox/get|query, Email/query|get|set, Thread/get,
// Identity/get, EmailSubmission/set, ContactCard/query|get, MaskedEmail/get|set, back-references,
// and an event source for push.
import http from 'node:http';
import ICAL from 'ical.js';

const ACCOUNT = 'A1';
const MAX_DELAY = 44236800; // seconds, as Fastmail advertises (maxDelayedSend)
const CAPS = {
  core: 'urn:ietf:params:jmap:core',
  mail: 'urn:ietf:params:jmap:mail',
  submission: 'urn:ietf:params:jmap:submission',
  contacts: 'urn:ietf:params:jmap:contacts',
  vacation: 'urn:ietf:params:jmap:vacationresponse',
  masked: 'https://www.fastmail.com/dev/maskedemail',
};

const FILLER = [
  ['Garden Centre', 'Spring bulbs are in', 'Plant now for colour next year. 20% off this weekend.'],
  ['Parcel Tracking', 'Your parcel is on its way', 'Expected delivery: tomorrow between 10:00 and 14:00.'],
  ['Book Club', 'Next month: The Long Way', 'We meet on the 14th. Bring snacks if you can.'],
  ['Bank Alerts', 'Your statement is ready', 'Your monthly statement is now available to view.'],
  ['Jamie Rivers', 'Draft proposal for review', 'Could you take a look before Friday? Comments welcome.'],
  ['Calendar', 'Reminder: Dentist at 09:30', 'This is a reminder for your appointment tomorrow.'],
  ['Weather Service', 'Weekend outlook', 'Sunny spells on Saturday, showers likely on Sunday.'],
  ['Code Host', '[repo] New issue opened', 'A new issue was opened: Popup is too narrow on small screens.'],
  ['Travel Desk', 'Booking confirmed', 'Your train tickets are attached. Have a good trip.'],
  ['Morgan Lee', 'Coffee next week?', 'It has been ages. Tuesday or Wednesday morning?'],
  ['Utility Co', 'Meter reading due', 'Please submit your meter reading by the end of the month.'],
  ['Podcast Weekly', 'Episode 42 is out', 'This week: building tools you actually enjoy using.'],
];

/** Mail that "arrives" when a test asks for it (GET /fake/new). */
const ARRIVALS = [
  ['Alex Example', 'alex@example.com', 'Quick question', 'Have you got five minutes this afternoon?'],
  ['Sam Sample', 'sam@example.org', 'Tickets sorted', 'Got us two tickets for Saturday.'],
  ['Parcel Tracking', 'parcel.tracking@example.com', 'Delivered', 'Your parcel was left with a neighbour.'],
];

// --- CalDAV (Calendar/Files password "fake-dav-password") -------------------------------------
const DAV_USER = 'test.user@example.com';
const DAV_PASSWORD = 'fake-dav-password';
const HOME = `/dav/calendars/user/${DAV_USER}/`;
const PRINCIPAL = `/dav/principals/user/${DAV_USER}/`;
const pad = (n) => String(n).padStart(2, '0');
const icsUtc = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const icsDate = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const vcal = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//fake//EN\r\n${body}END:VCALENDAR\r\n`;

function calendarFixtures() {
  const now = new Date();
  const at = (days, h, m = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const day = (days) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return d;
  };
  // A weekly event that started last week, with one occurrence moved an hour later.
  const standup = at(-7, 9, 30);
  const moved = new Date(standup.getTime() + 14 * 864e5);
  const objects = {
    'work/standup.ics': vcal(
      `BEGIN:VEVENT\r\nUID:standup@example.com\r\nDTSTAMP:${icsUtc(now)}\r\nDTSTART:${icsUtc(standup)}\r\nDTEND:${icsUtc(new Date(standup.getTime() + 15 * 60e3))}\r\n` +
        `RRULE:FREQ=WEEKLY\r\nSUMMARY:Team standup\r\nLOCATION:Room 2\r\nEND:VEVENT\r\n` +
        `BEGIN:VEVENT\r\nUID:standup@example.com\r\nDTSTAMP:${icsUtc(now)}\r\nRECURRENCE-ID:${icsUtc(moved)}\r\nDTSTART:${icsUtc(new Date(moved.getTime() + 3600e3))}\r\n` +
        `DTEND:${icsUtc(new Date(moved.getTime() + 3600e3 + 15 * 60e3))}\r\nSUMMARY:Team standup (moved)\r\nEND:VEVENT\r\n`,
    ),
    'work/review.ics': vcal(
      `BEGIN:VEVENT\r\nUID:review@example.com\r\nDTSTAMP:${icsUtc(now)}\r\nDTSTART:${icsUtc(at(2, 14))}\r\nDTEND:${icsUtc(at(2, 15))}\r\nSUMMARY:Project review\r\nDESCRIPTION:Bring the budget numbers.\r\nEND:VEVENT\r\n`,
    ),
    'personal/dentist.ics': vcal(
      `BEGIN:VEVENT\r\nUID:dentist@example.com\r\nDTSTAMP:${icsUtc(now)}\r\nDTSTART:${icsUtc(at(1, 10))}\r\nDTEND:${icsUtc(at(1, 10, 30))}\r\nSUMMARY:Dentist\r\nLOCATION:High Street\r\n` +
        `BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT\r\n`,
    ),
    // Its reminder is due as the server starts, so a session shows one straight away.
    'personal/call.ics': vcal(
      `BEGIN:VEVENT\r\nUID:call@example.com\r\nDTSTAMP:${icsUtc(now)}\r\nDTSTART:${icsUtc(new Date(now.getTime() + 5 * 60e3))}\r\nDTEND:${icsUtc(new Date(now.getTime() + 35 * 60e3))}\r\nSUMMARY:Call Alex\r\n` +
        `BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT\r\n`,
    ),
    'personal/holiday.ics': vcal(
      `BEGIN:VEVENT\r\nUID:holiday@example.com\r\nDTSTAMP:${icsUtc(now)}\r\nDTSTART;VALUE=DATE:${icsDate(day(3))}\r\nDTEND;VALUE=DATE:${icsDate(day(4))}\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\n`,
    ),
  };
  let n = 0;
  return {
    calendars: [
      { id: 'personal', name: 'Personal', color: '#2bb673FF', comps: ['VEVENT'] },
      { id: 'work', name: 'Work', color: '#3d8fd9FF', comps: ['VEVENT'] },
      { id: 'tasks', name: 'Tasks', color: '#999999FF', comps: ['VTODO'] },
    ],
    objects: new Map(Object.entries(objects).map(([k, ics]) => [`${HOME}${k}`, { ics, etag: `"e${++n}"` }])),
  };
}

const xmlEsc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const multistatus = (responses) =>
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ca="http://apple.com/ns/ical/">${responses.join('')}</d:multistatus>`;
const davResponse = (href, props) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const parseIcsUtc = (v) => new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15)));

/** Occurrences of a stored object overlapping [from, to), as Fastmail's <C:expand> returns them. */
function expandObject(ics, from, to) {
  const root = new ICAL.Component(ICAL.parse(ics));
  const vevents = root.getAllSubcomponents('vevent');
  const master = vevents.find((v) => !v.hasProperty('recurrence-id'));
  const out = [];
  const emit = (src, start, end, rid) => {
    if (!(start.toJSDate() < to && end.toJSDate() > from)) return;
    const v = new ICAL.Component('vevent');
    for (const p of src.getAllProperties()) if (!['dtstart', 'dtend', 'duration', 'rrule', 'recurrence-id', 'exdate'].includes(p.name)) v.addProperty(ICAL.Property.fromString(p.toICALString()));
    const put = (name, t) => {
      const prop = new ICAL.Property(name);
      if (t.isDate) prop.setValue(t);
      else prop.setValue(ICAL.Time.fromJSDate(t.toJSDate(), true));
      v.addProperty(prop);
    };
    put('dtstart', start);
    put('dtend', end);
    if (rid) put('recurrence-id', rid);
    for (const a of src.getAllSubcomponents('valarm')) v.addSubcomponent(new ICAL.Component(a.toJSON()));
    out.push(v.toString());
  };
  if (master?.hasProperty('rrule')) {
    const event = new ICAL.Event(master, { exceptions: vevents.filter((v) => v !== master) });
    const it = event.iterator();
    for (let next = it.next(), i = 0; next && i < 500; next = it.next(), i++) {
      if (next.toJSDate() >= to) break;
      const d = event.getOccurrenceDetails(next);
      emit(d.item.component, d.startDate, d.endDate, d.recurrenceId);
    }
  } else if (master) {
    const e = new ICAL.Event(master);
    emit(master, e.startDate, e.endDate ?? e.startDate);
  }
  return out.length ? vcal(out.join('\r\n') + '\r\n') : undefined;
}

/** CalDAV requests: discovery, calendars, calendar-query (time range, expand), GET/PUT/DELETE with ETags. */
async function handleDav(req, res, url, cal) {
  if (url.pathname === '/.well-known/caldav') return res.writeHead(301, { Location: '/dav/calendars' }).end();
  const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
  if (basic !== `${DAV_USER}:${DAV_PASSWORD}`) return res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake"' }).end();
  let body = '';
  for await (const c of req) body += c;
  const path = decodeURIComponent(url.pathname);
  const xml = (code, payload) => res.writeHead(code, { 'Content-Type': 'application/xml; charset=utf-8' }).end(payload);
  const calOf = (p) => cal.calendars.find((c) => p.startsWith(`${HOME}${c.id}/`));
  if (req.method === 'PROPFIND') {
    if (path === '/dav/calendars' || path === '/dav/calendars/')
      return xml(207, multistatus([davResponse('/dav/calendars/', `<d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal>`)]));
    if (path === PRINCIPAL)
      return xml(207, multistatus([davResponse(PRINCIPAL, `<c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set><d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal>`)]));
    if (path === HOME) {
      const rows = [davResponse(HOME, '<d:resourcetype><d:collection/></d:resourcetype><d:displayname>Calendars</d:displayname>')];
      for (const c of cal.calendars) {
        const ctag = [...cal.objects.entries()].filter(([k]) => k.startsWith(`${HOME}${c.id}/`)).map(([, o]) => o.etag).join('');
        rows.push(
          davResponse(
            `${HOME}${c.id}/`,
            `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${xmlEsc(c.name)}</d:displayname><ca:calendar-color><![CDATA[${c.color}]]></ca:calendar-color>` +
              `<cs:getctag>${xmlEsc(ctag || 'empty')}</cs:getctag><d:sync-token>s${ctag.length}</d:sync-token><c:supported-calendar-component-set>${c.comps.map((x) => `<c:comp name="${x}"/>`).join('')}</c:supported-calendar-component-set>`,
          ),
        );
      }
      return xml(207, multistatus(rows));
    }
    if (calOf(path)) return xml(207, multistatus([davResponse(path, '<d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report></d:supported-report-set>')]));
    return res.writeHead(404).end();
  }
  if (req.method === 'REPORT') {
    const c = calOf(path);
    if (!c) return res.writeHead(404).end();
    const range = body.match(/time-range[^>]*start="(\d{8}T\d{6}Z)"[^>]*end="(\d{8}T\d{6}Z)"/);
    const expand = /<[\w-]*:?expand[\s/]/.test(body);
    const from = range ? parseIcsUtc(range[1]) : new Date(0);
    const to = range ? parseIcsUtc(range[2]) : new Date(8.64e15);
    const rows = [];
    for (const [href, o] of cal.objects) {
      if (!href.startsWith(`${HOME}${c.id}/`)) continue;
      const hit = expandObject(o.ics, from, to);
      if (!hit) continue;
      rows.push(davResponse(href, `<d:getetag>${xmlEsc(o.etag)}</d:getetag><c:calendar-data>${xmlEsc(expand ? hit : o.ics)}</c:calendar-data>`));
    }
    return xml(207, multistatus(rows));
  }
  const obj = cal.objects.get(path);
  if (req.method === 'GET') return obj ? res.writeHead(200, { 'Content-Type': 'text/calendar', ETag: obj.etag }).end(obj.ics) : res.writeHead(404).end();
  if (req.method === 'PUT') {
    if (!calOf(path) || !path.endsWith('.ics')) return res.writeHead(403).end();
    if (req.headers['if-none-match'] === '*' && obj) return res.writeHead(412).end('exists');
    if (req.headers['if-match'] && (!obj || req.headers['if-match'] !== obj.etag)) return res.writeHead(412).end('etag mismatch');
    try {
      const v = new ICAL.Component(ICAL.parse(body)).getFirstSubcomponent('vevent');
      const e = new ICAL.Event(v);
      // All-day: DTEND (exclusive) must be after DTSTART — the classic off-by-one.
      if (e.startDate.isDate && e.endDate && e.endDate.compare(e.startDate) <= 0) return res.writeHead(400).end('all-day end must be after start');
      // A TZID needs its VTIMEZONE in the object (Fastmail doesn't take zones by reference).
      const zones = new Set(new ICAL.Component(ICAL.parse(body)).getAllSubcomponents('vtimezone').map((z) => z.getFirstPropertyValue('tzid')));
      for (const prop of v.getAllProperties()) {
        const tzid = prop.getParameter('tzid');
        if (tzid && !zones.has(tzid)) return res.writeHead(400).end(`no VTIMEZONE for ${tzid}`);
      }
    } catch (err) {
      return res.writeHead(400).end(`bad iCalendar: ${err.message}`);
    }
    const etag = `"e${Date.now()}${Math.random().toString(36).slice(2, 6)}"`;
    cal.objects.set(path, { ics: body, etag });
    cal.writes.push([req.method, path]);
    return res.writeHead(obj ? 204 : 201, { ETag: etag }).end();
  }
  if (req.method === 'DELETE') {
    if (!obj) return res.writeHead(404).end();
    if (req.headers['if-match'] && req.headers['if-match'] !== obj.etag) return res.writeHead(412).end('etag mismatch');
    cal.objects.delete(path);
    cal.writes.push([req.method, path]);
    return res.writeHead(204).end();
  }
  return res.writeHead(405).end();
}

const PWN = 'PWN_URL'; // replaced with this server's /fake/pwned URL when served
const HOSTILE = `<p>Hostile payloads (a test fixture).</p>
<img src="x" onerror="parent.window.__pwned='img onerror'">
<svg onload="parent.window.__pwned='svg onload'" width="160" height="24"><a id="svga"><animate attributeName="href" values="javascript:parent.window.__pwned='svg animate'"/><text y="16">svg link</text></a></svg>
<p><a id="tabjs" href="java&#x09;script:parent.window.__pwned='tab js'" target="_blank">tab-split javascript link</a></p>
<p><a id="spacejs" href=" &#x20;javascript:parent.window.__pwned='space js'">space javascript link</a></p>
<p><a id="datahtml" href="data:text/html,<script>opener&&(opener.parent.__pwned='data')</script>" target="_blank">data html link</a></p>
<p><a id="web" href="https://example.com/hostile-test" target="_blank">ordinary web link</a></p>
<p><a id="self" href="https://example.com/self-target" target="_self">web link that targets the frame</a></p>
<p><a id="top" href="https://example.com/top-target" target="_top">web link that targets the top</a></p>
<form action="${PWN}?form"><button>submit</button></form>
<meta http-equiv="refresh" content="0;url=${PWN}?refresh">
<iframe src="${PWN}?iframe"></iframe>
<img src="${PWN}?img">
<style>@import url(${PWN}?css); body { background-image: url(${PWN}?bg); }</style>
<object data="${PWN}?object"></object>
<base href="${PWN}/">
<a id="rel" href="relative-link">relative link</a>`;

/** More paragraphs, so the thread is long enough to scroll. */
const LONG_FILLER = [
  'I can put together a short comparison of the three if that helps: price per head, travel time from the station, and what is included.',
  'One thing to check: the second venue only has the big room on the afternoon of the 14th, so the workshop would have to be then.',
  'Parking is limited at all three, so it may be easier to tell people to come by train. I will include the timetable in the invite.',
];
const LONG = [
  ['Jamie Rivers', 'We need to pick a venue for the offsite. I have three options with different prices and travel times.'],
  ['Morgan Lee', 'The second one looks best to me. It is closest to the station and has a big room for the workshop sessions.'],
  ['Sam Sample', 'Agree on the second venue. Can we check whether they do lunch, or should we bring caterers in ourselves?'],
  ['Jamie Rivers', 'They do lunch. I have pencilled in the 14th and 15th. Shout if those dates do not work for anyone.'],
];

function fixtures() {
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const person = (name, email) => ({ name, email });
  const alex = person('Alex Example', 'alex@example.com');
  const sam = person('Sam Sample', 'sam@example.org');
  const me = person('Test User', 'test.user@example.com');
  const mail = (id, threadId, from, subject, body, min, { seen = false, flagged = false, mailbox = 'mb-inbox', attach = false, to = [me] } = {}) => ({
    id,
    threadId,
    messageId: [`<${id}@example.com>`],
    mailboxIds: { [mailbox]: true },
    keywords: { ...(seen ? { $seen: true } : {}), ...(flagged ? { $flagged: true } : {}) },
    from: [from],
    to,
    cc: [],
    subject,
    receivedAt: ago(min),
    preview: body.replace(/<[^>]+>/g, '').slice(0, 120),
    hasAttachment: attach,
    html: body.startsWith('<') ? body : undefined,
    text: body.startsWith('<') ? undefined : body,
  });
  return {
    mailboxes: [
      { id: 'mb-inbox', name: 'Inbox', role: 'inbox', sortOrder: 1 },
      { id: 'mb-archive', name: 'Archive', role: 'archive', sortOrder: 2 },
      { id: 'mb-drafts', name: 'Drafts', role: 'drafts', sortOrder: 3 },
      { id: 'mb-sent', name: 'Sent', role: 'sent', sortOrder: 4 },
      { id: 'mb-junk', name: 'Spam', role: 'junk', sortOrder: 5 },
      { id: 'mb-trash', name: 'Trash', role: 'trash', sortOrder: 6 },
      { id: 'mb-work', name: 'Work', role: null, sortOrder: 10 },
      { id: 'mb-work-2024', name: '2024', role: null, sortOrder: 1, parentId: 'mb-work' },
      { id: 'mb-tests', name: 'Test fixtures', role: null, sortOrder: 20 },
    ],
    emails: [
      { ...mail('e1', 't1', alex, 'Quarterly planning notes', '<p>Here are the notes from today.</p><p>Talk soon,<br>Alex</p>', 12, { attach: true }),
        attachments: [{ partId: '3', blobId: 'blob-notes', name: 'notes.pdf', type: 'application/pdf', size: 20, disposition: 'attachment' }] },
      mail('e2', 't2', person('Billing Team', 'billing@example.net'), 'Your invoice is ready', 'Invoice #1234 for October is now available.', 95, { flagged: true }),
      mail('e3', 't3', sam, 'Lunch Thursday?', 'Are you free around 12:30? There is a new place on the corner.', 300, { seen: true }),
      mail('e4', 't4', person('Newsletter', 'news@example.com'), 'This week in widgets', '<h1>Widgets</h1><p>Five things you missed this week.</p>', 3000, { seen: true }),
      mail('e5', 't5', sam, 'Re: Holiday dates', 'Those dates work for me.', 4000),
      mail('e6', 't5', me, 'Re: Holiday dates', 'How about the 20th to the 27th?', 4100, { seen: true, mailbox: 'mb-sent', to: [sam] }),
      mail('e7', 't7', person('Old Friend', 'friend@example.org'), 'Photos from the trip', 'Finally sorted the photos, link inside.', 9000, { seen: true, mailbox: 'mb-archive' }),
      // Test-only fixtures (kept out of the Inbox; tests open them by id).
      // Security: every payload tries to reach /fake/pwned or set parent.__pwned. Nothing should.
      mail('x1', 'tx', person('Hostile Test', 'hostile@example.com'), 'Hostile test message', HOSTILE, 50000, { seen: true, mailbox: 'mb-tests' }),
      // Layout fixture: a wrapper sized to the window (100vh) must not make the frame grow forever.
      mail('v1', 'tv', person('Layout Test', 'layout@example.com'), 'Full-height layout', '<div style="min-height:100vh;background:#eef">Full-height wrapper</div>', 50100, { seen: true, mailbox: 'mb-tests' }),
      // A longer conversation: four messages with several paragraphs, the last two unread.
      ...LONG.map(([from, body], i) =>
        mail(`l${i + 1}`, 'tl', person(from, `${from.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`), i ? 'Re: Offsite planning' : 'Offsite planning',
          [body, ...LONG_FILLER.slice(0, 3)].map((t) => `<p>${t}</p>`).join(''), 2000 - i * 100, { seen: i < 2 }),
      ),
      // An HTML message with an image embedded in it (cid:), as mail clients send logos and photos.
      { ...mail('i1', 'ti1', person('Design Team', 'design@example.com'), 'New logo', '<p>Here is the new logo:</p><p><img src="cid:logo123" alt="logo"></p>', 1500, { seen: true }),
        attachments: [{ partId: '4', blobId: 'blob-logo', name: 'logo.png', type: 'image/png', size: 68, cid: '<logo123>', disposition: 'inline' }] },
      // Other folders.
      { ...mail('w1', 'tw1', person('Jamie Rivers', 'jamie@example.com'), 'Project budget', 'Budget spreadsheet attached for review.', 700, { mailbox: 'mb-work', attach: true }),
        attachments: [{ partId: '3', blobId: 'blob-budget', name: 'budget.csv', type: 'text/csv', size: 28, disposition: 'attachment' }] },
      mail('w2', 'tw2', person('Morgan Lee', 'morgan@example.com'), 'Team lunch photos', 'A few photos from Friday.', 3000, { seen: true, mailbox: 'mb-work' }),
      mail('z1', 'tz1', person('Old Newsletter', 'old@example.com'), 'Old newsletter', 'Last year’s news.', 20000, { seen: true, mailbox: 'mb-trash' }),
      mail('z3', 'tz3', sam, 'Deleted by mistake', 'This one should come back.', 21000, { seen: true, mailbox: 'mb-trash' }),
      mail('z2', 'tz2', person('Prize Desk', 'prize@example.net'), 'You won a prize', 'Claim it now!!!', 900, { mailbox: 'mb-junk' }),
      { ...mail('d1', 'td1', me, 'Draft in folder', 'Half-finished thoughts.', 400, { seen: true, mailbox: 'mb-drafts', to: [sam] }), keywords: { $draft: true, $seen: true } },
      // A two-message conversation in the Inbox (both unread): one row in the list.
      mail('e9', 't9', person('Jamie Rivers', 'jamie@example.com'), 'Project kickoff', 'Kickoff is Monday at 10. Agenda attached.', 240),
      mail('e10', 't9', person('Jamie Rivers', 'jamie@example.com'), 'Re: Project kickoff', 'Small change: we start at 10:30 instead.', 30),
      // Filler so the inbox scrolls like a real one.
      ...FILLER.map(([from, subject, body], i) =>
        mail(`f${i + 1}`, `tf${i + 1}`, person(from, `${from.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`), subject, body, 600 + i * 700, {
          seen: i % 3 !== 0,
          flagged: i === 4,
          attach: i % 5 === 2,
        }),
      ),
    ],
    vacation: { id: 'singleton', isEnabled: false, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null },
    identities: [
      { id: 'id2', name: 'Test User (work)', email: 'work@example.com', textSignature: 'Work signature', htmlSignature: '<p>Work signature</p>', mayDelete: true, showInCompose: true },
      { id: 'id1', name: me.name, email: me.email, textSignature: 'Test User', htmlSignature: '<p>Test User</p>', mayDelete: false, showInCompose: true },
      { id: 'id3', name: 'Hidden alias', email: 'hidden@example.com', mayDelete: true, showInCompose: false },
    ],
    submissions: [],
    contacts: [
      { id: 'c1', uid: 'uid-alex', kind: 'individual', name: { full: 'Alex Example', components: [{ kind: 'given', value: 'Alex' }] }, emails: { e: { address: alex.email } } },
      { id: 'c2', uid: 'uid-sam', kind: 'individual', name: { full: 'Sam Sample', components: [{ kind: 'given', value: 'Sam' }] }, emails: { e: { address: sam.email } } },
      { id: 'g1', uid: 'uid-vips', kind: 'group', name: { full: 'VIPs' }, members: { 'uid-alex': true } },
    ],
    masked: [
      { id: 'm1', email: 'blue.fox1234@example.com', state: 'enabled', forDomain: 'https://shop.example', description: 'Shop', createdAt: ago(60 * 24 * 400), lastMessageAt: ago(60 * 24) },
      { id: 'm2', email: 'quiet.tree5678@example.com', state: 'disabled', forDomain: '', description: 'Old forum', createdAt: ago(60 * 24 * 900) },
    ],
  };
}

/** JSON pointer with `*` over arrays (RFC 8620 §3.7). */
function resolvePath(value, path) {
  const parts = path.split('/').slice(1);
  let cur = [value];
  let spread = false;
  for (const p of parts) {
    if (p === '*') {
      spread = true;
      cur = cur.flatMap((v) => (Array.isArray(v) ? v : []));
    } else cur = cur.map((v) => v?.[p.replace(/~1/g, '/').replace(/~0/g, '~')]);
  }
  return spread ? cur.flat() : cur[0];
}

function applyPatch(obj, patch) {
  for (const [path, v] of Object.entries(patch)) {
    const keys = path.split('/');
    let o = obj;
    for (const k of keys.slice(0, -1)) o = o[k] ??= {};
    const last = keys.at(-1);
    if (v === null) delete o[last];
    else o[last] = v;
  }
}


// --- Files (WebDAV, same Calendar/Files password) -------------------------------------------------
// Paths are decoded, folders end in "/". Hrefs go out percent-encoded per segment, as Fastmail's do.
const FILES_ROOT = '/files/';
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function filesFixtures() {
  const t = Date.parse('2026-10-01T09:00:00Z');
  let n = 0;
  const file = (body, type, ago = 0) => ({ dir: false, body: Buffer.isBuffer(body) ? body : Buffer.from(body), type, etag: `"f${++n}"`, modified: new Date(t - ago * 864e5) });
  const dir = (ago = 0) => ({ dir: true, modified: new Date(t - ago * 864e5) });
  return new Map([
    ['/files/', dir()],
    ['/files/Documents/', dir(2)],
    ['/files/Documents/Résumé 2026.pdf', file('%PDF-1.4\n% fake résumé\n%%EOF\n', 'application/pdf', 3)],
    ['/files/Documents/file2.txt', file('two', 'text/plain', 5)],
    ['/files/Documents/file10.txt', file('ten', 'text/plain', 4)],
    ['/files/Documents/Projects/', dir(1)],
    ['/files/Documents/Projects/plan.md', file('# Plan\n', 'text/markdown', 1)],
    ['/files/Photos/', dir(6)],
    ['/files/Photos/beach.png', file(PNG, 'image/png', 6)],
    ['/files/Photos/logo.svg', file('<svg xmlns="http://www.w3.org/2000/svg"><script>parent.__pwned="svg file"</script></svg>', 'image/svg+xml', 6)],
    ['/files/Empty folder/', dir(9)],
    ['/files/<img src=x onerror=alert(1)>.txt', file('hostile name', 'text/plain', 7)],
    ['/files/readme.txt', file('Hello from Files.\n', 'text/plain', 8)],
  ]);
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const parentOf = (p) => p.replace(/[^/]+\/?$/, '');
const childrenOf = (files, dirPath) => [...files.keys()].filter((k) => k !== dirPath && k.startsWith(dirPath) && !k.slice(dirPath.length).replace(/\/$/, '').includes('/'));

/** Files requests: PROPFIND (depth 0/1), GET, PUT, MKCOL, MOVE, DELETE, with ETags and the usual status codes. */
async function handleFiles(req, res, url, st) {
  const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
  if (basic !== `${DAV_USER}:${DAV_PASSWORD}`) return res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake"' }).end();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  let path = decodeURIComponent(url.pathname);
  const { files } = st;
  // A folder asked for without its slash.
  if (!files.has(path) && files.get(`${path}/`)?.dir) path = `${path}/`;
  const node = files.get(path);
  const xml = (code, payload) => res.writeHead(code, { 'Content-Type': 'application/xml; charset=utf-8' }).end(payload);
  const write = (m) => st.writes.push([m, path]);

  if (req.method === 'PROPFIND') {
    if (!node) return res.writeHead(404).end();
    const depth = req.headers.depth ?? '1';
    const entry = (p) => {
      const n = files.get(p);
      const props = n.dir
        ? '<d:resourcetype><d:collection/></d:resourcetype>'
        : `<d:resourcetype/><d:getcontentlength>${n.body.length}</d:getcontentlength><d:getcontenttype>${n.type}</d:getcontenttype><d:getetag>${xmlEsc(n.etag)}</d:getetag>`;
      const quota = p === FILES_ROOT
        ? `<d:quota-used-bytes>${[...files.values()].reduce((a, f) => a + (f.dir ? 0 : f.body.length), 0)}</d:quota-used-bytes><d:quota-available-bytes>2147483648</d:quota-available-bytes>`
        : '';
      return davResponse(encPath(p), `${props}<d:getlastmodified>${n.modified.toUTCString()}</d:getlastmodified>${quota}`);
    };
    const list = [path, ...(node.dir && depth !== '0' ? childrenOf(files, path) : [])];
    return xml(207, multistatus(list.map(entry)));
  }
  if (req.method === 'GET') {
    if (!node || node.dir) return res.writeHead(node ? 405 : 404).end();
    return res.writeHead(200, { 'Content-Type': node.type, ETag: node.etag, 'Content-Length': node.body.length }).end(node.body);
  }
  if (req.method === 'PUT') {
    if (path.endsWith('/')) return res.writeHead(405).end();
    if (!files.get(parentOf(path))?.dir) return res.writeHead(409).end('no such folder');
    if (req.headers['if-none-match'] === '*' && node) return res.writeHead(412).end('exists');
    if (req.headers['if-match'] && req.headers['if-match'] !== node?.etag) return res.writeHead(412).end('etag mismatch');
    const etag = `"f${Date.now()}${Math.random().toString(36).slice(2, 6)}"`;
    files.set(path, { dir: false, body, type: req.headers['content-type'] || 'application/octet-stream', etag, modified: new Date() });
    write('PUT');
    return res.writeHead(node ? 204 : 201, { ETag: etag }).end();
  }
  if (req.method === 'MKCOL') {
    const dirPath = path.endsWith('/') ? path : `${path}/`;
    if (files.has(dirPath) || files.has(path)) return res.writeHead(405).end('exists');
    if (!files.get(parentOf(dirPath))?.dir) return res.writeHead(409).end('no such folder');
    files.set(dirPath, { dir: true, modified: new Date() });
    write('MKCOL');
    return res.writeHead(201).end();
  }
  if (req.method === 'MOVE' || req.method === 'DELETE') {
    if (!node) return res.writeHead(404).end();
    if (req.method === 'DELETE' && !node.dir && req.headers['if-match'] && req.headers['if-match'] !== node.etag) return res.writeHead(412).end('etag mismatch');
    const moving = [...files.keys()].filter((k) => k === path || (node.dir && k.startsWith(path)));
    if (req.method === 'DELETE') {
      for (const k of moving) files.delete(k);
      write('DELETE');
      return res.writeHead(204).end();
    }
    let dest = decodeURIComponent(new URL(req.headers.destination ?? '', url).pathname);
    if (node.dir && !dest.endsWith('/')) dest += '/';
    if (!dest.startsWith(FILES_ROOT) || !files.get(parentOf(dest))?.dir) return res.writeHead(409).end('bad destination');
    const exists = files.has(dest);
    if (exists && req.headers.overwrite === 'F') return res.writeHead(412).end('exists');
    for (const k of moving) {
      const v = files.get(k);
      files.delete(k);
      files.set(dest + k.slice(path.length), v);
    }
    st.writes.push(['MOVE', path, dest]);
    return res.writeHead(exists ? 204 : 201).end();
  }
  return res.writeHead(405).end();
}

export function startFakeFastmail({ port = 0, log = () => {} } = {}) {
  let data = fixtures();
  let cal = { ...calendarFixtures(), writes: [] };
  let fileStore = { files: filesFixtures(), writes: [] };
  let stateN = 1;
  const streams = new Set();
  /** Every write, for tests to inspect: [method, args]. */
  const writes = [];

  const state = () => `s${stateN}`;
  /** 'ok' (holds work), 'reject' (refused) or 'ignore' (accepted, sent at once). */
  let holdMode = 'ok';
  let arrived = 0;
  function arrive() {
    const [name, email, subject, body] = ARRIVALS[arrived++ % ARRIVALS.length];
    const id = `n${arrived}`;
    data.emails.push({
      id, threadId: `tn${arrived}`, mailboxIds: { 'mb-inbox': true }, keywords: {}, from: [{ name, email }],
      to: [{ name: 'Test User', email: 'test.user@example.com' }], cc: [], subject, receivedAt: new Date().toISOString(),
      preview: body, hasAttachment: false, text: body,
    });
    changed();
  }
  function reset() {
    data = fixtures();
    cal = { ...calendarFixtures(), writes: [] };
    fileStore = { files: filesFixtures(), writes: [] };
    writes.length = 0;
    changed();
  }
  function changed() {
    stateN++;
    const msg = `event: state\ndata: ${JSON.stringify({ '@type': 'StateChange', changed: { [ACCOUNT]: { Email: state(), Mailbox: state(), EmailDelivery: state() } } })}\n\n`;
    for (const res of streams) res.write(msg);
  }

  const matches = (e, f) => {
    if (!f) return true;
    if (f.operator) {
      const r = f.conditions.map((c) => matches(e, c));
      return f.operator === 'AND' ? r.every(Boolean) : f.operator === 'OR' ? r.some(Boolean) : !r.some(Boolean);
    }
    const hay = (s) => (s ?? '').toLowerCase();
    if (f.inMailbox && !e.mailboxIds[f.inMailbox]) return false;
    if (f.inMailboxOtherThan && Object.keys(e.mailboxIds).every((m) => f.inMailboxOtherThan.includes(m))) return false;
    if (f.hasKeyword && !e.keywords[f.hasKeyword]) return false;
    if (f.notKeyword && e.keywords[f.notKeyword]) return false;
    if (f.hasAttachment !== undefined && e.hasAttachment !== f.hasAttachment) return false;
    if (f.from && !e.from.some((a) => hay(`${a.name} ${a.email}`).includes(hay(f.from)))) return false;
    if (f.text) {
      // Like Fastmail: whole words, every word; a trailing * makes a word a prefix.
      const all = [e.subject, e.preview, e.html, e.text, ...e.from.map((a) => `${a.name} ${a.email}`)].map(hay).join(' ');
      const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const words = hay(f.text).split(/\s+/).filter(Boolean);
      if (!words.every((w) => new RegExp(w.endsWith('*') ? `\\b${esc(w.slice(0, -1))}` : `\\b${esc(w)}\\b`).test(all))) return false;
    }
    return true;
  };

  const pick = (obj, props) => (props ? Object.fromEntries([['id', obj.id], ...props.map((p) => [p, obj[p]])]) : obj);

  let base = '';
  function emailOut(e, args) {
    const sub = (v) => (typeof v === 'string' ? v.replaceAll(PWN, `${base}/fake/pwned`) : v);
    e = { ...e, html: sub(e.html), text: sub(e.text) };
    const out = {
      ...e,
      htmlBody: e.html ? [{ partId: '1', type: 'text/html' }] : [{ partId: '1', type: 'text/plain' }],
      textBody: [{ partId: e.html ? '2' : '1', type: 'text/plain' }],
      bodyValues: args.fetchHTMLBodyValues || args.fetchAllBodyValues || args.fetchTextBodyValues ? { 1: { value: e.html ?? e.text }, ...(e.html ? { 2: { value: e.preview } } : {}) } : {},
    };
    delete out.html;
    delete out.text;
    return pick(out, args.properties);
  }

  const methods = {
    'Mailbox/get': (a) => {
      const list = data.mailboxes
        .filter((m) => !a.ids || a.ids.includes(m.id))
        .map((m) => {
          const inBox = data.emails.filter((e) => e.mailboxIds[m.id]);
          return pick({ ...m, totalEmails: inBox.length, unreadEmails: inBox.filter((e) => !e.keywords.$seen).length }, a.properties);
        });
      return { accountId: ACCOUNT, state: state(), list, notFound: [] };
    },
    'Mailbox/query': (a) => ({
      accountId: ACCOUNT,
      ids: data.mailboxes.filter((m) => !a.filter?.role || m.role === a.filter.role).map((m) => m.id),
    }),
    'Email/query': (a) => {
      let all = data.emails.filter((e) => matches(e, a.filter)).sort((x, y) => y.receivedAt.localeCompare(x.receivedAt));
      if (a.collapseThreads) {
        const seen = new Set();
        all = all.filter((e) => !seen.has(e.threadId) && seen.add(e.threadId));
      }
      const ids = all.map((e) => e.id).slice(a.position ?? 0, (a.position ?? 0) + (a.limit ?? 256));
      return { accountId: ACCOUNT, queryState: state(), ids, total: all.length, position: a.position ?? 0 };
    },
    'Email/get': (a) => ({
      accountId: ACCOUNT,
      state: state(),
      list: data.emails.filter((e) => !a.ids || a.ids.includes(e.id)).map((e) => emailOut(e, a)),
      notFound: (a.ids ?? []).filter((id) => !data.emails.some((e) => e.id === id)),
    }),
    'Email/set': (a, ro, creationIds) => {
      const out = { accountId: ACCOUNT, oldState: state(), updated: {}, destroyed: [], created: {}, notUpdated: {}, notDestroyed: {}, notCreated: {} };
      if (ro) {
        for (const id of Object.keys(a.update ?? {})) out.notUpdated[id] = { type: 'forbidden' };
        return out;
      }
      for (const [id, patch] of Object.entries(a.update ?? {})) {
        const e = data.emails.find((x) => x.id === id);
        if (!e) out.notUpdated[id] = { type: 'notFound' };
        else {
          applyPatch(e, patch);
          out.updated[id] = null;
        }
      }
      for (const id of a.destroy ?? []) {
        const i = data.emails.findIndex((x) => x.id === id);
        if (i < 0) out.notDestroyed[id] = { type: 'notFound' };
        else {
          data.emails.splice(i, 1);
          out.destroyed.push(id);
        }
      }
      for (const [cid, e] of Object.entries(a.create ?? {})) {
        const id = `e${100 + data.emails.length}-${cid}`;
        const part = (list) => (list?.[0] ? e.bodyValues?.[list[0].partId]?.value : undefined);
        const html = part(e.htmlBody);
        const text = part(e.textBody) ?? '';
        // A reply joins the conversation of the message it answers.
        const parent = e.inReplyTo?.length ? data.emails.find((x) => x.messageId?.some((m) => e.inReplyTo.includes(m))) : undefined;
        const threadId = parent?.threadId ?? `t-${id}`;
        data.emails.push({
          id, threadId, messageId: [`<${id}@example.com>`], inReplyTo: e.inReplyTo ?? null, references: e.references ?? null,
          mailboxIds: e.mailboxIds ?? {}, keywords: e.keywords ?? {}, from: e.from ?? [], to: e.to ?? [], cc: e.cc ?? [], bcc: e.bcc ?? [],
          subject: e.subject ?? '', receivedAt: new Date().toISOString(), preview: text.slice(0, 120), hasAttachment: Boolean(e.attachments?.length),
          attachments: (e.attachments ?? []).map((a, i) => ({ partId: `a${i}`, ...a })), html, text: html ? undefined : text, textAlt: text,
        });
        creationIds[cid] = id;
        out.created[cid] = { id, threadId, blobId: `b-${id}` };
      }
      if (Object.keys(out.updated).length || out.destroyed.length || Object.keys(out.created).length) changed();
      out.newState = state();
      return out;
    },
    'Thread/get': (a) => ({
      accountId: ACCOUNT,
      state: state(),
      list: [...new Set(a.ids ?? [])].map((id) => ({
        id,
        emailIds: data.emails.filter((e) => e.threadId === id).sort((x, y) => x.receivedAt.localeCompare(y.receivedAt)).map((e) => e.id),
      })),
      notFound: [],
    }),
    'Identity/get': () => ({ accountId: ACCOUNT, state: state(), list: data.identities, notFound: [] }),
    'EmailSubmission/set': (a, ro, creationIds, extra) => {
      const out = { accountId: ACCOUNT, oldState: state(), created: {}, updated: {}, notCreated: {}, notUpdated: {} };
      const subCreated = {};
      for (const [cid, sIn] of Object.entries(a.create ?? {})) {
        const emailId = sIn.emailId?.startsWith('#') ? creationIds[sIn.emailId.slice(1)] : sIn.emailId;
        const email = data.emails.find((e) => e.id === emailId);
        const env = sIn.envelope;
        const params = env?.mailFrom?.parameters;
        const holdFor = params?.HOLDFOR;
        const holdUntil = params?.HOLDUNTIL;
        // Test switch: a server that refuses the hold, or quietly ignores it.
        const delay = holdMode === 'ignore' ? 0 : holdUntil ? (Date.parse(holdUntil) - Date.now()) / 1000 : Number(holdFor ?? 0);
        if (ro) out.notCreated[cid] = { type: 'forbidden' };
        else if (params && holdMode === 'reject') out.notCreated[cid] = { type: 'invalidProperties', description: 'unsupported envelope parameter' };
        else if (!email) out.notCreated[cid] = { type: 'invalidProperties', description: 'emailId not found' };
        else if (!data.identities.some((i) => i.id === sIn.identityId)) out.notCreated[cid] = { type: 'invalidProperties', description: 'identityId' };
        else if (env && !env.rcptTo?.length) out.notCreated[cid] = { type: 'noRecipients', description: 'envelope has no rcptTo' };
        else if (delay > MAX_DELAY) out.notCreated[cid] = { type: 'invalidProperties', description: 'hold longer than maxDelayedSend' };
        else {
          const sendAt = new Date(Date.now() + Math.max(0, delay) * 1000).toISOString();
          const sub = {
            id: `sub${data.submissions.length + 1}`, identityId: sIn.identityId, emailId, threadId: email.threadId,
            envelope: env ?? { mailFrom: { email: email.from[0]?.email }, rcptTo: [...email.to, ...email.cc, ...(email.bcc ?? [])].map((x) => ({ email: x.email })) },
            sendAt, undoStatus: delay > 0 ? 'pending' : 'final',
          };
          data.submissions.push(sub);
          subCreated[cid] = sub;
          out.created[cid] = { id: sub.id, undoStatus: sub.undoStatus, sendAt };
        }
      }
      for (const [id, patch] of Object.entries(a.update ?? {})) {
        const sub = data.submissions.find((x) => x.id === id);
        if (!sub || ro) out.notUpdated[id] = { type: ro ? 'forbidden' : 'notFound' };
        else if (patch.undoStatus === 'canceled' && (sub.undoStatus !== 'pending' || Date.parse(sub.sendAt) <= Date.now()))
          out.notUpdated[id] = { type: 'cannotUnsend', description: 'already sent' };
        else {
          applyPatch(sub, patch);
          out.updated[id] = null;
        }
      }
      // onSuccessUpdateEmail: { "#cid": patch } for each created submission → its email.
      const emailUpdates = {};
      for (const [ref, patch] of Object.entries(a.onSuccessUpdateEmail ?? {})) {
        const sub = subCreated[ref.slice(1)];
        const email = sub && data.emails.find((e) => e.id === sub.emailId);
        if (email) (applyPatch(email, patch), (emailUpdates[email.id] = null));
      }
      if (Object.keys(emailUpdates).length) {
        changed();
        extra.push(['Email/set', { accountId: ACCOUNT, oldState: state(), newState: state(), updated: emailUpdates }]);
      }
      out.newState = state();
      return out;
    },
    'EmailSubmission/get': (a) => ({
      accountId: ACCOUNT,
      state: state(),
      list: data.submissions.filter((x) => !a.ids || a.ids.includes(x.id)).map((x) => {
        if (x.undoStatus === 'pending' && Date.parse(x.sendAt) <= Date.now()) x.undoStatus = 'final';
        return pick(x, a.properties);
      }),
      notFound: [],
    }),
    'ContactCard/query': (a) => {
      const f = a.filter ?? {};
      const ok = (c, cond) =>
        cond.operator === 'OR' ? cond.conditions.some((x) => ok(c, x)) : (!cond.kind || c.kind === cond.kind) && (!cond.uid || c.uid === cond.uid);
      return { accountId: ACCOUNT, ids: data.contacts.filter((c) => ok(c, f)).map((c) => c.id) };
    },
    'ContactCard/get': (a) => ({
      accountId: ACCOUNT,
      state: state(),
      list: data.contacts.filter((c) => !a.ids || a.ids.includes(c.id)).map((c) => pick(c, a.properties)),
      notFound: [],
    }),
    'VacationResponse/get': () => ({ accountId: ACCOUNT, state: state(), list: [data.vacation], notFound: [] }),
    'VacationResponse/set': (a, ro) => {
      if (ro) return { accountId: ACCOUNT, notUpdated: { singleton: { type: 'forbidden' } } };
      Object.assign(data.vacation, a.update?.singleton ?? {});
      return { accountId: ACCOUNT, updated: { singleton: null } };
    },
    'MaskedEmail/get': () => ({ accountId: ACCOUNT, state: state(), list: data.masked, notFound: [] }),
    'MaskedEmail/set': (a, ro) => {
      const out = { accountId: ACCOUNT, created: {}, updated: {}, notCreated: {}, notUpdated: {} };
      for (const [id, patch] of Object.entries(a.update ?? {})) {
        const m = data.masked.find((x) => x.id === id);
        if (!m || ro) out.notUpdated[id] = { type: ro ? 'forbidden' : 'notFound' };
        else {
          Object.assign(m, patch);
          out.updated[id] = null;
        }
      }
      return out;
    },
  };

  const pwned = [];
  /** Uploaded and fixture files: blobId → { type, data }. */
  const blobs = new Map([
    ['blob-notes', { type: 'application/pdf', data: Buffer.from('%PDF-1.4 fake notes\n') }],
    ['blob-budget', { type: 'text/csv', data: Buffer.from('item,cost\nvenue,1200\nfood,300\n') }],
    // A 1×1 PNG.
    ['blob-logo', { type: 'image/png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') }],
  ]);
  /** Blob downloads, for tests. */
  const downloads = [];
  const server = http.createServer(async (req, res) => {
    base = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Depth, If-Match, If-None-Match, Destination, Overwrite');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PROPFIND, REPORT, OPTIONS, MKCOL, MOVE, COPY');
    res.setHeader('Access-Control-Expose-Headers', 'ETag, Location');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const url = new URL(req.url, base);
    if (url.pathname === '/.well-known/caldav' || url.pathname.startsWith('/dav/')) return handleDav(req, res, url, cal).catch((e) => res.writeHead(500).end(String(e)));
    if (url.pathname.startsWith(FILES_ROOT) || url.pathname === '/files') return handleFiles(req, res, url, fileStore).catch((e) => res.writeHead(500).end(String(e)));
    // Security fixture: anything reaching this means a payload got through.
    if (url.pathname.startsWith('/fake/pwned')) {
      pwned.push(req.url);
      return res.writeHead(204).end();
    }
    // Test controls (no auth): make mail arrive, or start over.
    if (url.pathname === '/fake/new' || url.pathname === '/fake/reset') {
      if (url.pathname === '/fake/reset') reset();
      else arrive();
      return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`ok: ${data.emails.length} emails\n`);
    }
    const auth = req.headers.authorization ?? '';
    const token = auth.replace(/^Bearer /, '');
    if (token !== 'fake-token' && token !== 'fake-read-only') return res.writeHead(401).end('Unauthorized');
    const ro = token === 'fake-read-only';
    if (url.pathname.startsWith('/upload/') && req.method === 'POST') {
      if (ro) return res.writeHead(403).end();
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const data = Buffer.concat(chunks);
      const blobId = `blob-up${blobs.size + 1}`;
      const type = req.headers['content-type'] ?? 'application/octet-stream';
      blobs.set(blobId, { type, data });
      return res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ accountId: ACCOUNT, blobId, type, size: data.length }));
    }
    if (url.pathname.startsWith('/download/')) {
      const [, , , blobId] = url.pathname.split('/');
      const blob = blobs.get(decodeURIComponent(blobId ?? ''));
      if (!blob) return res.writeHead(404).end();
      downloads.push(decodeURIComponent(blobId));
      return res.writeHead(200, { 'Content-Type': blob.type, 'Content-Length': blob.data.length }).end(blob.data);
    }

    if (url.pathname === '/jmap/session') {
      const caps = Object.fromEntries(Object.values(CAPS).map((c) => [c, {}]));
      const acctCaps = { ...caps, [CAPS.submission]: { maxDelayedSend: MAX_DELAY, submissionExtensions: {} } };
      caps[CAPS.core] = { maxSizeUpload: 50_000_000 };
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          capabilities: caps,
          accounts: { [ACCOUNT]: { name: 'test.user@example.com', isPersonal: true, isReadOnly: ro, accountCapabilities: acctCaps } },
          primaryAccounts: Object.fromEntries(Object.values(CAPS).filter((c) => c !== CAPS.core).map((c) => [c, ACCOUNT])),
          username: 'test.user@example.com',
          apiUrl: `${base}/jmap/api/`,
          eventSourceUrl: `${base}/jmap/event/?types={types}&closeafter={closeafter}&ping={ping}`,
          downloadUrl: `${base}/download/{accountId}/{blobId}/{name}?type={type}`,
          uploadUrl: `${base}/upload/{accountId}/`,
          state: state(),
        }),
      );
    }
    if (url.pathname === '/jmap/event/') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`event: state\ndata: ${JSON.stringify({ '@type': 'StateChange', changed: { [ACCOUNT]: { Email: state(), Mailbox: state() } } })}\n\n`);
      const ping = setInterval(() => res.write(`event: ping\ndata: {"interval":30}\n\n`), 30_000);
      streams.add(res);
      req.on('close', () => (clearInterval(ping), streams.delete(res)));
      return;
    }
    if (url.pathname === '/jmap/api/' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { methodCalls, using = [] } = JSON.parse(body);
      const responses = [];
      const creationIds = {};
      for (const [name, rawArgs, callId] of methodCalls) {
        // Resolve back-references ("#ids": { resultOf, name, path }).
        const args = {};
        for (const [k, v] of Object.entries(rawArgs)) {
          if (!k.startsWith('#')) args[k] = v;
          else {
            const prev = responses.find((r) => r[2] === v.resultOf && r[0] === v.name);
            args[k.slice(1)] = prev ? resolvePath(prev[1], v.path) : [];
          }
        }
        const fn = methods[name];
        // Like Fastmail: submission methods only exist when the request says it uses them.
        const needs = /^(Identity|EmailSubmission)\//.test(name) ? CAPS.submission : /^VacationResponse\//.test(name) ? CAPS.vacation : undefined;
        if (!fn || (needs && !using.includes(needs))) responses.push(['error', { type: 'unknownMethod' }, callId]);
        else {
          if (/\/set$/.test(name)) writes.push([name, args]);
          log(name, JSON.stringify(args).slice(0, 200));
          const extra = [];
          responses.push([name, fn(args, ro, creationIds, extra), callId]);
          for (const [n, r] of extra) responses.push([n, r, callId]);
        }
      }
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ methodResponses: responses, sessionState: 'x' }));
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        url: `http://127.0.0.1:${p}`,
        port: p,
        writes,
        pwned,
        downloads,
        blobs,
        get data() {
          return data;
        },
        get calendar() {
          return cal;
        },
        get files() {
          return fileStore;
        },
        reset,
        arrive,
        setHoldMode: (m) => (holdMode = m),
        close: () => new Promise((r) => (streams.forEach((s) => s.end()), server.close(r), server.closeAllConnections())),
      });
    }),
  );
}

// Standalone: node scripts/fake-fastmail.mjs [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeFastmail({ port: Number(process.argv[2] ?? 8765), log: (...a) => console.log(...a) });
  console.log(`fake Fastmail on ${fake.url} — tokens: fake-token (read/write), fake-read-only`);
  console.log(`new mail: curl ${fake.url}/fake/new   ·   start over: curl ${fake.url}/fake/reset`);
}
