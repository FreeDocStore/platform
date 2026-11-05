/** Named locks coordinate extension pages and the background on their origin. */
export async function withExtensionLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const manager = globalThis.navigator?.locks;
  return manager ? await manager.request(name, operation) : await operation();
}
