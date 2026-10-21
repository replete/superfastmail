// Masked Email app (rail → mask): search, filter and inspect Fastmail masked addresses; create
// new ones for the current site. Changes need a token with write access.
import { browser } from 'wxt/browser';
import { html, render, type Html } from '@/lib/html';
import { ICONS } from '@/lib/icons';
import { createMasked, listMasked, maskedLabel, matchMasked, setMaskedState, type Masked } from '@/lib/masked';
import { getCachedSession, getUnlockedToken } from '@/lib/storage';
import { $, detailRow, NEEDS_WRITE, shortDate, wireCopy } from './ui';

let items: Masked[] | undefined;
let shown: Masked[] = [];
let selectedId: string | undefined;
let filter: 'all' | 'enabled' | 'disabled' = 'all';
let creating = false;
let canWrite = false;
let loading: Promise<void> | undefined;

function renderList() {
  const q = ($('mq') as HTMLInputElement).value.trim();
  const counts = { all: items?.length ?? 0, enabled: 0, disabled: 0 };
  for (const m of items ?? []) if (m.state === 'enabled' || m.state === 'disabled') counts[m.state]++;
  for (const b of document.querySelectorAll<HTMLElement>('#mfilter button')) {
    const f = b.dataset.f as keyof typeof counts;
    b.classList.toggle('on', f === filter);
    b.querySelector('span')!.textContent = items ? ` ${counts[f]}` : '';
  }
  if (!items) return;
  shown = items.filter((m) => (filter === 'all' || m.state === filter) && (!q || matchMasked(m, q)));
  render(
    $('mbody'),
    shown.length
      ? html`${shown.map(
          (m) => html`<div class="crow${m.id === selectedId && !creating ? ' sel' : ''}${m.state === 'enabled' ? '' : ' off'}" data-id="${m.id}">
            <span class="mavatar">${ICONS.mask}</span>
            <span class="cmain"><span class="cname">${maskedLabel(m)}</span><span class="csub">${m.email}</span></span>
            <span class="mmeta">${stateBadge(m)}<span class="myear" title="Created ${shortDate(m.createdAt)}">${year(m.createdAt)}</span></span>
            ${toggleButton(m, 'mtoggle')}</div>`,
        )}`
      : html`<div class="msg">${q ? 'No matching masked emails' : 'None here'}</div>`,
  );
}

const year = (iso?: string) => (iso ? String(new Date(iso).getFullYear()) : '');

function stateBadge(m: Masked): Html {
  return m.state === 'enabled'
    ? html`<span class="mdot" title="Enabled"></span>`
    : html`<span class="mstate ${m.state}">${m.state === 'disabled' ? 'Disabled' : 'Pending'}</span>`;
}

/** Enable/Disable toggle; clickable only with write access. */
function toggleButton(m: Masked, cls: string): Html {
  const to = m.state === 'enabled' ? 'disabled' : 'enabled';
  const label = to === 'disabled' ? 'Disable' : 'Enable';
  return html`<button class="${cls}" data-state="${to}" data-mid="${m.id}"${
    canWrite ? html` title="${label}"` : html` aria-disabled="true" title="${label} — ${NEEDS_WRITE}"`
  }>${label}</button>`;
}

async function changeState(id: string, state: Masked['state']) {
  if (!canWrite) return;
  const m = items?.find((x) => x.id === id);
  if (!m) return;
  const before = m.state;
  m.state = state; // optimistic
  renderList();
  renderDetail();
  try {
    const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
    if (!token || !session) throw new Error('Not connected yet');
    await setMaskedState(token, session, id, state);
    if (state === 'deleted') {
      items = items!.filter((x) => x.id !== id);
      select(shown.find((x) => x.id !== id)?.id);
      renderList();
    }
  } catch (e) {
    m.state = before;
    renderList();
    renderDetail();
    $('mempty').hidden = false;
    $('mempty').textContent = `Couldn't update: ${(e as Error).message}`;
  }
}

function renderDetail() {
  const card = $('mdetailCard');
  if (creating) return renderCreate();
  const m = items?.find((x) => x.id === selectedId);
  card.hidden = !m;
  $('mempty').hidden = Boolean(m);
  if (!m) return;
  const lock = canWrite ? '' : html` aria-disabled="true" title="${NEEDS_WRITE}"`;
  render(
    card,
    html`
    <div class="chead">
      <span class="mavatar big${m.state === 'enabled' ? '' : ' off'}">${ICONS.mask}</span>
      <div class="chead-main">
        <h2>${maskedLabel(m)}</h2>
        <div class="csubhead">${m.state === 'enabled' ? html`<span class="mstate enabled">Enabled</span>` : stateBadge(m)} · created ${year(m.createdAt)}</div>
        <div class="cactions">
          <button class="pill" data-copy="${m.email}" title="Copy the masked address">${ICONS.copy}Copy</button>
          ${toggleButton(m, 'pill')}
          <button class="pill" data-state="deleted" data-mid="${m.id}"${lock}>${ICONS.trash}Delete</button>
        </div>
      </div>
    </div>
    <div class="csection">Details</div>
    ${detailRow('mask', 'Masked address', m.email)}
    ${m.forDomain && detailRow('globe', 'Website', m.forDomain, /^https?:/i.test(m.forDomain) ? m.forDomain : undefined)}
    ${detailRow('clock', 'Created', [shortDate(m.createdAt), m.createdBy && `by ${m.createdBy}`].filter(Boolean).join(' '), undefined, false)}
    ${detailRow('inbox', 'Last email received', m.lastMessageAt ? shortDate(m.lastMessageAt) : 'Never', undefined, false)}`,
  );
}

