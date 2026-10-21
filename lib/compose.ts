// Writing mail: identities, drafts, sending with undo (a server-side hold), replies and forwards.
//
// Undo send: the submission is created with a FUTURERELEASE hold (HOLDFOR / HOLDUNTIL on the envelope;
// Fastmail advertises `maxDelayedSend`). Undo is offered only when the server confirms the hold
// (`undoStatus: pending` and `sendAt` in the future), and cancelling puts the message back in Drafts
// (onSuccessUpdateEmail already moved it to Sent when the submission was created).
// Bcc is never written into the message's headers: those recipients go on the envelope only.
import { escapeHtml, sanitizeForEditor } from './email-view';
import { call, type Address, type Attachment, type FullEmail, type MailboxRole, type Session } from './jmap';

const SUBMISSION = 'urn:ietf:params:jmap:submission';
const USING_SEND = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', SUBMISSION];

export interface Identity {
  id: string;
  name: string;
  email: string;
  textSignature?: string;
  htmlSignature?: string;
  /** The account's own address can't be deleted: Fastmail's default From. */
  mayDelete?: boolean;
  /** Fastmail: whether it's offered in compose. */
  showInCompose?: boolean;
  /** Fastmail: where this identity's sent mail is filed. */
  saveSentToMailboxId?: string | null;
}

export interface Draft {
  identityId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** Editor HTML (already sanitised). */
  html: string;
  /** Threading, for replies and forwards. */
  inReplyTo?: string[];
  references?: string[];
  /** Uploaded (or forwarded) files. */
  attachments?: Attachment[];
}

type Roles = Partial<Record<MailboxRole, string>>;

/** The identities offered in compose, the default (the account's own) first. */
export async function getIdentities(token: string, session: Session): Promise<Identity[]> {
  const r = await call(token, session, [['Identity/get', { accountId: session.accountId, ids: null }, 'i']], USING_SEND);
  return (r[0]![1].list as Identity[])
    .filter((i) => i.email && i.showInCompose !== false)
    .sort((a, b) => Number(a.mayDelete !== false) - Number(b.mayDelete !== false));
}

/** Plain-text alternative of the editor HTML (quotes become "> " lines, links "text <url>"). */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  const walk = (node: Node, quote: number) => {
    if (node.nodeType === Node.TEXT_NODE) return void out.push(node.textContent!.replace(/\s+/g, ' '));
    if (!(node instanceof Element)) return;
    const tag = node.tagName;
    if (tag === 'BR') return void out.push('\n' + '> '.repeat(quote));
    const block = /^(P|DIV|LI|H[1-6]|PRE|TR|BLOCKQUOTE|UL|OL|TABLE)$/.test(tag);
    if (block) out.push('\n' + '> '.repeat(quote));
    if (tag === 'LI') out.push('• ');
    for (const child of node.childNodes) walk(child, quote + (tag === 'BLOCKQUOTE' ? 1 : 0));
    if (tag === 'A') {
      const href = node.getAttribute('href');
      if (href && href !== node.textContent?.trim()) out.push(` <${href}>`);
    }
    if (block) out.push('\n' + '> '.repeat(quote));
  };
  walk(doc.body, 0);
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The Email/set create object. `forSending` leaves Bcc out of the headers. */
function emailObject(d: Draft, identity: Identity, roles: Roles, forSending: boolean) {
  if (!roles.drafts) throw new Error('No Drafts folder');
  return {
    mailboxIds: { [roles.drafts]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: identity.name, email: identity.email }],
    to: d.to,
    cc: d.cc,
    ...(forSending || !d.bcc.length ? {} : { bcc: d.bcc }),
    subject: d.subject,
    ...(d.inReplyTo?.length ? { inReplyTo: d.inReplyTo } : {}),
    ...(d.references?.length ? { references: d.references } : {}),
    htmlBody: [{ partId: 'html', type: 'text/html' }],
    textBody: [{ partId: 'text', type: 'text/plain' }],
    bodyValues: { html: { value: d.html }, text: { value: htmlToText(d.html) } },
    ...(d.attachments?.length
      ? { attachments: d.attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, size: a.size, disposition: 'attachment' })) }
      : {}),
  };
}

function failure(res: any, key: string, id: string) {
  const f = res?.[key]?.[id];
  return f ? new Error(f.description ?? f.type) : undefined;
}

/** Save (replace) the server draft; drafts are immutable in JMAP, so it's create-new + destroy-old. */
export async function saveDraft(token: string, session: Session, d: Draft, identity: Identity, roles: Roles, oldId?: string): Promise<string> {
  const r = await call(token, session, [
    ['Email/set', { accountId: session.accountId, create: { d: emailObject(d, identity, roles, false) }, ...(oldId ? { destroy: [oldId] } : {}) }, 'd'],
  ]);
  const res = r[0]![1];
  const err = failure(res, 'notCreated', 'd');
  if (err) throw err;
  return res.created.d.id;
}

