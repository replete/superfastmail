// Settings → Connection: API token, Calendar/Files password and lock, saved together from one Save
// bar that appears only when something changed, and says what's missing when it can't save yet.
import { DavAuthError, testDav } from '@/lib/dav';
import { html, insert, render as renderHtml, type Html } from '@/lib/html';
import { AuthError, getSession, type Session } from '@/lib/jmap';
import { passkeyName, prfSupported } from '@/lib/passkey';
import { getCachedSession, getSettings, getUnlocked, saveSettings, setUnlocked, type Unlocked } from '@/lib/storage';
import { createVault, lockMethodOf, resealVault, type LockChoice, type LockMethod, type Secrets, type Vault } from '@/lib/vault';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const token = $<HTMLInputElement>('token');
const davInput = $<HTMLInputElement>('dav');
const pass = $<HTMLInputElement>('pass');
const pass2 = $<HTMLInputElement>('pass2');
const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="lock"]')];
const tag = (t: string) => html`<span class="tag">${t}</span>`;

const METHOD_LABEL: Record<LockMethod, string> = {
  none: "Don't lock",
  passphrase: 'Password',
  device: 'Passkey',
  'security-key': 'Security key',
};

/** What's saved, refreshed by load(). */
let saved: { vault?: Vault; unlocked?: Unlocked; session?: Session } = {};
const currentMethod = () => saved.vault && lockMethodOf(saved.vault);
const selected = () => radios.find((r) => r.checked)?.value as LockMethod | undefined;
/** Lock options this browser/system can't do, with why. */
const unsupported = new Map<LockMethod, string>();
/** Credentials Fastmail rejected; saving them anyway takes a second click. */
let rejected: string | undefined;
let busy = false;
/** Progress while saving, shown in the Save bar (e.g. "Follow the browser prompts…"). */
let progress = '';
/** What's missing, after a Save click that couldn't save; cleared by the next edit. */
let invalid: { reason: string; field?: HTMLElement } | undefined;

/** Progress goes in the Save bar while it's up (else on the status line). */
function showProgress(msg: string) {
  if ($('saveBar').hidden) return status(msg);
  progress = msg;
  render();
}

/** Results, on the line above the Save bar. */
function status(msg: string, kind: '' | 'err' = '') {
  const el = $('connStatus');
  el.textContent = msg;
  el.className = `status ${kind}`;
  if (kind !== 'err') setTimeout(() => el.textContent === msg && (el.textContent = ''), Math.max(4000, msg.length * 70));
}

// --- What Save would do ------------------------------------------------------------------------

/**
 * The connection settings as one object. The form is a draft of it: an empty field keeps what's
 * saved, and the password boxes only count while Password is the chosen lock. Unsaved changes are
 * the draft's differences from the saved config, so a field refilled with the same value (say, by
 * the browser's password manager) or a hidden box changes nothing.
 */
interface Config {
  token?: string;
  dav?: string;
  method?: LockMethod;
  /** A new lock password typed (only with Password chosen). */
  password: boolean;
}

const savedConfig = (): Config => ({
  token: saved.unlocked?.secrets.token,
  dav: saved.unlocked?.secrets.davPassword,
  method: currentMethod(),
  password: false,
});

function draftConfig(): Config {
  const s = savedConfig();
  const method = selected();
  return {
    token: token.value.trim() || s.token,
    dav: davInput.value.trim() || s.dav,
    method,
    password: method === 'passphrase' && (pass.value !== '' || pass2.value !== ''),
  };
}

/** What the draft would change, in words ("API token", "lock", …). */
function changes(d = draftConfig(), s = savedConfig()): string[] {
  const out: string[] = [];
  if (d.token !== s.token) out.push('API token');
  if (d.dav !== s.dav) out.push('Calendar/Files password');
  if (d.method !== s.method) out.push('lock');
  if (d.password) out.push('new password');
  return out;
}

interface Plan {
  dirty: boolean;
  /** What would change, in words. */
  changes: string[];
  /** Why it can't save yet, if it can't, and where to fix it. */
  reason?: string;
  field?: HTMLElement;
  label: string;
  method?: LockMethod;
  /** Only values that differ from what's saved ('' = keep). */
  newToken: string;
  newDav: string;
  /** Needs a new lock (new data key, maybe a prompt) rather than re-encrypting under the current one. */
  relock: boolean;
}

