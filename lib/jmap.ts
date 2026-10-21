// api.fastmail.com, or the fake server in FAKE_FASTMAIL test builds (wxt.config.ts).
const SESSION_URL = __SESSION_URL__;
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];

/** Bump when Session gains fields, so cached copies get refreshed. */
export const SESSION_VERSION = 8;

export interface Session {
  v?: number;
  apiUrl: string;
  accountId: string;
  /** Login address, e.g. you@fastmail.com. */
  username?: string;
  /** Account holding contacts (VIPs live there); absent if the token lacks contacts access. */
  contactsAccountId?: string;
  /** Scopes the token was given (Fastmail's token settings), whether or not we use them yet. */
  scopes?: { submission: boolean; vacation: boolean; contacts: boolean; masked: boolean };
  /** Blob URLs (attachments) and the upload size limit in bytes. */
  downloadUrl?: string;
  uploadUrl?: string;
  maxSizeUpload?: number;
  /** Seconds the server can hold a sent message (undo / schedule send); 0 if it can't. */
  maxDelayedSend?: number;
  /** "Read-only access" on the token: applies to every scope. */
  readOnly?: boolean;
  /** True when the token can change mail (archive, delete, mark read…). */
  canWriteMail?: boolean;
  /** True when the token can change mail and send it (not read-only, has submission). */
  canSend?: boolean;
  canWriteContacts?: boolean;
  /** Account for Fastmail's Masked Email extension, and whether we may change it. */
  maskedAccountId?: string;
  canWriteMasked?: boolean;
  eventSourceUrl?: string;
}

export interface MailSummary {
  id: string;
  subject: string;
  preview: string;
  receivedAt: string;
  from: string;
  unread: boolean;
  flagged: boolean;
  hasAttachment: boolean;
}

/** Inbox views, after Fastmail's tabs. Pinned = the `$flagged` keyword. */
/** List tabs. 'all' is all mail (any folder but Trash and Spam); the others are within a folder. */
export type View = 'all' | 'inbox' | 'unread' | 'pinned' | 'vips';

export interface InboxState {
  unread: number;
  /** Messages for the selected view. */
  recent: MailSummary[];
  /** Newest unread inbox mail, whatever the view (drives notifications). */
  newestUnread?: MailSummary[];
}

export interface Address {
  name?: string;
  email: string;
}

export interface Attachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
  /** Set for images shown inside an HTML body (cid: references). */
  cid?: string | null;
  disposition?: string | null;
}

export interface FullEmail {
  id: string;
  threadId: string;
  subject: string;
  receivedAt: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  mailboxIds: Record<string, boolean>;
  /** Files attached (not shown inline in the body). */
  attachments?: Attachment[];
  /** Images the HTML body shows inline (cid: references). */
  inline?: Attachment[];
  /** Drafts keep their Bcc (sent messages don't have one). */
  bcc?: Address[];
  keywords?: Record<string, boolean>;
  /** For replies: threading headers and where answers should go. */
  messageId?: string[];
  inReplyTo?: string[];
  references?: string[];
  replyTo?: Address[];
  /** Set when the message has an HTML body; otherwise `text` is. */
  html?: string;
  text?: string;
}

export class AuthError extends Error {}

