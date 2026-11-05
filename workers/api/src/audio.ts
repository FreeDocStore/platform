export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
import { validRepo, validBranch } from './lib/validation';
const REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';

/** Accept only the fixed PCM format produced by the local audio worker. */
export async function validateAudio(body: unknown) {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b.repo !== 'string' || !validRepo(b.repo)) throw new Error('repo must be owner/name');
  if (typeof b.path !== 'string' || !/^docs\/(?:[\w.-]+\/)*[\w.-]+\.md$/.test(b.path) || b.path.split('/').some(p => p === '..' || p === '.')) throw new Error('path must be a Markdown page inside docs/');
  if (typeof b.sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(b.sourceSha)) throw new Error('Invalid source version');
  if (b.modelRevision !== REVISION) throw new Error('Unsupported audio model revision');
  if (typeof b.branch !== 'string' || !validBranch(b.branch)) throw new Error('Invalid source branch');
  if (typeof b.audio !== 'string' || b.audio.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.audio) || b.audio.length % 4 !== 0) throw new Error('Invalid audio encoding or audio exceeds 12 MiB');
  const raw = atob(b.audio);
  if (raw.length < 46 || raw.length > MAX_AUDIO_BYTES || raw.slice(0, 4) !== 'RIFF' || raw.slice(8, 16) !== 'WAVEfmt ' || raw.slice(36, 40) !== 'data') throw new Error('Expected a PCM WAV recording');
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  if (view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 24000 || view.getUint32(28, true) !== 48000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2) throw new Error('Expected mono 24 kHz 16-bit PCM audio');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  const file = `fds-audio-${digest.slice(0, 20)}`;
  const metadata = {
    version: 1,
    sourcePath: b.path,
    sourceSha: b.sourceSha,
    audioFile: `/audio/${file}.wav`,
    audioSha256: digest,
    model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    modelRevision: REVISION,
    voice: 'af_heart',
    generatedAt: new Date().toISOString(),
  };
  return { repo: b.repo, branch: b.branch, sourcePath: b.path, sourceSha: b.sourceSha, files: [
    { path: `docs/audio/${file}.wav`, content: b.audio, encoding: 'base64' as const },
    // Stable per-page manifest prevents several old recordings competing for a page.
    { path: `${b.path}.audio.json`, content: `${JSON.stringify(metadata, null, 2)}\n` },
  ] };
}