function plan(): Plan {
  const d = draftConfig();
  const s = savedConfig();
  const list = changes(d, s);
  const newToken = d.token !== s.token ? (d.token ?? '') : '';
  const newDav = d.dav !== s.dav ? (d.dav ?? '') : '';
  const method = d.method;
  const current = s.method;
  const startOver = Boolean(newToken) && !saved.unlocked; // also the first setup
  const relock = method !== current || startOver || d.password;
  const dirty = list.length > 0;

  let reason: string | undefined;
  let field: HTMLElement | undefined;
  const need = (r: string, f?: HTMLElement) => ((reason = r), (field = f));
  if (!saved.unlocked && !newToken) need(saved.vault ? 'Unlock first (toolbar button), or paste your token to start over' : 'Paste your API token', token);
  else if (!method) need('Choose a lock', $('methods'));
  else if (method === 'passphrase' && relock) {
    if (pass.value.length < 8) need('The password needs 8+ characters', pass);
    else if (!pass2.value) need('Repeat the password', pass2);
    else if (pass.value !== pass2.value) need("The passwords don't match", pass2);
  }
  const prompt = relock && (method === 'device' || method === 'security-key');
  const label =
    rejected === `${newToken}\n${newDav}`
      ? 'Save anyway'
      : prompt
        ? method === 'device'
          ? 'Save and create passkey'
          : 'Save and set up key'
        : saved.vault
          ? 'Save'
          : 'Connect';
  return { dirty, changes: list, reason, field, label, method, newToken, newDav, relock };
}

// --- Rendering -----------------------------------------------------------------------------------

function render() {
  const p = plan();
  const current = currentMethod();
  const { vault, unlocked, session } = saved;

  $('state').textContent = !vault ? 'Not set up' : unlocked ? 'Connected' : 'Locked';
  $('state').classList.toggle('ok', Boolean(vault && unlocked));
  $('acct').hidden = !vault;
  renderHtml(
    $('acct'),
    !vault
      ? html``
      : unlocked
        ? html`Connected to <b>${session?.username ?? 'your account'}</b>${session?.readOnly && tag('Read only')}`
        : html`<span class="muted">Locked: unlock from the toolbar to make changes, or paste a token to start over.</span>`,
  );
  token.placeholder = vault ? 'Leave empty to keep the current token' : 'fmu1-…';
  davInput.placeholder = unlocked?.secrets.davPassword ? 'Leave empty to keep the current one' : 'xxxx xxxx xxxx xxxx';
  if (vault) $('davSection').hidden = false;

  for (const r of radios) {
    const m = r.value as LockMethod;
    const why = unsupported.get(m);
    r.disabled = Boolean(why);
    if (why) r.closest('label')!.querySelector('small')!.textContent = why;
    const b = r.closest('label')!.querySelector('b')!;
    b.querySelector('.current')?.remove();
    if (m === current) insert(b, 'beforeend', html`<span class="current">current</span>`);
  }
  // Each option's own controls: password fields when choosing Password; Replace on a working passkey
  // (not while other changes are waiting to be saved).
  for (const c of document.querySelectorAll<HTMLElement>('.method')) {
    const m = c.dataset.m as LockMethod;
    const replace = c.querySelector<HTMLButtonElement>('[data-replace]');
    const showReplace = Boolean(replace) && m === current && Boolean(unlocked) && !p.dirty && !busy;
    const act = c.querySelector<HTMLElement>('.act');
    if (act) act.hidden = m !== selected() || !(m === 'passphrase' || showReplace);
  }
  pass.placeholder = current === 'passphrase' ? 'New password' : '8+ characters';

  // Save stays clickable while there are changes; a click that can't save says what's missing.
  $('saveBar').hidden = !p.dirty;
  $('saveReason').textContent = busy ? progress : (invalid?.reason ?? `Unsaved: ${p.changes.join(', ')}`);
  $('saveReason').className = `status ${invalid && !busy ? 'err' : ''}`;
  ($('save') as HTMLButtonElement).disabled = busy;
  $('save').textContent = busy ? 'Saving…' : p.label;
  ($('cancel') as HTMLButtonElement).disabled = busy;
}

export async function load() {
  const editing = plan().dirty;
  const [s, unlocked, session] = await Promise.all([getSettings(), getUnlocked(), getCachedSession()]);
  saved = { vault: s.vault, unlocked, session };
  // Don't undo a choice the user is in the middle of (e.g. when another setting saves).
  if (!editing) for (const r of radios) r.checked = r.value === currentMethod();
  render();
}

/** Any edit: clear a previous "what's missing" message and redraw. */
function edited() {
  invalid?.field?.classList.remove('invalid');
  invalid = undefined;
  render();
}

function discard() {
  token.value = davInput.value = pass.value = pass2.value = '';
  rejected = undefined;
  invalid?.field?.classList.remove('invalid');
  invalid = undefined;
  $('result').hidden = $('davResult').hidden = true;
  for (const r of radios) r.checked = r.value === currentMethod();
  render();
}

// --- Test connection / Calendar/Files password ---------------------------------------------------

function showResult(id: 'result' | 'davResult', kind: '' | 'ok' | 'err', content: Html | string) {
  $(id).hidden = false;
  $(id).className = `result ${kind}`;
  renderHtml($(id), html`${content}`);
}

