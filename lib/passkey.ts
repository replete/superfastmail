// Passkey / security-key keys via the WebAuthn PRF extension.
//
// The authenticator derives a stable secret from (credential, salt) only after user verification
// (Touch ID, fingerprint on the key, PIN). We turn that secret into an AES key (HKDF), which the
// vault uses to wrap its data key. Storage holds the credential id and salt — never the secret.
// Firefox 150+ allows WebAuthn in extension pages only with an RP ID covered by the extension's host
// permissions, hence api.fastmail.com. Prompts can't be shown from the toolbar dropdown (see
// lib/passkey-window.ts).
import { b64, random, unb64 } from './crypto';
import { debugLog } from './debuglog';

const RP_ID = 'api.fastmail.com';
const INFO = new TextEncoder().encode('super-fastmail token v1');
const trace = (...a: unknown[]) => debugLog('passkey:', ...a);

/** A passkey kept by the device or a password manager (Touch ID, Windows Hello…), or a security key. */
export type PasskeyKind = 'device' | 'security-key';

export interface PasskeyRef {
  credentialId: string;
  prfSalt: string;
  kind: PasskeyKind;
  /** From the authenticator at creation; steers the OS prompt straight to it on unlock. */
  transports: string[];
}

export const passkeyName = (kind?: PasskeyKind) => (kind === 'security-key' ? 'security key' : 'passkey');

/** Whether this browser can do passkey unlock at all (PRF support). Unknown counts as yes. */
export async function prfSupported(): Promise<boolean> {
  if (typeof PublicKeyCredential !== 'function') return false;
  const caps = await (PublicKeyCredential as any).getClientCapabilities?.().catch(() => undefined);
  return caps?.['extension:prf'] !== false;
}

async function keyFromPrf(prf: ArrayBuffer) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** One user-verified assertion returning the PRF output for `salt`. */
async function prfFor(credentialId: Uint8Array, salt: Uint8Array, transports?: string[]): Promise<ArrayBuffer> {
  trace('get: prompting');
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      rpId: RP_ID,
      allowCredentials: [
        {
          type: 'public-key',
          id: credentialId as BufferSource,
          ...(transports?.length ? { transports: transports as AuthenticatorTransport[] } : {}),
        },
      ],
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential;
  const out = (assertion.getClientExtensionResults() as any).prf?.results?.first as ArrayBuffer | undefined;
  trace('get: done, prf', out ? 'present' : 'missing');
  if (!out) throw new Error("This passkey didn't return a PRF secret, so it can't unlock");
  return out;
}

/** Create a passkey and return its AES key. May prompt twice (create, then use). */
export async function createPasskey(kind: PasskeyKind): Promise<{ ref: PasskeyRef; key: CryptoKey }> {
  const salt = random(32);
  trace('create: prompting', kind);
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: RP_ID, name: 'Super Fastmail' },
      user: { id: random(16), name: 'Super Fastmail unlock', displayName: 'Super Fastmail unlock' },
      challenge: random(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      // Non-resident where the authenticator allows it, so hardware keys don't spend a slot.
      authenticatorSelection: {
        residentKey: 'discouraged',
        userVerification: 'required',
        authenticatorAttachment: kind === 'device' ? 'platform' : 'cross-platform',
      },
      hints: [kind === 'device' ? 'client-device' : 'security-key'],
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential;
  const ext = cred.getClientExtensionResults() as any;
  trace('create: done, prf', ext.prf?.results ? 'results' : ext.prf?.enabled ? 'enabled' : 'none');
  if (!ext.prf?.enabled && !ext.prf?.results) {
    throw new Error("This authenticator doesn't support PRF, which is needed to encrypt with a passkey");
  }
  const credentialId = new Uint8Array(cred.rawId);
  const transports = (cred.response as AuthenticatorAttestationResponse).getTransports?.() ?? [];
  trace('create: transports', transports.join(',') || 'none');
  // Some authenticators return the secret at creation; otherwise ask once more.
  const prf: ArrayBuffer = ext.prf?.results?.first ?? (await prfFor(credentialId, salt, transports));
  return { ref: { credentialId: b64(credentialId), prfSalt: b64(salt), kind, transports }, key: await keyFromPrf(prf) };
}

/** Prompt for the passkey and return its AES key. */
export async function passkeyKey(ref: PasskeyRef): Promise<CryptoKey> {
  return keyFromPrf(await prfFor(unb64(ref.credentialId), unb64(ref.prfSalt), ref.transports));
}
