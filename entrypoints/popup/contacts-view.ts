// Contacts app (rail → Contacts), after Fastmail's: searchable list with letter headings on the
// left, detail card on the right. Read-only until the token can write contacts.
import { browser } from 'wxt/browser';
import { avatarFor } from '@/lib/avatar';
import { listContacts, matchContact, type Contact, type Labelled } from '@/lib/contacts';
import { html, render, type Html } from '@/lib/html';
import { ICONS } from '@/lib/icons';
import { getCachedSession, getUnlockedToken } from '@/lib/storage';
import { $, detailRow, NEEDS_WRITE, wireCopy } from './ui';

let contacts: Contact[] | undefined;
let shown: Contact[] = [];
let selectedId: string | undefined;
let vipEmails = new Set<string>();
let loading: Promise<void> | undefined;

function initials(c: Contact): Html {
  const av = avatarFor(c.name);
  return html`<span class="cavatar" style="background:${av.bg}">${av.initials}</span>`;
}

function renderList() {
  const q = ($('cq') as HTMLInputElement).value.trim();
  shown = contacts ? (q ? contacts.filter((c) => matchContact(c, q)) : contacts) : [];
  $('ccount').textContent = contacts ? ` (${q ? `${shown.length} of ` : ''}${contacts.length})` : '';
  if (!contacts) return;
  if (!shown.length) {
    render($('cbody'), html`<div class="msg">${q ? 'No matching contacts' : 'No contacts'}</div>`);
    return;
  }
  let letter = '';
  const rows: Html[] = [];
  for (const c of shown) {
    const first = /^[a-z]/i.test(c.name) ? c.name[0]!.toUpperCase() : '#';
    if (first !== letter) {
      letter = first;
      rows.push(html`<div class="cletter">${letter}</div>`);
    }
    const sub = c.phones[0]?.value ?? c.emails[0]?.value ?? c.org ?? '';
    rows.push(html`<div class="crow${c.id === selectedId ? ' sel' : ''}" data-id="${c.id}">${initials(c)}
      <span class="cmain"><span class="cname">${c.name}</span><span class="csub">${sub}</span></span></div>`);
  }
  render($('cbody'), html`${rows}`);
}

function renderDetail() {
  const c = contacts?.find((x) => x.id === selectedId);
  $('cdetailCard').hidden = !c;
  $('cempty').hidden = Boolean(c);
  if (!c) return;
  const av = avatarFor(c.name);
  const vip = c.emails.some((e) => vipEmails.has(e.value.toLowerCase()));
  const lab = (l: Labelled, fallback: string) => l.label ?? fallback;
  const rows = [
    ...c.emails.map((e) => detailRow('mail', lab(e, 'Email'), e.value, `mailto:${e.value}`)),
    ...c.phones.map((p) => detailRow('phone', lab(p, 'Phone'), p.value, `tel:${p.value.replace(/\s/g, '')}`)),
    ...c.addresses.map((a) => detailRow('mapPin', lab(a, 'Address'), a.value)),
    ...(c.org || c.title ? [detailRow('building', 'Organisation', [c.title, c.org].filter(Boolean).join(', '))] : []),
    ...(c.birthday ? [detailRow('cake', 'Birthday', c.birthday)] : []),
    ...c.links.map((l) => detailRow('link', lab(l, 'Website'), l.value, /^https?:/.test(l.value) ? l.value : undefined)),
  ];
  const email = c.emails[0]?.value;
  const phone = c.phones[0]?.value;
  render(
    $('cdetailCard'),
    html`
    <span class="cstar${vip ? ' on' : ''}" title="${vip ? 'VIP' : `Add to VIPs — ${NEEDS_WRITE}`}">${ICONS.star}</span>
    <div class="chead">
      <span class="cavatar big" style="background:${av.bg}">${av.initials}</span>
      <div class="chead-main">
        <h2>${c.name}</h2>
        ${(c.nickname || c.title || c.org) && html`<div class="csubhead">${[c.nickname && `“${c.nickname}”`, c.title, c.org].filter(Boolean).join(' · ')}</div>`}
        <div class="cactions">
          ${phone && html`<a class="pill" href="tel:${phone.replace(/\s/g, '')}">${ICONS.phone}Call</a>`}
          ${email && html`<a class="pill" href="mailto:${email}" target="_blank" rel="noreferrer">${ICONS.mail}Email</a>`}
        </div>
      </div>
    </div>
    <div class="csection">Contact details</div>
    ${rows.length ? rows : html`<div class="msg">No details</div>`}
    <div class="crow-d"><span class="cico">${ICONS.edit}</span><span class="cval"><span class="cv cnotes${c.notes ? '' : ' empty'}">${
      c.notes ? c.notes.split('\n').map((line, i) => html`${i > 0 && html`<br>`}${line}`) : 'Add notes'
    }</span></span></div>`,
  );
}

function select(id: string | undefined) {
  selectedId = id;
  for (const row of $('cbody').querySelectorAll<HTMLElement>('.crow')) {
    const on = row.dataset.id === id;
    row.classList.toggle('sel', on);
    if (on) row.scrollIntoView({ block: 'nearest' });
  }
  renderDetail();
}

/** Load (or reload) contacts; called when the Contacts app is shown and on refresh. */
export function loadContacts(force = false): Promise<void> {
  if (loading) return loading;
  if (contacts && !force) return Promise.resolve();
  if (!contacts) render($('cbody'), html`<div class="msg">Loading contacts…</div>`);
  loading = (async () => {
    try {
      const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
      if (!token || !session) throw new Error('Not connected yet');
      contacts = await listContacts(token, session);
      const { vipEmails: vips } = (await browser.storage.local.get('vipEmails')) as { vipEmails?: { emails: string[] } };
      vipEmails = new Set((vips?.emails ?? []).map((e) => e.toLowerCase()));
      renderList();
      if (!selectedId || !contacts.some((c) => c.id === selectedId)) select(shown[0]?.id);
      else renderDetail();
    } catch (e) {
      render($('cbody'), html`<div class="msg">Couldn't load contacts: ${(e as Error).message}</div>`);
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

function move(delta: number) {
  const i = shown.findIndex((c) => c.id === selectedId);
  const next = shown[Math.min(Math.max(i + delta, 0), shown.length - 1)];
  if (next) select(next.id);
}

/** Keyboard handling while Contacts is shown; returns true if handled. */
export function contactsKey(e: KeyboardEvent): boolean {
  if (e.key === '/') $('cq').focus();
  else if (e.key === 'j' || e.key === 'ArrowDown') move(1);
  else if (e.key === 'k' || e.key === 'ArrowUp') move(-1);
  else return false;
  return true;
}

export function initContacts() {
  const q = $('cq') as HTMLInputElement;
  q.addEventListener('input', () => {
    renderList();
    if (!shown.some((c) => c.id === selectedId)) select(shown[0]?.id);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) {
      e.preventDefault();
      e.stopPropagation();
      q.value = '';
      renderList();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      q.blur();
      if (e.key === 'ArrowDown') move(1);
    }
  });
  $('cbody').addEventListener('click', (e) => {
    const row = (e.target as Element).closest<HTMLElement>('.crow');
    if (row) select(row.dataset.id);
  });
  wireCopy($('cdetailCard'));
}

// Dev-only fixtures hook (FIXTURES=1 builds): render made-up contacts for screenshots.
export function fixtureContacts(list: Contact[]) {
  contacts = list;
  renderList();
  select(shown[0]?.id);
}