let currentSite = '';
function renderCreate() {
  const card = $('mdetailCard');
  card.hidden = false;
  $('mempty').hidden = true;
  const lock = canWrite ? '' : html` aria-disabled="true" title="Creating ${NEEDS_WRITE}"`;
  render(
    card,
    html`
    <div class="chead"><span class="mavatar big">${ICONS.mask}</span>
      <div class="chead-main"><h2>New masked email</h2>
      <div class="csubhead">A unique address that forwards to you, so you never give out your real one.</div></div></div>
    <form id="mform" class="mform">
      <label>For website<input name="forDomain" placeholder="https://example.com" value="${currentSite}"></label>
      <label>Description<input name="description" placeholder="What is it for?" value="${currentSite ? new URL(currentSite).host : ''}"></label>
      <div class="cactions"><button class="pill primary" type="submit"${lock}>${ICONS.plus}Create</button>
      <button class="pill" type="button" id="mcancel">Cancel</button></div>
      <div id="mresult" class="msg" hidden></div>
    </form>`,
  );
  $('mcancel').onclick = () => {
    creating = false;
    renderList();
    renderDetail();
  };
  ($('mform') as HTMLFormElement).onsubmit = async (e) => {
    e.preventDefault();
    if (!canWrite) return;
    const data = new FormData(e.target as HTMLFormElement);
    const out = $('mresult');
    out.hidden = false;
    out.textContent = 'Creating…';
    try {
      const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
      if (!token || !session) throw new Error('Not connected yet');
      const forDomain = String(data.get('forDomain') ?? '').trim() || undefined;
      const description = String(data.get('description') ?? '').trim() || undefined;
      const m = await createMasked(token, session, { forDomain, description });
      await navigator.clipboard.writeText(m.email);
      items = [m, ...(items ?? [])];
      creating = false;
      selectedId = m.id;
      renderList();
      renderDetail();
    } catch (err) {
      out.textContent = `Couldn't create: ${(err as Error).message}`;
    }
  };
}

function select(id: string | undefined) {
  creating = false;
  selectedId = id;
  for (const row of $('mbody').querySelectorAll<HTMLElement>('.crow')) {
    const on = row.dataset.id === id;
    row.classList.toggle('sel', on);
    if (on) row.scrollIntoView({ block: 'nearest' });
  }
  renderDetail();
}

export function loadMasked(force = false): Promise<void> {
  if (loading) return loading;
  if (items && !force) return Promise.resolve();
  if (!items) render($('mbody'), html`<div class="msg">Loading masked emails…</div>`);
  loading = (async () => {
    try {
      const [token, session] = await Promise.all([getUnlockedToken(), getCachedSession()]);
      if (!token || !session) throw new Error('Not connected yet');
      canWrite = Boolean(session.canWriteMasked);
      ($('mnew') as HTMLElement).title = canWrite ? 'New masked email' : `New masked email — ${NEEDS_WRITE}`;
      items = await listMasked(token, session);
      renderList();
      if (!creating && (!selectedId || !items.some((m) => m.id === selectedId))) select(shown[0]?.id);
      else renderDetail();
    } catch (e) {
      render($('mbody'), html`<div class="msg">Couldn't load masked emails: ${(e as Error).message}</div>`);
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

function move(delta: number) {
  const i = shown.findIndex((m) => m.id === selectedId);
  const next = shown[Math.min(Math.max(i + delta, 0), shown.length - 1)];
  if (next) select(next.id);
}

export function maskedKey(e: KeyboardEvent): boolean {
  if (e.key === '/') $('mq').focus();
  else if (e.key === 'j' || e.key === 'ArrowDown') move(1);
  else if (e.key === 'k' || e.key === 'ArrowUp') move(-1);
  else return false;
  return true;
}

export function initMasked() {
  const q = $('mq') as HTMLInputElement;
  q.addEventListener('input', () => {
    renderList();
    if (!creating && !shown.some((m) => m.id === selectedId)) select(shown[0]?.id);
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
  $('mfilter').addEventListener('click', (e) => {
    const f = (e.target as Element).closest<HTMLElement>('[data-f]')?.dataset.f;
    if (!f) return;
    filter = f as typeof filter;
    renderList();
    if (!creating && !shown.some((m) => m.id === selectedId)) select(shown[0]?.id);
  });
  // State buttons (row hover toggle, detail Enable/Disable/Delete).
  const onState = (e: Event) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-state][data-mid]');
    if (!btn) return false;
    e.stopPropagation();
    if (btn.getAttribute('aria-disabled') === 'true') return true;
    // Deleting is permanent (mail to it will bounce): require a second click.
    if (btn.dataset.state === 'deleted' && btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.lastChild!.textContent = 'Click again to delete';
      setTimeout(() => renderDetail(), 3000);
      return true;
    }
    changeState(btn.dataset.mid!, btn.dataset.state as Masked['state']);
    return true;
  };
  $('mbody').addEventListener('click', (e) => {
    if (onState(e)) return;
    const row = (e.target as Element).closest<HTMLElement>('.crow');
    if (row) select(row.dataset.id);
  });
  $('mdetailCard').addEventListener('click', (e) => onState(e));
  $('mnew').addEventListener('click', async () => {
    // Prefill with the site in the active tab (activeTab grants its URL while the popup is open).
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    currentSite = tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url).origin : '';
    creating = true;
    renderList();
    renderDetail();
  });
  wireCopy($('mdetailCard'));
}

// Dev-only fixtures hook (FIXTURES=1 builds).
export function fixtureMasked(list: Masked[]) {
  items = list;
  renderList();
  select(shown[0]?.id);
}
