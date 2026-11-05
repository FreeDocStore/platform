import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import { githubRequest, ProvisioningError } from './provisioning-http';

nacl.setPRNG((bytes, length) => crypto.getRandomValues(bytes.subarray(0, length)));

/** GitHub Actions uses the standard NaCl sealed-box wire format. */
export function sealRepositorySecret(value: string, publicKey: string): string {
  let recipient: Uint8Array;
  try { recipient = Uint8Array.from(atob(publicKey), c => c.charCodeAt(0)); }
  catch { throw new ProvisioningError(502, 'GitHub returned an invalid repository encryption key.'); }
  if (recipient.length !== nacl.box.publicKeyLength) throw new ProvisioningError(502, 'GitHub returned an invalid repository encryption key.');
  const ephemeral = nacl.box.keyPair();
  const keys = new Uint8Array(64);
  keys.set(ephemeral.publicKey); keys.set(recipient, 32);
  const nonce = blake2b(keys, undefined, nacl.box.nonceLength);
  const encrypted = nacl.box(new TextEncoder().encode(value), nonce, recipient, ephemeral.secretKey);
  const sealed = new Uint8Array(32 + encrypted.length);
  sealed.set(ephemeral.publicKey); sealed.set(encrypted, 32);
  return btoa(String.fromCharCode(...sealed));
}

export async function writeRepositorySecrets(token: string, repo: string, values: Record<string, string>) {
  const key = await githubRequest<{ key: string; key_id: string }>(token, `/repos/${repo}/actions/secrets/public-key`);
  if (!key?.key || !key.key_id) throw new ProvisioningError(502, 'Could not read the repository encryption key.');
  for (const [name, value] of Object.entries(values)) {
    await githubRequest(token, `/repos/${repo}/actions/secrets/${name}`, { method: 'PUT', body: { key_id: key.key_id, encrypted_value: sealRepositorySecret(value, key.key) } });
  }
}

export async function repositorySecretNames(token: string, repo: string) {
  const names = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const result = await githubRequest<{ secrets: Array<{ name: string }> }>(token, `/repos/${repo}/actions/secrets?per_page=100&page=${page}`);
    if (!Array.isArray(result?.secrets)) throw new ProvisioningError(502, 'Could not check existing repository credentials.');
    for (const secret of result.secrets) names.add(secret.name);
    if (result.secrets.length < 100) return names;
  }
  throw new ProvisioningError(422, 'Could not completely inspect repository secrets. Review the repository configuration before reconnecting.');
}
