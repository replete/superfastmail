// All secrets (API token now; a DAV app password later) live in one encrypted bundle. A random data
// key encrypts the bundle; the user's chosen lock method wraps that data key. So adding a secret or
// switching lock method never means entering the other secrets again, and there's one lock.
//
// Recovery is deliberate: there's no backup secret. Forgot the passphrase or lost the key? Paste a
// token again (Fastmail tokens are easy to replace, and the old one can be revoked).
import { b64, decrypt, deviceKey, encrypt, passphraseKey, random, unb64 } from './crypto';
import { createPasskey, passkeyKey, type PasskeyKind, type PasskeyRef } from './passkey';

export interface Secrets {
  /** Fastmail API token (JMAP: mail, contacts, Masked Email). */
  token: string;
  /** Fastmail app password for CalDAV/CardDAV/WebDAV (calendar, files). Not used yet. */
  davPassword?: string;
}

export type LockMethod = 'none' | 'passphrase' | PasskeyKind;

/** How the data key is wrapped. */
export type Wrap = { iv: string; ct: string } & (
  | { method: 'none' } // with the device key: hidden, not protected
  | { method: 'passphrase'; salt: string }
  | ({ method: 'passkey' } & PasskeyRef)
);

export interface Vault {
  v: 1;
  wrap: Wrap;
  /** The secrets, encrypted with the data key. */
  iv: string;
  ct: string;
  /** Short hash of the token (not secret: tokens are long and random), to tell when it changed. */
  tokenId: string;
  createdAt: number;
}

/** What the user chose, with what that method needs at setup. */
export type LockChoice = { method: 'none' } | { method: 'passphrase'; passphrase: string } | { method: PasskeyKind };

export const lockMethodOf = (v: Vault): LockMethod => (v.wrap.method === 'passkey' ? v.wrap.kind : v.wrap.method);

async function tokenId(token: string) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return b64(h.slice(0, 6));
}

const importDataKey = (raw: Uint8Array) =>
  crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function sealSecrets(dataKey: Uint8Array, secrets: Secrets) {
  return encrypt(await importDataKey(dataKey), new TextEncoder().encode(JSON.stringify(secrets)));
}

/** New vault for `secrets`, locked with `choice`. Passkey methods prompt (WebAuthn). */
export async function createVault(secrets: Secrets, choice: LockChoice) {
  const dataKey = random(32);
  let wrap: Wrap;
  if (choice.method === 'none') {
    wrap = { method: 'none', ...(await encrypt(await deviceKey(), dataKey)) };
  } else if (choice.method === 'passphrase') {
    const salt = random(16);
    wrap = { method: 'passphrase', salt: b64(salt), ...(await encrypt(await passphraseKey(choice.passphrase, salt), dataKey)) };
  } else {
    const { ref, key } = await createPasskey(choice.method);
    wrap = { method: 'passkey', ...ref, ...(await encrypt(key, dataKey)) };
  }
  const vault: Vault = {
    v: 1,
    wrap,
    ...(await sealSecrets(dataKey, secrets)),
    tokenId: await tokenId(secrets.token),
    createdAt: Date.now(),
  };
  return { vault, dataKey: b64(dataKey) };
}

/** Unlock: "none" needs nothing, passphrase needs it, passkeys prompt. Throws on a wrong passphrase. */
export async function openVault(vault: Vault, passphrase?: string) {
  const w = vault.wrap;
  const key =
    w.method === 'none'
      ? await deviceKey()
      : w.method === 'passphrase'
        ? await passphraseKey(passphrase ?? '', unb64(w.salt))
        : await passkeyKey(w);
  const dataKey = await decrypt(key, w);
  const secrets = JSON.parse(new TextDecoder().decode(await decrypt(await importDataKey(dataKey), vault))) as Secrets;
  return { secrets, dataKey: b64(dataKey) };
}

/** Same lock, new secrets (e.g. a replaced token): needs the data key from an unlocked session. */
export async function resealVault(vault: Vault, dataKey: string, secrets: Secrets): Promise<Vault> {
  return { ...vault, ...(await sealSecrets(unb64(dataKey), secrets)), tokenId: await tokenId(secrets.token) };
}
