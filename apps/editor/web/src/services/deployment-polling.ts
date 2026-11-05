interface PollResult { state: string }
interface RetryInfo { retryInMs?: number; attempts: number }
interface PollOptions<T extends PollResult> {
  load: (signal: AbortSignal) => Promise<T>
  onValue: (value: T) => void
  onError: (error: unknown, retry: RetryInfo) => void
  schedule?: (callback: () => void, delayMs: number) => () => void
  now?: () => number
}
const terminal = new Set(['live', 'failed', 'setup-closed'])
const delayFor = (state: string) => state === 'awaiting-review' ? 30_000 : state === 'verifying' ? 15_000 : state === 'waiting' ? 10_000 : 5000

/** One cancellable polling loop; refresh never bypasses a provider cooldown. */
export function startDeploymentPolling<T extends PollResult>(options: PollOptions<T>) {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((callback, delay) => {
    const id = setTimeout(callback, delay)
    return () => clearTimeout(id)
  })
  let stopped = false
  let generation = 0
  let failures = 0
  let blockedUntil = 0
  let active: AbortController | null = null
  let cancelTimer = () => {}

  function queue(delay: number) {
    cancelTimer()
    cancelTimer = schedule(() => { void check() }, delay)
  }
  async function check() {
    if (stopped) return
    const mine = ++generation
    const controller = new AbortController()
    active = controller
    try {
      const value = await options.load(controller.signal)
      if (stopped || generation !== mine) return
      failures = 0
      blockedUntil = 0
      options.onValue(value)
      if (!terminal.has(value.state)) queue(delayFor(value.state))
    } catch (error) {
      if (stopped || generation !== mine || controller.signal.aborted) return
      failures++
      const detail = error as { status?: number; retryAfterSeconds?: number } | null
      const transient = error instanceof TypeError || (typeof detail?.status === 'number' && (detail.status >= 500 || detail.status === 429))
      let retryInMs: number | undefined
      if (transient) {
        const providerDelay = typeof detail?.retryAfterSeconds === 'number' && Number.isFinite(detail.retryAfterSeconds) ? Math.min(86400, Math.max(0, detail.retryAfterSeconds)) * 1000 : 0
        retryInMs = Math.max(Math.min(60_000, 5000 * 2 ** (failures - 1)), providerDelay || (detail?.status === 429 ? 60_000 : 0))
        blockedUntil = now() + providerDelay
        if (failures < 5) queue(retryInMs)
        else retryInMs = undefined
      }
      options.onError(error, { retryInMs, attempts: failures })
    } finally {
      if (active === controller) active = null
    }
  }
  function refresh() {
    if (stopped) return
    cancelTimer()
    if (now() < blockedUntil) { queue(blockedUntil - now()); return }
    generation++
    active?.abort()
    failures = 0
    void check()
  }
  function stop() {
    stopped = true
    generation++
    cancelTimer()
    active?.abort()
  }
  void check()
  return { refresh, stop }
}
