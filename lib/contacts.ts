import { call, type Session } from './jmap';

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'];

export interface Labelled {
  value: string;
  label?: string;
}

/** A JSContact card flattened for display. */
export interface Contact {
  id: string;
  name: string;
  nickname?: string;
  org?: string;
  title?: string;
  emails: Labelled[];
  phones: Labelled[];
  addresses: Labelled[];
  links: Labelled[];
  birthday?: string;
  notes?: string;
}

const values = (map: Record<string, any> | undefined) => Object.values(map ?? {});

function label(contexts?: Record<string, boolean>, features?: Record<string, boolean>, own?: string) {
  if (own) return own;
  if (features?.mobile) return 'Mobile';
  if (features?.fax) return 'Fax';
  if (contexts?.work) return 'Work';
  if (contexts?.private) return 'Home';
  return undefined;
}

function address(a: any): string {
  if (a.full) return a.full;
  if (Array.isArray(a.components)) {
    return a.components
      .filter((c: any) => c.kind !== 'separator')
      .map((c: any) => c.value)
      .join(' ')
      .trim();
  }
  return [a.street, a.locality, a.region, a.postcode, a.country].filter(Boolean).join(', ');
}

function birthday(card: any): string | undefined {
  const b = values(card.anniversaries).find((x) => x.kind === 'birth');
  const d = b?.date;
  if (!d) return undefined;
  if (typeof d === 'string') return d;
  const date = new Date(d.year ?? 2000, (d.month ?? 1) - 1, d.day ?? 1);
  return date.toLocaleDateString([], { day: 'numeric', month: 'long', ...(d.year ? { year: 'numeric' } : {}) });
}

function toContact(c: any): Contact {
  const emails = values(c.emails).map((e) => ({ value: e.address, label: label(e.contexts, undefined, e.label) }));
  const org = values(c.organizations)[0];
  const name =
    c.name?.full ||
    (c.name?.components ?? [])
      .filter((p: any) => p.kind !== 'separator')
      .map((p: any) => p.value)
      .join(' ') ||
    org?.name ||
    emails[0]?.value ||
    '(no name)';
  return {
    id: c.id,
    name,
    nickname: values(c.nicknames)[0]?.name,
    org: [org?.name, ...(org?.units ?? []).map((u: any) => u.name)].filter(Boolean).join(', ') || undefined,
    title: values(c.titles)[0]?.name,
    emails,
    phones: values(c.phones).map((p) => ({ value: p.number, label: label(p.contexts, p.features, p.label) })),
    addresses: values(c.addresses).map((a) => ({ value: address(a), label: label(a.contexts) })).filter((a) => a.value),
    links: values(c.links).map((l) => ({ value: l.uri, label: l.label })),
    birthday: birthday(c),
    notes: values(c.notes)
      .map((n) => n.note)
      .filter(Boolean)
      .join('\n\n') || undefined,
  };
}

/** All individual contacts (groups excluded), sorted by name. */
export async function listContacts(token: string, session: Session): Promise<Contact[]> {
  const accountId = session.contactsAccountId;
  if (!accountId) throw new Error('This token has no contacts access');
  const r = await call(
    token,
    session,
    [
      ['ContactCard/query', { accountId, filter: { kind: 'individual' }, sort: [{ property: 'name/given', isAscending: true }], limit: 2000 }, 'q'],
      ['ContactCard/get', { accountId, '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' } }, 'g'],
    ],
    USING,
  );
  return (r[1]![1].list as any[]).map(toContact).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Case-insensitive substring match on name, nickname, org, emails and phones. */
export function matchContact(c: Contact, q: string): boolean {
  const needle = q.toLowerCase();
  return [c.name, c.nickname, c.org, c.title, ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value)].some((v) =>
    v?.toLowerCase().includes(needle),
  );
}
