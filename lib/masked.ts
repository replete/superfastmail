import { call, type Session } from './jmap';

// Fastmail Masked Email (https://www.fastmail.com/dev/ — a Fastmail JMAP extension).
export const MASKED_CAP = 'https://www.fastmail.com/dev/maskedemail';
const USING = ['urn:ietf:params:jmap:core', MASKED_CAP];

export interface Masked {
  id: string;
  email: string;
  state: 'pending' | 'enabled' | 'disabled' | 'deleted';
  /** Origin of the site it was made for, e.g. "https://example.com". */
  forDomain?: string;
  description?: string;
  createdAt?: string;
  /** Client that created it, e.g. a password manager. */
  createdBy?: string;
  lastMessageAt?: string;
}

function accountId(session: Session) {
  if (!session.maskedAccountId) throw new Error('This token has no Masked Email access');
  return session.maskedAccountId;
}

/** All masked addresses except deleted ones, most recently used first. */
export async function listMasked(token: string, session: Session): Promise<Masked[]> {
  const r = await call(token, session, [['MaskedEmail/get', { accountId: accountId(session), ids: null }, 'g']], USING);
  const used = (m: Masked) => m.lastMessageAt ?? m.createdAt ?? '';
  return (r[0]![1].list as Masked[]).filter((m) => m.state !== 'deleted').sort((a, b) => used(b).localeCompare(used(a)));
}

/** Create an enabled masked address (needs a token with write access). */
export async function createMasked(
  token: string,
  session: Session,
  fields: { forDomain?: string; description?: string },
): Promise<Masked> {
  const r = await call(
    token,
    session,
    [['MaskedEmail/set', { accountId: accountId(session), create: { new: { state: 'enabled', ...fields } } }, 's']],
    USING,
  );
  const res = r[0]![1];
  if (!res.created?.new) throw new Error(res.notCreated?.new?.description ?? res.notCreated?.new?.type ?? 'Not created');
  return { state: 'enabled', ...fields, ...res.created.new } as Masked;
}

export function maskedLabel(m: Masked) {
  return m.description || (m.forDomain ? (URL.parse(m.forDomain)?.host ?? m.forDomain) : '') || '(no description)';
}

export function matchMasked(m: Masked, q: string): boolean {
  const needle = q.toLowerCase();
  return [m.email, m.description, m.forDomain, m.createdBy].some((v) => v?.toLowerCase().includes(needle));
}

/** Enable, disable or delete a masked address (needs a token with write access). */
export async function setMaskedState(token: string, session: Session, id: string, state: Masked['state']) {
  const r = await call(token, session, [['MaskedEmail/set', { accountId: accountId(session), update: { [id]: { state } } }, 's']], USING);
  const res = r[0]![1];
  if (res.notUpdated?.[id]) throw new Error(res.notUpdated[id].description ?? res.notUpdated[id].type);
}
