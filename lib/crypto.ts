// Small WebCrypto helpers shared by the vault and the passkey code.
const ITERATIONS = 600_000;

export const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export async function encrypt(key: CryptoKey, data: Uint8Array) {
  const iv = random(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data as BufferSource));
  return { iv: b64(iv), ct: b64(ct) };
}

/** Throws on a wrong key (AES-GCM authentication failure). */
export async function decrypt(key: CryptoKey, sealed: { iv: string; ct: string }) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(sealed.iv) as BufferSource },
    key,
    unb64(sealed.ct) as BufferSource,
  );
  return new Uint8Array(pt);
}

/** AES key from a passphrase (PBKDF2-SHA256). */
export async function passphraseKey(passphrase: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * A random AES key kept in IndexedDB as a non-extractable CryptoKey: scripts can use it but not read
 * it. It still lives in the browser profile, so this hides secrets rather than protecting them.
 */
export async function deviceKey(): Promise<CryptoKey> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('super-fastmail', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = (mode: IDBTransactionMode) => db.transaction('keys', mode).objectStore('keys');
  const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const req = tx('readonly').get('device');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await new Promise<void>((resolve, reject) => {
    const req = tx('readwrite').put(key, 'device');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  return key;
}