async function request(token: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 403) throw new AuthError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getSession(token: string): Promise<Session> {
  const s = await request(token, SESSION_URL);
  return {
    v: SESSION_VERSION,
    apiUrl: s.apiUrl,
    username: s.username,
    contactsAccountId: s.primaryAccounts['urn:ietf:params:jmap:contacts'],
    maskedAccountId: s.primaryAccounts['https://www.fastmail.com/dev/maskedemail'],
    canWriteMasked: (() => {
      const acct = s.accounts?.[s.primaryAccounts['https://www.fastmail.com/dev/maskedemail']];
      return Boolean(acct && !acct.isReadOnly);
    })(),
    scopes: {
      submission: Boolean(s.primaryAccounts['urn:ietf:params:jmap:submission']),
      vacation: Boolean(s.primaryAccounts['urn:ietf:params:jmap:vacationresponse']),
      contacts: Boolean(s.primaryAccounts['urn:ietf:params:jmap:contacts']),
      masked: Boolean(s.primaryAccounts['https://www.fastmail.com/dev/maskedemail']),
    },
    readOnly: Object.values<any>(s.accounts ?? {}).every((a) => a.isReadOnly),
    downloadUrl: s.downloadUrl,
    uploadUrl: s.uploadUrl,
    maxSizeUpload: Number(s.capabilities?.['urn:ietf:params:jmap:core']?.maxSizeUpload ?? 0),
    maxDelayedSend: Number(s.accounts?.[s.primaryAccounts['urn:ietf:params:jmap:submission']]?.accountCapabilities?.['urn:ietf:params:jmap:submission']?.maxDelayedSend ?? 0),
    canWriteMail: !s.accounts?.[s.primaryAccounts['urn:ietf:params:jmap:mail']]?.isReadOnly,
    canWriteContacts: (() => {
      const acct = s.accounts?.[s.primaryAccounts['urn:ietf:params:jmap:contacts']];
      return Boolean(acct && !acct.isReadOnly);
    })(),
    canSend: (() => {
      const acct = s.accounts?.[s.primaryAccounts['urn:ietf:params:jmap:mail']];
      return Boolean(acct && !acct.isReadOnly && acct.accountCapabilities?.['urn:ietf:params:jmap:submission']);
    })(),
    accountId: s.primaryAccounts['urn:ietf:params:jmap:mail'],
    eventSourceUrl: s.eventSourceUrl,
  };
}

export async function call(token: string, session: Session, methodCalls: unknown[], using = USING) {
  const r = await request(token, session.apiUrl, { using, methodCalls });
  for (const [name, args] of r.methodResponses) {
    if (name === 'error') throw new Error(`JMAP error: ${args.type}`);
  }
  return r.methodResponses as [string, any, string][];
}

export async function findInboxId(token: string, session: Session): Promise<string> {
  const r = await call(token, session, [
    ['Mailbox/query', { accountId: session.accountId, filter: { role: 'inbox' } }, '0'],
  ]);
  return r[0]![1].ids[0];
}

const SUMMARY_PROPS = ['subject', 'preview', 'receivedAt', 'from', 'keywords', 'hasAttachment'];
const NEWEST = [{ property: 'receivedAt', isAscending: false }];

function summarize(e: any): MailSummary {
  return {
    id: e.id,
    subject: e.subject || '(no subject)',
    preview: e.preview ?? '',
    receivedAt: e.receivedAt,
    from: e.from?.[0]?.name || e.from?.[0]?.email || 'Unknown',
    unread: !e.keywords?.$seen,
    flagged: Boolean(e.keywords?.$flagged),
    hasAttachment: Boolean(e.hasAttachment),
  };
}

/** The JMAP filter for a tab: within `inboxId` (or the folder shown), or for 'all', outside `away` (Trash, Spam). */
export function viewFilter(view: View, inboxId: string, vipEmails: string[], away: string[] = []): Record<string, unknown> {
  if (view === 'all') return away.length ? { inMailboxOtherThan: away } : {};
  const inbox = { inMailbox: inboxId };
  if (view === 'unread') return { ...inbox, notKeyword: '$seen' };
  if (view === 'pinned') return { ...inbox, hasKeyword: '$flagged' };
  if (view === 'vips') {
    return {
      operator: 'AND',
      conditions: [inbox, { operator: 'OR', conditions: vipEmails.map((from) => ({ from })) }],
    };
  }
  return inbox;
}

export async function fetchInbox(
  token: string,
  session: Session,
  inboxId: string,
  { view = 'unread' as View, vipEmails = [] as string[], away = [] as string[], limit = 25 } = {},
): Promise<InboxState> {
  const a = session.accountId;
  const calls: unknown[] = [['Mailbox/get', { accountId: a, ids: [inboxId], properties: ['unreadEmails'] }, 'm']];
  // The list shows conversations (one row per thread, its newest message), like Fastmail; the
  // notification query ('u') stays per message.
  const query = (id: string, filter: unknown, n: number, collapseThreads = id === 'v') => [
    ['Email/query', { accountId: a, filter, sort: NEWEST, limit: n, collapseThreads }, `${id}q`],
    ['Email/get', { accountId: a, '#ids': { resultOf: `${id}q`, name: 'Email/query', path: '/ids' }, properties: SUMMARY_PROPS }, id],
  ];
  // A VIP view with no VIPs would be an empty OR (invalid), so skip the query.
  const viewEmpty = view === 'vips' && vipEmails.length === 0;
  if (!viewEmpty) calls.push(...query('v', viewFilter(view, inboxId, vipEmails, away), limit));
  // Notifications follow unread messages, not conversations, whatever the view.
  calls.push(...query('u', viewFilter('unread', inboxId, []), 10));
  const r = await call(token, session, calls);
  const list = (id: string) => ((r.find((x) => x[2] === id)?.[1].list ?? []) as any[]).map(summarize);
  const recent = viewEmpty ? [] : list('v');
  return {
    unread: r.find((x) => x[2] === 'm')![1].list[0]?.unreadEmails ?? 0,
    recent,
    newestUnread: list('u'),
  };
}

