import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { validateAudio } from './audio';
import { registerPublishRoutes } from './routes/publish';
import type { Env, Session, Variables } from './types';
import { isOpusSupported } from '../../../templates/read-aloud/src/opus-encoder.js';

function wav() {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  const text = (at: number, str: string) => [...str].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  text(0, 'RIFF'); view.setUint32(4, 40, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, 4, true);
  return btoa(String.fromCharCode(...bytes));
}
const input = { repo: 'FreeDocStore/example', branch: 'main', path: 'docs/guide.md', sourceSha: 'a'.repeat(40), modelRevision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231', audio: wav() };
function oggOpus() {
  const enc = new TextEncoder();
  const head = new Uint8Array(19); head.set(enc.encode('OpusHead')); head[8] = 1; head[9] = 1; new DataView(head.buffer).setUint16(10, 312, true); new DataView(head.buffer).setUint32(12, 24000, true);
  const vendor = enc.encode('fds');
  const tags = new Uint8Array(16 + vendor.length); tags.set(enc.encode('OpusTags')); new DataView(tags.buffer).setUint32(8, vendor.length, true); tags.set(vendor, 12); new DataView(tags.buffer).setUint32(12 + vendor.length, 0, true);
  function page(sequence: number, flags: number, granule: bigint, packet: Uint8Array) {
    const bytes = new Uint8Array(28 + packet.length); bytes.set(enc.encode('OggS')); bytes[5] = flags; new DataView(bytes.buffer).setBigUint64(6, granule, true); new DataView(bytes.buffer).setUint32(14, 7, true); new DataView(bytes.buffer).setUint32(18, sequence, true); bytes[26] = 1; bytes[27] = packet.length; bytes.set(packet, 28);
    let crc = 0;
    for (const byte of bytes) { crc = (crc ^ (byte << 24)) >>> 0; for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0; }
    new DataView(bytes.buffer).setUint32(22, crc, true);
    return bytes;
  }
  const pages = [page(0, 2, 0n, head), page(1, 0, 0n, tags), page(2, 4, 48312n, new Uint8Array([0xf8]))];
  const all = new Uint8Array(pages.reduce((sum, part) => sum + part.length, 0)); let offset = 0;
  for (const part of pages) { all.set(part, offset); offset += part.length; }
  return btoa(String.fromCharCode(...all));
}
const opusInput = { ...input, audio: oggOpus(), format: 'opus' as const };
const session: Session = { id: 'session', user: { id: 'user', provider: 'github', login: 'reader', name: 'Reader', avatarUrl: '', githubUrl: '' }, githubAccessToken: 'user-token', createdAt: '', updatedAt: '' };

afterEach(() => vi.unstubAllGlobals());

describe('narration publication', () => {
  it('keeps binary audio intact and creates a stable per-page manifest', async () => {
    const result = await validateAudio(input);
    expect(result.files[0].encoding).toBe('base64');
    expect(result.files[0].content).toBe(input.audio);
    expect(result.files[0].path).toMatch(/^docs\/audio\/fds-audio-[a-f0-9]{20}\.wav$/);
    expect(result.files[1].path).toBe('docs/guide.md.audio.json');
    const manifest = JSON.parse(result.files[1].content);
    expect(manifest.sourceSha).toBe(input.sourceSha);
    expect(manifest.audioFile).toBe(`/${result.files[0].path.slice(5)}`);
    expect(manifest.audioSha256).toHaveLength(64);
  });

  it.each([
    { path: 'docs/../private.md' }, { path: '../guide.md' }, { path: 'docs/./guide.md' },
    { path: '.github/workflows/deploy.yml' }, { sourceSha: 'latest' }, { audio: 'garbage' },
    { audio: btoa('RIFFfakeWAVEfmt data') }, { repo: 'owner/repo/other' }, { modelRevision: 'main' },
  ])('rejects invalid or untrusted metadata %j', async patch => {
    await expect(validateAudio({ ...input, ...patch })).rejects.toThrow();
  });

  it('rejects inconsistent WAV sizes and formats', async () => {
    const bytes = Uint8Array.from(atob(input.audio), c => c.charCodeAt(0));
    new DataView(bytes.buffer).setUint32(24, 44100, true);
    await expect(validateAudio({ ...input, audio: btoa(String.fromCharCode(...bytes)) })).rejects.toThrow('24 kHz');
  });

  it('accepts checked Ogg Opus, records duration, and derives the digest filename', async () => {
    const result = await validateAudio(opusInput);
    expect(result.files[0].path).toMatch(/^docs\/audio\/fds-audio-[a-f0-9]{20}\.opus$/);
    const manifest = JSON.parse(result.files[1].content);
    expect(manifest.container).toBe('opus');
    expect(manifest.audioFile).toBe(`/${result.files[0].path.slice(5)}`);
    expect(manifest.durationSeconds).toBeCloseTo(1, 5);
    expect(manifest.audioSha256).toHaveLength(64);
  });

  it('rejects corrupt Ogg signatures, page checksums, and WAV bytes labeled Opus', async () => {
    await expect(validateAudio({ ...opusInput, audio: input.audio })).rejects.toThrow('Ogg Opus');
    const corrupt = Uint8Array.from(atob(opusInput.audio), c => c.charCodeAt(0)); corrupt[28] ^= 1;
    await expect(validateAudio({ ...opusInput, audio: btoa(String.fromCharCode(...corrupt)) })).rejects.toThrow('checksum');
    await expect(validateAudio({ ...input, format: 'opus' })).rejects.toThrow('Ogg Opus');
  });

  it('rejects Opus above 1.5 MiB before decoding it', async () => {
    const bytes = new Uint8Array(1_572_865);
    const audio = btoa(String.fromCharCode(...bytes.subarray(0, 100_000))) + 'A'.repeat(Math.ceil((bytes.length - 100_000) / 3) * 4);
    await expect(validateAudio({ ...opusInput, audio })).rejects.toThrow('1.5 MiB');
  });

  it('preserves WAV as the default format for older clients', async () => {
    const result = await validateAudio(input);
    expect(result.files[0].path).toMatch(/\.wav$/);
  });

  it('uses the compatible fallback when Ogg recording is unavailable', () => {
    expect(isOpusSupported(undefined as never)).toBe(false);
    expect(isOpusSupported({ isTypeSupported: () => false } as never)).toBe(false);
    expect(isOpusSupported({ isTypeSupported: (type: string) => type.startsWith('audio/ogg') } as never)).toBe(true);
    // WebM Opus cannot be relabeled as Ogg; unsupported Ogg therefore stays on WAV.
    expect(isOpusSupported({ isTypeSupported: (type: string) => type.startsWith('audio/webm') } as never)).toBe(false);
  });

  function app(auth: Session | null) {
    const server = new Hono<{ Bindings: Env; Variables: Variables }>();
    server.use('*', async (c, next) => { c.set('session', auth); await next(); });
    registerPublishRoutes(server);
    return server;
  }
  const request = (body = input) => new Request('https://api.example/api/audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('requires a session and the user GitHub connection', async () => {
    expect((await app(null).fetch(request())).status).toBe(401);
    expect((await app({ ...session, githubAccessToken: undefined }).fetch(request())).status).toBe(403);
  });

  it('rejects source changes at the commit parent before creating blobs', async () => {
    const upstream = vi.fn(async (url: string) => {
      if (url.includes('/git/ref/')) return Response.json({ object: { sha: 'parent' } });
      if (url.includes('/git/commits/')) return Response.json({ tree: { sha: 'tree' } });
      if (url.includes('/contents/')) return Response.json({ sha: 'b'.repeat(40) });
      throw new Error(`Unexpected write ${url}`);
    });
    vi.stubGlobal('fetch', upstream);
    const response = await app(session).fetch(request());
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain('Source changed');
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(String(upstream.mock.calls[2][0])).toContain('?ref=parent');
  });

  it('rejects stale Opus source versions before creating GitHub blobs', async () => {
    const upstream = vi.fn(async (url: string) => {
      if (url.includes('/git/ref/')) return Response.json({ object: { sha: 'parent' } });
      if (url.includes('/git/commits/')) return Response.json({ tree: { sha: 'tree' } });
      if (url.includes('/contents/')) return Response.json({ sha: 'b'.repeat(40) });
      throw new Error(`Unexpected write ${url}`);
    });
    vi.stubGlobal('fetch', upstream);
    const response = await app(session).fetch(request(opusInput));
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain('Source changed');
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('creates a reviewed binary-and-metadata proposal with the user credential', async () => {
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer user-token');
      calls.push({ url, method, body });
      if (url.includes('/git/ref/')) return Response.json({ object: { sha: 'parent' } });
      if (url.includes('/git/commits/parent')) return Response.json({ tree: { sha: 'base-tree' } });
      if (url.includes('/contents/')) return Response.json({ sha: input.sourceSha });
      if (url.endsWith('/git/blobs')) return Response.json({ sha: `blob-${calls.length}` });
      if (url.endsWith('/git/trees')) return Response.json({ sha: 'new-tree' });
      if (url.endsWith('/git/commits')) return Response.json({ sha: 'commit' });
      if (url.endsWith('/git/refs')) return Response.json({ object: { sha: 'commit' } });
      if (url.endsWith('/pulls')) return Response.json({ number: 12, html_url: 'https://github.com/FreeDocStore/example/pull/12' });
      throw new Error(`Unexpected GitHub call ${url}`);
    }));
    const response = await app(session).fetch(request());
    expect(response.status).toBe(200);
    expect((await response.json() as { prNumber: number }).prNumber).toBe(12);
    expect(calls.find(call => call.url.endsWith('/git/blobs'))?.body.content).toBe(input.audio);
    expect(calls.filter(call => call.url.endsWith('/git/blobs'))).toHaveLength(2);
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(calls.at(-1)?.body.base).toBe('main');
  });

  it('rejects oversized uploads before parsing or calling GitHub', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const req = request(); req.headers.set('Content-Length', '999999999');
    expect((await app(session).fetch(req)).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
});