/** The token's settings, named as on Fastmail's token page. */
function describe(s: Session): ['ok' | 'err', Html] {
  const who = html`<b>${s.username || 'Your account'}</b>`;
  if (!s.accountId) return ['err', html`${who}: this token doesn't include <b>Email</b>, which Super Fastmail needs.`];
  const row = (on: boolean, name: string, extra: Html | string = '') => html`<li class="${on ? '' : 'no'}">${on ? '✓' : '–'} ${name}${extra}</li>`;
  const sc = s.scopes ?? { submission: Boolean(s.canSend), vacation: false, contacts: Boolean(s.contactsAccountId), masked: Boolean(s.maskedAccountId) };
  return [
    'ok',
    html`${who}${s.readOnly && tag('Read only')}<ul>
    ${row(true, 'Email', s.eventSourceUrl ? tag('Push available') : '')}
    ${row(sc.submission, 'Email submission', sc.submission && s.readOnly ? ' · not possible with a read-only token' : '')}
    ${row(sc.vacation, 'Vacation response')}
    ${row(sc.contacts, 'Contacts and contact groups')}
    ${row(sc.masked, 'Masked Email')}
  </ul>`,
  ];
}

async function testToken(t: string): Promise<boolean> {
  showResult('result', '', 'Checking with Fastmail…');
  try {
    const [kind, result] = describe(await getSession(t));
    showResult('result', kind, result);
    // The Calendar/Files password only makes sense once the account works.
    if (kind === 'ok') $('davSection').hidden = false;
    return kind === 'ok';
  } catch (e) {
    showResult(
      'result',
      'err',
      e instanceof AuthError
        ? "Fastmail didn't accept this token. Check it was copied in full and hasn't been revoked."
        : `Couldn't reach Fastmail (${(e as Error).message}). Check your connection and try again.`,
    );
    return false;
  }
}

/** The login name for DAV comes from the token's session: the typed token, else the saved one. */
async function davUser(): Promise<string | undefined> {
  // Just after connecting, the session may not be cached yet: ask Fastmail with the saved token.
  const t = token.value.trim() || (saved.session ? '' : saved.unlocked?.secrets.token);
  if (t) return (await getSession(t).catch(() => undefined))?.username;
  return saved.session?.username;
}

async function testAppPassword(pw: string): Promise<boolean> {
  const user = await davUser();
  if (!user) {
    showResult('davResult', 'err', 'Add a working API token first: the Calendar/Files password needs its account name.');
    return false;
  }
  showResult('davResult', '', 'Checking with Fastmail…');
  try {
    const { calendars, files } = await testDav(user, pw);
    showResult('davResult', 'ok', html`<ul class="flush"><li>✓ Calendars (${calendars})</li>
      <li class="${files ? '' : 'no'}">${files ? '✓' : '–'} Files</li></ul>`);
    return true;
  } catch (e) {
    showResult(
      'davResult',
      'err',
      e instanceof DavAuthError
        ? "Fastmail didn't accept this password. Check it was copied in full and created as a custom DAV app password."
        : `Couldn't check it (${(e as Error).message}).`,
    );
    return false;
  }
}

// --- Save / Replace ------------------------------------------------------------------------------

const firefoxMac = /Firefox/.test(navigator.userAgent) && /Mac OS X/.test(navigator.userAgent);

function failed(e: unknown, method?: LockMethod) {
  const { name, message } = e as Error;
  if (name !== 'NotAllowedError') return status(`Couldn't save: ${message}`, 'err');
  const kind = method === 'security-key' ? 'security key' : 'passkey';
  // The usual reason on a Mac: Firefox's passkeys need iCloud Keychain.
  const mac =
    method === 'device' && firefoxMac
      ? ' Firefox on a Mac keeps passkeys in iCloud Keychain, so it needs to be on (System Settings → your name → iCloud → Passwords). A security key or a password works without it.'
      : '';
  status(`Cancelled: the ${kind} wasn't set up.${mac}`, 'err');
}

/** A passkey that's been replaced or dropped still sits in the password manager or on the key. */
function leftoverNote(old: LockMethod | undefined, gone: boolean) {
  if (!gone || (old !== 'device' && old !== 'security-key')) return '';
  return ` You can delete the old “Super Fastmail unlock” ${passkeyName(old)} from ${old === 'device' ? 'your passwords' : 'the key'}.`;
}

async function commit(vault: Vault, unlocked: Unlocked) {
  await setUnlocked(unlocked);
  const s = await getSettings();
  s.vault = vault;
  await saveSettings(s);
}