/** Full-text search, newest first: within `scope` (a tab's filter), else across all mail. */
export async function searchEmails(token: string, session: Session, text: string, scope?: Record<string, unknown>, limit = 25): Promise<MailSummary[]> {
  const a = session.accountId;
  const filter = scope && Object.keys(scope).length ? { operator: 'AND', conditions: [{ text }, scope] } : { text };
  const r = await call(token, session, [
    ['Email/query', { accountId: a, filter, sort: NEWEST, limit, collapseThreads: true }, 'q'],
    ['Email/get', { accountId: a, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: SUMMARY_PROPS }, 'g'],
  ]);
  return (r[1]![1].list as any[]).map(summarize);
}

const CONTACTS = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'];

/** Addresses of members of the contact group named "VIPs" (Fastmail's VIP list). */
export async function fetchVipEmails(token: string, session: Session): Promise<string[]> {
  const accountId = session.contactsAccountId;
  if (!accountId) return [];
  const groups = await call(
    token,
    session,
    [
      ['ContactCard/query', { accountId, filter: { kind: 'group' } }, 'q'],
      ['ContactCard/get', { accountId, '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' }, properties: ['name', 'members'] }, 'g'],
    ],
    CONTACTS,
  );
  const vip = (groups[1]![1].list as any[]).find((g) => /^\s*vips?\s*$/i.test(g.name?.full ?? ''));
  // JSContact group members are keyed by the member card's `uid`, not its JMAP id.
  const uids = Object.keys(vip?.members ?? {});
  if (!uids.length) return [];
  const cards = await call(
    token,
    session,
    [
      ['ContactCard/query', { accountId, filter: { operator: 'OR', conditions: uids.map((uid) => ({ uid })) } }, 'q'],
      ['ContactCard/get', { accountId, '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' }, properties: ['emails'] }, 'c'],
    ],
    CONTACTS,
  );
  return (cards[1]![1].list as any[]).flatMap((c) => Object.values(c.emails ?? {}).map((e: any) => e.address)).filter(Boolean);
}

/** Change messages: { id: patch } (JMAP PatchObject). Needs a token with write access. */
export async function updateEmails(token: string, session: Session, update: Record<string, Record<string, unknown>>) {
  const r = await call(token, session, [['Email/set', { accountId: session.accountId, update }, '0']]);
  const notUpdated = r[0]![1].notUpdated as Record<string, { type: string; description?: string }> | undefined;
  const fail = notUpdated && Object.values(notUpdated)[0];
  if (fail) throw new Error(fail.description ?? fail.type);
}

/** Mark messages read (or unread again). */
export async function setSeen(token: string, session: Session, ids: string[], seen: boolean) {
  await updateEmails(token, session, Object.fromEntries(ids.map((id) => [id, { 'keywords/$seen': seen ? true : null }])));
}

export type MailboxRole = 'inbox' | 'archive' | 'trash' | 'junk' | 'drafts' | 'sent';

export interface Mailbox {
  id: string;
  name: string;
  role?: MailboxRole | null;
  parentId?: string | null;
  sortOrder?: number;
  unreadEmails: number;
  totalEmails: number;
  /** Depth under its parents, for indenting. */
  depth: number;
}

const ROLE_ORDER: MailboxRole[] = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

