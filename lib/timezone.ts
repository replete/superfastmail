// A VTIMEZONE for the browser's time zone, built from the browser's own zone data (Intl), so events
// can be written in local time. Fastmail's CalDAV doesn't take time zones by reference (RFC 7809),
// so each object has to carry the definition of the zone it uses.

/** Minutes east of UTC in `zone` at instant `t`. */
function offsetAt(zone: string, t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(t));
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'));
  return Math.round((wall - Math.floor(t / 60000) * 60000) / 60000);
}

/** The instants in `year` where the offset changes (to the minute). */
function transitions(zone: string, year: number): number[] {
  const out: number[] = [];
  const DAY = 864e5;
  let t = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  while (t < end) {
    if (offsetAt(zone, t) !== offsetAt(zone, t + DAY)) {
      let [lo, hi] = [t, t + DAY];
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
        if (offsetAt(zone, mid) === offsetAt(zone, lo)) lo = mid;
        else hi = mid;
      }
      out.push(hi);
    }
    t += DAY;
  }
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const fmtOffset = (min: number) => `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}${pad(Math.abs(min) % 60)}`;
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** The date in `year` of the `nth` (1–4, or -1 = last) `weekday` of `month` (1–12). */
function nthWeekday(year: number, month: number, weekday: number, nth: number): number {
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  }
  const lastDate = new Date(Date.UTC(year, month, 0));
  return lastDate.getUTCDate() - ((lastDate.getUTCDay() - weekday + 7) % 7);
}

/** One observance (the yearly rule for a change of offset at instant `t`). */
function observance(zone: string, t: number): string {
  const from = offsetAt(zone, t - 60000);
  const to = offsetAt(zone, t);
  // The wall-clock time of the change, in the offset before it.
  const w = new Date(t + from * 60000);
  const month = w.getUTCMonth() + 1;
  const day = w.getUTCDate();
  const daysInMonth = new Date(Date.UTC(w.getUTCFullYear(), month, 0)).getUTCDate();
  const nth = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7);
  const weekday = w.getUTCDay();
  // Rules start in 1970, on the 1970 date the same rule gives.
  const start = `1970${pad(month)}${pad(nthWeekday(1970, month, weekday, nth))}T${pad(w.getUTCHours())}${pad(w.getUTCMinutes())}00`;
  const kind = to > from ? 'DAYLIGHT' : 'STANDARD';
  return [
    `BEGIN:${kind}`,
    `TZOFFSETFROM:${fmtOffset(from)}`,
    `TZOFFSETTO:${fmtOffset(to)}`,
    `DTSTART:${start}`,
    `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${nth}${DAYS[weekday]}`,
    `END:${kind}`,
  ].join('\r\n');
}

/**
 * The browser's zone and a VTIMEZONE for it, or undefined when its rules don't fit a simple yearly
 * pattern (then write UTC instead). Zones without daylight saving get a single fixed offset.
 */
export function localTimezone(now = new Date()): { tzid: string; vtimezone: string } | undefined {
  const tzid = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!tzid || tzid === 'UTC' || tzid === 'Etc/UTC') return undefined;
  const year = now.getFullYear();
  const list = transitions(tzid, year);
  let body: string;
  if (!list.length) {
    const off = fmtOffset(offsetAt(tzid, now.getTime()));
    body = ['BEGIN:STANDARD', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, 'DTSTART:19700101T000000', 'END:STANDARD'].join('\r\n');
  } else if (list.length === 2) {
    body = list.map((t) => observance(tzid, t)).join('\r\n');
    // Only if the same yearly rules hold next year too (not, say, Morocco's Ramadan changes).
    const next = transitions(tzid, year + 1);
    if (next.length !== 2 || next.map((t) => observance(tzid, t)).join('\r\n') !== body) return undefined;
  } else return undefined;
  return { tzid, vtimezone: `BEGIN:VTIMEZONE\r\nTZID:${tzid}\r\n${body}\r\nEND:VTIMEZONE` };
}
