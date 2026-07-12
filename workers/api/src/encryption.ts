/**
 * Envelope encryption for the user BYOK key vault.
 *
 *   plaintext key → AES-256-GCM(DEK) → keyCiphertext
 *   DEK           → AES-256-GCM(KEK) → dekWrapped   (KEK-IV prepended)
 *
 * Vendored from the FreeAppStore platform (packages/backend/src/lib/encryption.ts)
 * so both stores share one audited envelope scheme. Adapted for FreeDocStore:
 *  - the KEK comes from FDS_KEY_ENCRYPTION_KEY, decoded as hex or base64 (16/24/32
 *    bytes), matching the existing worker secret.
 *  - sealed values are persisted as a base64 JSON envelope in KV (StoredSecret).
 *
 * Per-row DEK means a leaked DEK exposes one key; KEK rotation only re-wraps DEKs.
 */

const IV_LENGTH = 12; // GCM standard
const KEK_IV_LENGTH = 12;

export interface StoredSecret {
  v: 2;
  keyCiphertext: string; // base64
  dekWrapped: string; // base64, KEK-IV prepended
  iv: string; // base64
  label: string;
}

export async function sealSecret(plaintext: string, kekMaterial: string): Promise<Omit<StoredSecret, "label">> {
  const kek = await importKek(kekMaterial);

  const dekRaw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const dek = await crypto.subtle.importKey("raw", toArrayBuffer(dekRaw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

  const keyCiphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, dek, toArrayBuffer(new TextEncoder().encode(plaintext))),
  );

  const ivKek = crypto.getRandomValues(new Uint8Array(KEK_IV_LENGTH));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(ivKek) }, kek, toArrayBuffer(dekRaw)));
  const dekWrapped = new Uint8Array(KEK_IV_LENGTH + wrapped.byteLength);
  dekWrapped.set(ivKek, 0);
  dekWrapped.set(wrapped, KEK_IV_LENGTH);

  return { v: 2, keyCiphertext: bytesToBase64(keyCiphertext), dekWrapped: bytesToBase64(dekWrapped), iv: bytesToBase64(iv) };
}

export async function openSecret(sealed: StoredSecret, kekMaterial: string): Promise<string> {
  const kek = await importKek(kekMaterial);

  const dekWrapped = base64ToBytes(sealed.dekWrapped);
  const ivKek = dekWrapped.slice(0, KEK_IV_LENGTH);
  const wrappedBody = dekWrapped.slice(KEK_IV_LENGTH);
  const dekRaw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(ivKek) }, kek, toArrayBuffer(wrappedBody)));
  const dek = await crypto.subtle.importKey("raw", toArrayBuffer(dekRaw), { name: "AES-GCM" }, false, ["decrypt"]);

  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(sealed.iv)) }, dek, toArrayBuffer(base64ToBytes(sealed.keyCiphertext))),
  );
  return new TextDecoder().decode(plaintext);
}

async function importKek(material: string): Promise<CryptoKey> {
  const raw = decodeKeyMaterial(material);
  if (![16, 24, 32].includes(raw.byteLength)) {
    throw new Error("FDS_KEY_ENCRYPTION_KEY must decode to 16, 24, or 32 bytes");
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function decodeKeyMaterial(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[A-Fa-f0-9]{32}$|^[A-Fa-f0-9]{48}$|^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < trimmed.length; i += 2) bytes[i / 2] = Number.parseInt(trimmed.slice(i, i + 2), 16);
    return bytes;
  }
  return base64ToBytes(trimmed);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