/** Every folder/label: the standard ones first (Fastmail's order), then the rest as a tree. */
export async function mailboxList(token: string, session: Session): Promise<Mailbox[]> {
  const r = await call(token, session, [
    ['Mailbox/get', { accountId: session.accountId, properties: ['name', 'role', 'parentId', 'sortOrder', 'unreadEmails', 'totalEmails'] }, 'm'],
  ]);
  const all = r[0]![1].list as Omit<Mailbox, 'depth'>[];
  const byOrder = (a: Omit<Mailbox, 'depth'>, b: Omit<Mailbox, 'depth'>) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name);
  const standard = ROLE_ORDER.map((role) => all.find((m) => m.role === role)).filter((m): m is Omit<Mailbox, 'depth'> => Boolean(m));
  const out: Mailbox[] = standard.map((m) => ({ ...m, depth: 0 }));
  const rest = all.filter((m) => !standard.includes(m));
  const walk = (parent: string | null, depth: number) => {
    for (const m of rest.filter((x) => (x.parentId ?? null) === parent && !standard.some((s) => s.id === x.parentId)).sort(byOrder)) {
      out.push({ ...m, depth });
      walk(m.id, depth + 1);
    }
  };
  walk(null, 0);
  // Children of standard folders (e.g. under Inbox) still show, one level in.
  for (const m of rest.filter((x) => standard.some((s) => s.id === x.parentId)).sort(byOrder)) out.push({ ...m, depth: 1 });
  return out;
}

/** Delete messages for good (from Trash or Spam). */
export async function destroyEmails(token: string, session: Session, ids: string[]) {
  const r = await call(token, session, [['Email/set', { accountId: session.accountId, destroy: ids }, 'x']]);
  const fail = Object.values((r[0]![1].notDestroyed ?? {}) as Record<string, { type: string; description?: string }>)[0];
  if (fail) throw new Error(fail.description ?? fail.type);
}

/** Mailbox ids by role (Inbox, Archive, Trash, Spam…). */
export async function mailboxRoles(token: string, session: Session): Promise<Partial<Record<MailboxRole, string>>> {
  const r = await call(token, session, [['Mailbox/get', { accountId: session.accountId, properties: ['role'] }, 'm']]);
  return Object.fromEntries((r[0]![1].list as { id: string; role?: string }[]).filter((m) => m.role).map((m) => [m.role, m.id]));
}

export interface EmailFlags {
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
}


/** One message of a conversation, enough for its collapsed row. */
export interface ThreadMessage {
  id: string;
  from: Address[];
  receivedAt: string;
  preview: string;
  unread: boolean;
  mailboxIds: Record<string, boolean>;
}

/** A conversation's messages, oldest first. */
export async function fetchThread(token: string, session: Session, threadId: string): Promise<ThreadMessage[]> {
  const a = session.accountId;
  const r = await call(token, session, [
    ['Thread/get', { accountId: a, ids: [threadId] }, 't'],
    [
      'Email/get',
      {
        accountId: a,
        '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' },
        properties: ['from', 'receivedAt', 'preview', 'keywords', 'mailboxIds'],
      },
      'g',
    ],
  ]);
  return (r[1]![1].list as any[])
    .map((e) => ({ id: e.id, from: e.from ?? [], receivedAt: e.receivedAt, preview: e.preview ?? '', unread: !e.keywords?.$seen, mailboxIds: e.mailboxIds ?? {} }))
    .sort((x, y) => x.receivedAt.localeCompare(y.receivedAt));
}

