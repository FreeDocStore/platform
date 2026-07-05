/// <reference types="vite/client" />

declare module 'libsodium-wrappers' {
  const sodium: {
    ready: Promise<void>
    base64_variants: {
      ORIGINAL: number
    }
    from_string(value: string): Uint8Array
    from_base64(value: string, variant: number): Uint8Array
    to_base64(value: Uint8Array, variant: number): string
    crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array
  }

  export default sodium
}