export async function discardDraft(token: string, session: Session, id: string) {
  await call(token, session, [['Email/set', { accountId: session.accountId, destroy: [id] }, 'x']]);
}

export interface Sent {
  emailId: string;
  submissionId: string;
  /** The server confirmed a hold: Undo can stop it until `sendAt`. */
  undoable: boolean;
  sendAt?: string;
}

/** A send that failed: the message it created is now the draft (`draftId`), so a retry can't pile up copies. */
export class SendError extends Error {
  constructor(
    message: string,
    readonly draftId?: string,
  ) {
    super(message);
  }
}

/**
 * Send `d` (its final content). `holdFor` seconds gives Undo a window; `holdUntil` schedules it.
 * Two requests: create the message (as a draft), then submit it — so if submitting fails, the
 * created message is still there and becomes the draft. If the server refuses the hold, it's sent
 * once more without one (no Undo then). The previous draft is removed either way.
 */
export async function sendMessage(
  token: string,
  session: Session,
  d: Draft,
  identity: Identity,
  roles: Roles,
  { oldDraftId, holdFor = 10, holdUntil }: { oldDraftId?: string; holdFor?: number; holdUntil?: Date } = {},
): Promise<Sent> {
  const sentBox = identity.saveSentToMailboxId || roles.sent;
  if (!sentBox || !roles.drafts) throw new Error('No Sent or Drafts folder');
  const rcptTo = [...d.to, ...d.cc, ...d.bcc].map((a) => ({ email: a.email }));
  if (!rcptTo.length) throw new Error('Add a recipient');
  const a = session.accountId;
  const created = await call(token, session, [['Email/set', { accountId: a, create: { c: emailObject(d, identity, roles, true) } }, 'e']]);
  const createErr = failure(created[0]![1], 'notCreated', 'c');
  if (createErr) throw createErr;
  const emailId: string = created[0]![1].created.c.id;
  const dropOld = () =>
    oldDraftId ? call(token, session, [['Email/set', { accountId: a, destroy: [oldDraftId] }, 'x']]).catch(() => {}) : Promise.resolve();

  const submit = async (parameters?: Record<string, string>) => {
    const r = await call(
      token,
      session,
      [
        [
          'EmailSubmission/set',
          {
            accountId: a,
            create: { s: { identityId: identity.id, emailId, envelope: { mailFrom: { email: identity.email, ...(parameters ? { parameters } : {}) }, rcptTo } } },
            onSuccessUpdateEmail: { '#s': { [`mailboxIds/${roles.drafts}`]: null, [`mailboxIds/${sentBox}`]: true, 'keywords/$draft': null } },
          },
          's',
        ],
      ],
      USING_SEND,
    );
    const sub = r.find((x) => x[0] === 'EmailSubmission/set')![1];
    const err = failure(sub, 'notCreated', 's');
    return err ? { err } : { created: sub.created.s as { id: string; undoStatus?: string; sendAt?: string } };
  };

  const hold: Record<string, string> | undefined = holdUntil
    ? { HOLDUNTIL: holdUntil.toISOString() }
    : holdFor > 0
      ? { HOLDFOR: String(holdFor) }
      : undefined;
  let result: Awaited<ReturnType<typeof submit>>;
  try {
    result = await submit(hold);
    if (result.err && hold) result = await submit(); // the hold was refused: send without it
  } catch (e) {
    result = { err: e as Error };
  }
  await dropOld();
  if (result.err) throw new SendError(result.err.message, emailId);
  let { id: submissionId, undoStatus, sendAt } = result.created!;
  if (undoStatus === undefined || sendAt === undefined) {
    // Not echoed back: ask for them.
    const g = await call(token, session, [['EmailSubmission/get', { accountId: a, ids: [submissionId], properties: ['undoStatus', 'sendAt'] }, 'g']], USING_SEND);
    ({ undoStatus, sendAt } = g[0]![1].list[0] ?? {});
  }
  const undoable = undoStatus === 'pending' && Boolean(sendAt) && Date.parse(sendAt!) > Date.now() + 500;
  return { emailId, submissionId, undoable, sendAt };
}

export class AlreadySent extends Error {}

/** Undo: cancel the held submission and put the message back in Drafts. */
export async function cancelSend(token: string, session: Session, sent: Sent, roles: Roles) {
  const r = await call(
    token,
    session,
    [['EmailSubmission/set', { accountId: session.accountId, update: { [sent.submissionId]: { undoStatus: 'canceled' } } }, 'u']],
    USING_SEND,
  );
  if (r[0]![1].notUpdated?.[sent.submissionId]) throw new AlreadySent('Already sent');
  await call(token, session, [
    ['Email/set', { accountId: session.accountId, update: { [sent.emailId]: { mailboxIds: { [roles.drafts!]: true }, keywords: { $draft: true, $seen: true } } } }, 'r'],
  ]);
}

// --- Replies and forwards -------------------------------------------------------------------------

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

