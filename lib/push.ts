import { AuthError, type Session } from './jmap';

// Mailbox: unread counts; Email: flags/moves; EmailDelivery: only changes when new mail arrives.
const TYPES = ['Email', 'Mailbox', 'EmailDelivery'];
// Fastmail sends pings no more often than every 30s regardless of what we ask for.
const PING_SECONDS = 30;

/**
 * The server ended the stream with an `event: close`. Fastmail allows one event stream per token
 * and closes extra ones ~2s after they open, so reconnecting immediately would just fight.
 */
export class ServerClosedError extends Error {}

export interface PushOptions {
  token: string;
  session: Session;
  onOpen?: () => void;
  onEvent?: (type: string) => void;
  /** A subscribed type changed after the initial snapshot. */
  onChange: () => void;
  /** Stream ended. `err` is undefined if the server closed it cleanly. */
  onClose: (err?: unknown) => void;
}

/**
 * JMAP push over the session's event-source endpoint (RFC 8620 §7.3).
 * EventSource can't send an Authorization header, so the stream is read with fetch.
 */
export function connectPush(o: PushOptions): AbortController {
  const ac = new AbortController();
  const url = o.session
    .eventSourceUrl!.replace('{types}', TYPES.join(','))
    .replace('{closeafter}', 'no')
    .replace('{ping}', String(PING_SECONDS));

  let last: string | undefined;
  let serverClosed = false;
  const handle = (block: string) => {
    let event = 'message';
    let data = '';
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data += value;
    }
    if (event === 'close') serverClosed = true;
    if (!data && event !== 'close') return;
    o.onEvent?.(event);
    if (event !== 'state') return;
    const changed = JSON.parse(data).changed?.[o.session.accountId] ?? {};
    const sig = JSON.stringify(TYPES.map((t) => changed[t]));
    // The first event is a snapshot sent on connect; only later differences are real changes.
    if (last !== undefined && sig !== last) o.onChange();
    last = sig;
  };

  (async () => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${o.token}`, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    if (res.status === 401 || res.status === 403) throw new AuthError(`push: HTTP ${res.status}`);
    if (!res.ok || !res.body) throw new Error(`push: HTTP ${res.status}`);
    o.onOpen?.();
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (serverClosed) throw new ServerClosedError('closed by server (token in use elsewhere?)');
        return;
      }
      buf += value;
      let m: RegExpMatchArray | null;
      while ((m = buf.match(/\r?\n\r?\n/))) {
        handle(buf.slice(0, m.index));
        buf = buf.slice(m.index! + m[0].length);
      }
    }
  })().then(
    () => o.onClose(),
    (e) => o.onClose(e),
  );
  return ac;
}