async function save() {
  const p = plan();
  if (!p.dirty || busy) return;
  if (p.reason || !p.method) {
    invalid?.field?.classList.remove('invalid');
    invalid = { reason: p.reason ?? 'Choose a lock', field: p.field };
    p.field?.classList.add('invalid');
    p.field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (p.field instanceof HTMLInputElement) p.field.focus();
    return render();
  }
  const method = p.method;
  const old = currentMethod();
  busy = true;
  render();
  try {
    // New credentials are checked first; ones Fastmail rejects need a second click to save anyway.
    const attempt = `${p.newToken}\n${p.newDav}`;
    if (rejected !== attempt) {
      const tokenOk = !p.newToken || (await testToken(p.newToken));
      const davOk = !p.newDav || (await testAppPassword(p.newDav));
      if (!tokenOk || !davOk) {
        rejected = attempt;
        return;
      }
    }
    // Starting over (locked, or first setup) keeps nothing from before.
    const secrets = {
      ...saved.unlocked?.secrets,
      ...(p.newToken ? { token: p.newToken } : {}),
      ...(p.newDav ? { davPassword: p.newDav } : {}),
    } as Secrets;
    let result: { vault: Vault; dataKey: string };
    if (!p.relock && saved.vault && saved.unlocked) {
      // Same lock: re-encrypt with the data key we already have. No prompt.
      result = { vault: await resealVault(saved.vault, saved.unlocked.dataKey, secrets), dataKey: saved.unlocked.dataKey };
    } else {
      if (method === 'device' || method === 'security-key') showProgress('Follow the browser prompts…');
      const choice: LockChoice = method === 'passphrase' ? { method, passphrase: pass.value } : { method };
      result = await createVault(secrets, choice);
    }
    await commit(result.vault, { secrets, dataKey: result.dataKey });
    token.value = davInput.value = pass.value = pass2.value = '';
    rejected = undefined;
    status(`Saved · ${METHOD_LABEL[method]}.${leftoverNote(old, p.relock && old !== undefined)}`);
  } catch (e) {
    failed(e, method);
  } finally {
    busy = false;
    progress = '';
    await load();
  }
}

/** Replace the current passkey or security key (a new one, same secrets). Happens straight away. */
async function replace() {
  const method = currentMethod();
  if (busy || !saved.unlocked || (method !== 'device' && method !== 'security-key')) return;
  busy = true;
  render();
  try {
    showProgress('Follow the browser prompts…');
    const result = await createVault(saved.unlocked.secrets, { method });
    await commit(result.vault, { secrets: saved.unlocked.secrets, dataKey: result.dataKey });
    status(`Replaced.${leftoverNote(method, true)}`);
  } catch (e) {
    failed(e, method);
  } finally {
    busy = false;
    await load();
  }
}

// --- Wiring --------------------------------------------------------------------------------------

export function initConnection() {
  // Where a "Passkey" is kept depends on the browser and system: Firefox has no passkey store of its
  // own and hands them to the system (iCloud Keychain on a Mac, Windows Hello on Windows).
  const ua = navigator.userAgent;
  $('deviceHelp').textContent = `Confirm with a passkey once each time the browser starts. No password needed. ${
    firefoxMac
      ? 'Firefox saves it in iCloud Keychain, which needs to be turned on.'
      : /Firefox/.test(ua) && /Windows/.test(ua)
        ? 'Saved with Windows Hello.'
        : /Firefox/.test(ua)
          ? 'Saved by your system.'
          : 'Saved in your browser profile or password manager.'
  }`;
  // Passkeys need the PRF extension; say so instead of failing later.
  prfSupported().then(async (ok) => {
    if (!ok) {
      unsupported.set('device', 'Not supported in this browser.');
      unsupported.set('security-key', 'Not supported in this browser.');
    } else if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => true))) {
      unsupported.set('device', 'This system has nowhere to keep passkeys. A security key or a password works instead.');
    }
    render();
  });

  for (const r of radios) r.onchange = edited;
  for (const i of [pass, pass2]) i.oninput = edited;
  token.oninput = () => {
    $('result').hidden = true;
    edited();
  };
  davInput.oninput = () => {
    $('davResult').hidden = true;
    edited();
  };
  $('test').onclick = () => {
    const t = token.value.trim() || saved.unlocked?.secrets.token;
    if (t) testToken(t);
    else showResult('result', 'err', 'Paste a token first.');
  };
  $('testDav').onclick = () => {
    const pw = davInput.value.trim() || saved.unlocked?.secrets.davPassword;
    if (pw) testAppPassword(pw);
    else showResult('davResult', 'err', 'Paste the password first.');
  };
  $('save').onclick = save;
  $('cancel').onclick = discard;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-replace]')) b.onclick = replace;
  // Enter in a field saves when it can.
  for (const i of [token, davInput, pass, pass2]) i.addEventListener('keydown', (e) => e.key === 'Enter' && save());

  addEventListener('beforeunload', (e) => {
    if (!plan().dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
  return load();
}
