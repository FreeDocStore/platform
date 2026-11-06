let stopCurrent: (() => void) | null = null;

export function registerPlaybackStop(stop: () => void): void { stopCurrent = stop; }
export function stopSharedPlayback(): void { stopCurrent?.(); }
