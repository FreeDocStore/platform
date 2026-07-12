import { describe, expect, it } from "vitest";
import { openSecret, sealSecret, type StoredSecret } from "./encryption";

function freshKekBase64(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

function freshKekHex(bytes: 16 | 24 | 32): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function withLabel(sealed: Omit<StoredSecret, "label">): StoredSecret {
  return { ...sealed, label: "sk-...abcd" };
}

describe("BYOK envelope encryption", () => {
  it("round-trips a typical API key", async () => {
    const kek = freshKekBase64();
    const sealed = await sealSecret("sk-ant-abc123_OPENWEATHER_value", kek);
    expect(await openSecret(withLabel(sealed), kek)).toBe("sk-ant-abc123_OPENWEATHER_value");
  });

  it("round-trips empty, unicode, and long values", async () => {
    const kek = freshKekBase64();
    for (const plaintext of ["", "ключ-🔑-密钥", "x".repeat(8192)]) {
      const sealed = await sealSecret(plaintext, kek);
      expect(await openSecret(withLabel(sealed), kek)).toBe(plaintext);
    }
  });

  it("accepts base64 and hex KEK material of 16/24/32 bytes", async () => {
    for (const kek of [freshKekBase64(), freshKekHex(16), freshKekHex(24), freshKekHex(32)]) {
      const sealed = await sealSecret("sk-value", kek);
      expect(await openSecret(withLabel(sealed), kek)).toBe("sk-value");
    }
  });

  it("produces fresh DEK + IV per call (no ciphertext reuse)", async () => {
    const kek = freshKekBase64();
    const a = await sealSecret("same-key", kek);
    const b = await sealSecret("same-key", kek);
    expect(a.keyCiphertext).not.toEqual(b.keyCiphertext);
    expect(a.dekWrapped).not.toEqual(b.dekWrapped);
    expect(a.iv).not.toEqual(b.iv);
  });

  it("rejects decryption under the wrong KEK", async () => {
    const sealed = await sealSecret("sk-secret", freshKekBase64());
    await expect(openSecret(withLabel(sealed), freshKekBase64())).rejects.toBeDefined();
  });

  it("rejects tampered ciphertext (GCM auth tag)", async () => {
    const kek = freshKekBase64();
    const sealed = withLabel(await sealSecret("sk-secret", kek));
    const bytes = atob(sealed.keyCiphertext).split("").map((c) => c.charCodeAt(0));
    bytes[0] ^= 0xff;
    const tampered = { ...sealed, keyCiphertext: btoa(String.fromCharCode(...bytes)) };
    await expect(openSecret(tampered, kek)).rejects.toBeDefined();
  });

  it("rejects KEK material that is not 16/24/32 bytes", async () => {
    await expect(sealSecret("sk-secret", btoa("tooshort"))).rejects.toThrow(/16, 24, or 32/);
  });
});