const fmtAddr = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);
const sameAddr = (a: Address, b: Address) => a.email.toLowerCase() === b.email.toLowerCase();

/** The identity to write from: the one a replied-to message was sent to, else the default. */
export function identityFor(original: FullEmail | undefined, identities: Identity[]): Identity | undefined {
  const to = [...(original?.to ?? []), ...(original?.cc ?? [])];
  return identities.find((i) => to.some((a) => sameAddr(a, i))) ?? identities.find((i) => i.mayDelete === false) ?? identities[0];
}

/** The identity's signature, as editor HTML (empty if it has none). */
export function signatureInner(identity: Identity | undefined) {
  if (identity?.htmlSignature) return sanitizeForEditor(identity.htmlSignature);
  if (identity?.textSignature) return escapeHtml(identity.textSignature).replace(/\n/g, '<br>');
  return '';
}

function signatureHtml(identity: Identity | undefined) {
  const inner = signatureInner(identity);
  return inner ? `<div class="sig">${inner}</div>` : '';
}

/** The original, as safe editor HTML. */
function originalHtml(o: FullEmail) {
  return o.html ? sanitizeForEditor(o.html) : `<div>${escapeHtml(o.text ?? '').replace(/\n/g, '<br>')}</div>`;
}

/** A new draft: blank, or a reply / reply all / forward of `original`. */
export function startDraft(mode: ComposeMode, identities: Identity[], original?: FullEmail): Draft {
  const identity = identityFor(original, identities);
  const sig = signatureHtml(identity);
  const blank: Draft = { identityId: identity?.id ?? '', to: [], cc: [], bcc: [], subject: '', html: `<p><br></p>${sig}` };
  if (mode === 'new' || !original) return blank;
  const date = new Date(original.receivedAt).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
  const sender = original.from[0];
  const threading = {
    inReplyTo: original.messageId,
    references: [...(original.references ?? []), ...(original.messageId ?? [])],
  };
  if (mode === 'forward') {
    return {
      ...blank,
      attachments: original.attachments ?? [],
      subject: /^fwd?:/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`,
      ...threading,
      html:
        `<p><br></p>${sig}<p>---------- Forwarded message ----------<br>From: ${escapeHtml(sender ? fmtAddr(sender) : '')}<br>` +
        `Date: ${escapeHtml(date)}<br>Subject: ${escapeHtml(original.subject)}<br>To: ${escapeHtml(original.to.map(fmtAddr).join(', '))}</p>` +
        originalHtml(original),
    };
  }
  const mine = (a: Address) => identities.some((i) => sameAddr(a, i));
  const replyTo = original.replyTo?.length ? original.replyTo : original.from;
  const to = replyTo.filter((a) => !mine(a));
  const others =
    mode === 'replyAll' ? [...original.to, ...original.cc].filter((a) => !mine(a) && !to.some((t) => sameAddr(t, a))) : [];
  const dedupe = (list: Address[]) => list.filter((a, i) => list.findIndex((b) => sameAddr(a, b)) === i);
  return {
    ...blank,
    // Replying to your own message: send to its recipients instead.
    to: to.length ? to : dedupe(original.to.filter((a) => !mine(a))),
    cc: dedupe(others),
    subject: /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`,
    ...threading,
    html: `<p><br></p>${sig}<p>On ${escapeHtml(date)}, ${escapeHtml(sender ? fmtAddr(sender) : 'someone')} wrote:</p><blockquote type="cite">${originalHtml(original)}</blockquote>`,
  };
}

/** Schedule-send choices, after Fastmail's: [label, when, unavailable]. */
export function scheduleChoices(now = new Date()): [string, Date, boolean][] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const later = new Date(Math.ceil((now.getTime() + 3 * 3600e3) / 900e3) * 900e3); // in about 3 hours
  const untilSat = (6 - now.getDay() + 7) % 7 || 7;
  const untilMon = (1 - now.getDay() + 7) % 7 || 7;
  const evening = at(0, 18);
  return [
    ['Later', later, false],
    ['This evening', evening, evening <= now],
    ['Tomorrow', at(1, 8), false],
    [now.getDay() === 6 || now.getDay() === 0 ? 'Next weekend' : 'This weekend', at(untilSat, 8), false],
    ['Next week', at(untilMon, 8), false],
  ];
}

/** "Sat 08:00", or just "18:00" for today. */
export function whenLabel(d: Date, now = new Date()) {
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** "Name <a@b>", "a@b", or several separated by , ; or newlines → addresses (invalid ones flagged). */
export function parseAddresses(input: string): (Address & { invalid?: boolean })[] {
  return input
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.*?)\s*<([^>]+)>$/);
      const name = m ? m[1]!.replace(/^"|"$/g, '').trim() : undefined;
      const email = (m ? m[2]! : part).trim();
      return { ...(name ? { name } : {}), email, ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? {} : { invalid: true }) };
    });
}