/** Every message in the conversations of `ids`, with where they are and their keywords. */
export async function conversationFlags(token: string, session: Session, ids: string[]): Promise<Record<string, EmailFlags>> {
  const a = session.accountId;
  const r = await call(token, session, [
    ['Email/get', { accountId: a, ids, properties: ['threadId'] }, 'e'],
    ['Thread/get', { accountId: a, '#ids': { resultOf: 'e', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
    ['Email/get', { accountId: a, '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['mailboxIds', 'keywords'] }, 'g'],
  ]);
  return Object.fromEntries((r[2]![1].list as (EmailFlags & { id: string })[]).map((e) => [e.id, { mailboxIds: e.mailboxIds, keywords: e.keywords }]));
}

/** Download an attachment (the API needs the token, so not a plain link). */
export async function downloadBlob(token: string, session: Session, a: Attachment): Promise<Blob> {
  if (!session.downloadUrl) throw new Error('Downloads aren’t available');
  const url = session.downloadUrl
    .replace('{accountId}', encodeURIComponent(session.accountId))
    .replace('{blobId}', encodeURIComponent(a.blobId))
    .replace('{name}', encodeURIComponent(a.name))
    .replace('{type}', encodeURIComponent(a.type));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** Upload a file; returns the blob to attach. */
export async function uploadBlob(token: string, session: Session, file: File): Promise<Attachment> {
  if (!session.uploadUrl) throw new Error('Uploads aren’t available');
  const res = await fetch(session.uploadUrl.replace('{accountId}', encodeURIComponent(session.accountId)), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
  const r = await res.json();
  return { blobId: r.blobId, name: file.name, type: r.type || file.type || 'application/octet-stream', size: r.size ?? file.size };
}

const VACATION = 'urn:ietf:params:jmap:vacationresponse';

export interface Vacation {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string | null;
  textBody: string | null;
}

/** The out-of-office auto-reply (needs the token's Vacation response scope). */
export async function getVacation(token: string, session: Session): Promise<Vacation> {
  const r = await call(token, session, [['VacationResponse/get', { accountId: session.accountId, ids: ['singleton'] }, 'v']], [
    'urn:ietf:params:jmap:core',
    VACATION,
  ]);
  const v = r[0]![1].list[0] ?? {};
  return { isEnabled: Boolean(v.isEnabled), fromDate: v.fromDate ?? null, toDate: v.toDate ?? null, subject: v.subject ?? null, textBody: v.textBody ?? null };
}

export async function setVacation(token: string, session: Session, patch: Partial<Vacation>) {
  const r = await call(token, session, [['VacationResponse/set', { accountId: session.accountId, update: { singleton: patch } }, 'v']], [
    'urn:ietf:params:jmap:core',
    VACATION,
  ]);
  const fail = r[0]![1].notUpdated?.singleton;
  if (fail) throw new Error(fail.description ?? fail.type);
}

export async function fetchEmail(token: string, session: Session, id: string): Promise<FullEmail> {
  const r = await call(token, session, [
    [
      'Email/get',
      {
        accountId: session.accountId,
        ids: [id],
        properties: [
          'threadId', 'subject', 'receivedAt', 'from', 'to', 'cc', 'bcc', 'replyTo', 'mailboxIds', 'keywords', 'messageId', 'references',
          'inReplyTo', 'htmlBody', 'bodyValues', 'attachments',
        ],
        // htmlBody falls back to text/plain parts when there is no HTML alternative.
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: 2_000_000,
      },
      'e',
    ],
  ]);
  const e = r[0]![1].list[0];
  if (!e) throw new Error('Message not found');
  const parts = (e.htmlBody ?? []) as { partId: string; type: string }[];
  const value = (p: { partId: string }) => e.bodyValues?.[p.partId]?.value ?? '';
  const htmlParts = parts.filter((p) => p.type === 'text/html');
  return {
    id: e.id,
    threadId: e.threadId,
    subject: e.subject || '(no subject)',
    receivedAt: e.receivedAt,
    from: e.from ?? [],
    to: e.to ?? [],
    cc: e.cc ?? [],
    mailboxIds: e.mailboxIds ?? {},
    bcc: e.bcc ?? undefined,
    // Real attachments, not images the HTML body shows inline.
    attachments: ((e.attachments ?? []) as any[])
      .filter((a) => a.blobId && (a.disposition === 'attachment' || !a.cid))
      .map((a) => ({ blobId: a.blobId, name: a.name || 'attachment', type: a.type || 'application/octet-stream', size: a.size ?? 0, cid: a.cid, disposition: a.disposition })),
    inline: ((e.attachments ?? []) as any[])
      .filter((a) => a.blobId && a.cid && a.disposition !== 'attachment' && /^image\//.test(a.type ?? ''))
      .map((a) => ({ blobId: a.blobId, name: a.name || 'image', type: a.type, size: a.size ?? 0, cid: a.cid })),
    keywords: e.keywords ?? undefined,
    inReplyTo: e.inReplyTo ?? undefined,
    messageId: e.messageId ?? undefined,
    references: e.references ?? undefined,
    replyTo: e.replyTo ?? undefined,
    ...(htmlParts.length
      ? { html: htmlParts.map(value).join('\n') }
      : { text: parts.filter((p) => p.type.startsWith('text/')).map(value).join('\n\n') }),
  };
}
