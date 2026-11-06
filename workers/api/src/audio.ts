export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const MAX_OPUS_BYTES = 1_572_864;
import { validRepo, validBranch } from './lib/validation';
const REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let crc = index << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    table[index] = crc;
  }
  return table;
})();

function readOggOpusDuration(bytes: Uint8Array): number {
  let offset = 0;
  let serial: number | undefined;
  let expectedSequence = 0;
  let firstPacket = new Uint8Array(0);
  let secondPacket = new Uint8Array(0);
  let packetNumber = 0;
  let preSkip: number | undefined;
  let finalGranule = -1n;
  let sawEos = false;
  const u32 = (at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
  const u64 = (at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(0, true);
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || bytes[offset] !== 0x4f || bytes[offset + 1] !== 0x67 || bytes[offset + 2] !== 0x67 || bytes[offset + 3] !== 0x53) throw new Error('Invalid Ogg Opus container');
    if (bytes[offset + 4] !== 0) throw new Error('Unsupported Ogg container version');
    const headerType = bytes[offset + 5];
    const granule = u64(offset + 6);
    const pageSerial = u32(offset + 14);
    const sequence = u32(offset + 18);
    const segmentCount = bytes[offset + 26];
    if (offset + 27 + segmentCount > bytes.length) throw new Error('Truncated Ogg page');
    const lacingAt = offset + 27;
    let payloadBytes = 0;
    for (let i = 0; i < segmentCount; i++) payloadBytes += bytes[lacingAt + i];
    const payloadAt = lacingAt + segmentCount;
    const pageEnd = payloadAt + payloadBytes;
    if (pageEnd > bytes.length) throw new Error('Truncated Ogg page payload');
    if (serial === undefined) {
      serial = pageSerial;
      if ((headerType & 2) === 0) throw new Error('Ogg Opus stream is missing its beginning-of-stream page');
    }
    if (pageSerial !== serial || sequence !== expectedSequence++) throw new Error('Invalid Ogg page sequence');
    if (sawEos) throw new Error('Ogg data follows the end-of-stream page');
    // Ogg CRC uses polynomial 0x04c11db7 with the checksum field treated as zero.
    let crc = 0;
    for (let i = offset; i < pageEnd; i++) {
      const byte = i >= offset + 22 && i < offset + 26 ? 0 : bytes[i];
      crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
    }
    if (crc !== u32(offset + 22)) throw new Error('Ogg page checksum mismatch');
    let payloadOffset = payloadAt;
    for (let i = 0; i < segmentCount; i++) {
      const lace = bytes[lacingAt + i];
      if (packetNumber < 2 && lace) {
        const prior = packetNumber === 0 ? firstPacket : secondPacket;
        const next = new Uint8Array(prior.length + lace);
        next.set(prior); next.set(bytes.subarray(payloadOffset, payloadOffset + lace), prior.length);
        if (packetNumber === 0) firstPacket = next; else secondPacket = next;
      }
      payloadOffset += lace;
      if (lace < 255 && packetNumber < 2) {
        if (packetNumber === 0) {
          if (firstPacket.length < 19 || new TextDecoder().decode(firstPacket.subarray(0, 8)) !== 'OpusHead') throw new Error('Ogg stream is missing a valid OpusHead packet');
          preSkip = new DataView(firstPacket.buffer, firstPacket.byteOffset, firstPacket.byteLength).getUint16(10, true);
        } else if (secondPacket.length < 16 || new TextDecoder().decode(secondPacket.subarray(0, 8)) !== 'OpusTags') throw new Error('Ogg stream is missing its OpusTags packet');
        packetNumber++;
      }
    }
    if (granule !== 0xffffffffffffffffn) finalGranule = granule;
    sawEos = (headerType & 4) !== 0;
    offset = pageEnd;
  }
  if (offset !== bytes.length || packetNumber < 2 || !sawEos || preSkip === undefined || finalGranule <= BigInt(preSkip)) throw new Error('Ogg Opus recording has no valid duration metadata');
  const durationSeconds = Number(finalGranule - BigInt(preSkip)) / 48_000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 6 * 60 * 60) throw new Error('Invalid Ogg Opus duration');
  return durationSeconds;
}

/** Accept the fixed local WAV format or a checked Ogg Opus stream. */
export async function validateAudio(body: unknown) {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b.repo !== 'string' || !validRepo(b.repo)) throw new Error('repo must be owner/name');
  if (typeof b.path !== 'string' || !/^docs\/(?:[\w.-]+\/)*[\w.-]+\.md$/.test(b.path) || b.path.split('/').some(p => p === '..' || p === '.')) throw new Error('path must be a Markdown page inside docs/');
  if (typeof b.sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(b.sourceSha)) throw new Error('Invalid source version');
  if (b.modelRevision !== REVISION) throw new Error('Unsupported audio model revision');
  if (typeof b.branch !== 'string' || !validBranch(b.branch)) throw new Error('Invalid source branch');
  const format = b.format === undefined ? 'wav' : b.format;
  if (format !== 'wav' && format !== 'opus') throw new Error('Unsupported audio format');
  const maxBytes = format === 'opus' ? MAX_OPUS_BYTES : MAX_AUDIO_BYTES;
  if (typeof b.audio !== 'string' || b.audio.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.audio) || b.audio.length % 4 !== 0) throw new Error(`Invalid audio encoding or audio exceeds ${format === 'opus' ? '1.5 MiB' : '12 MiB'}`);
  const raw = atob(b.audio);
  if (raw.length > maxBytes) throw new Error(`Audio exceeds ${format === 'opus' ? '1.5 MiB' : '12 MiB'}`);
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  let durationSeconds: number | undefined;
  let extension: 'wav' | 'opus';
  if (format === 'opus') {
    if (bytes.length < 27 || bytes[0] !== 0x4f || bytes[1] !== 0x67 || bytes[2] !== 0x67 || bytes[3] !== 0x53) throw new Error('Expected an Ogg Opus recording');
    durationSeconds = readOggOpusDuration(bytes);
    extension = 'opus';
  } else {
    // Existing WAV validation is retained for backwards compatibility.
    if (raw.length < 46 || raw.length > MAX_AUDIO_BYTES || raw.slice(0, 4) !== 'RIFF' || raw.slice(8, 16) !== 'WAVEfmt ' || raw.slice(36, 40) !== 'data') throw new Error('Expected a PCM WAV recording');
    const view = new DataView(bytes.buffer);
    if (view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 24000 || view.getUint32(28, true) !== 48000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2) throw new Error('Expected mono 24 kHz 16-bit PCM audio');
    extension = 'wav';
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  const file = `fds-audio-${digest.slice(0, 20)}`;
  const metadata = {
    version: 1,
    ...(format === 'opus' ? { container: 'opus', durationSeconds } : {}),
    sourcePath: b.path,
    sourceSha: b.sourceSha,
    audioFile: `/audio/${file}.${extension}`,
    audioSha256: digest,
    model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    modelRevision: REVISION,
    voice: 'af_heart',
    generatedAt: new Date().toISOString(),
  };
  return { repo: b.repo, branch: b.branch, sourcePath: b.path, sourceSha: b.sourceSha, files: [
    { path: `docs/audio/${file}.${extension}`, content: b.audio, encoding: 'base64' as const },
    // Stable per-page manifest prevents several old recordings competing for a page.
    { path: `${b.path}.audio.json`, content: `${JSON.stringify(metadata, null, 2)}\n` },
  ] };
}
