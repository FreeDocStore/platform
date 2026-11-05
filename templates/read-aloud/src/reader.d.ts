export interface Block { kind: string; text: string; level?: number; id?: string }
export interface VoiceChoices {
  list: Array<{ voiceURI: string; name: string; lang: string }>;
  choose(uri?: string | null): SpeechSynthesisVoice | null;
}
export interface Progress { index: number; total: number; charIndex: number; seconds: number | null; duration: number | null }
export interface Source {
  label: string; items: unknown[]; seek: string;
  start(): void; pause(): void; resume(): void; stop(): void;
  onEnded(fn: () => void): void; onError(fn: (message: string) => void): void;
  onYielded?(fn: () => void): void;
  onProgress(fn: (progress: Progress) => void): void; seekTo(index: number): void;
}
export function readableBlocks(root: Element): Block[];
export function mainContentRoot(doc?: Document): HTMLElement;
export function toChunks(blocks: Block[]): Array<{ text: string }>;
export function resolveVoiceChoices(): Promise<VoiceChoices>;
export function createSpeechSourceWith(blocks: Block[], voice: SpeechSynthesisVoice, startAt?: { chunk: number; char: number }, getRate?: () => number): Source | null;
export function isReadAloudSignal(event: MessageEvent, type: string): boolean;
export function postReadAloudSignal(type: string): void;
export const READ_ALOUD_STOP: string;
export const READ_ALOUD_STARTED: string;
