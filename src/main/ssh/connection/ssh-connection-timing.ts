export const INITIAL_RETRY_ATTEMPTS = 5
export const INITIAL_RETRY_DELAY_MS = 2000
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 5000, 10000, 10000, 10000, 30000, 30000]
export const CONNECT_TIMEOUT_MS = 30_000
export const SSH_CREDENTIAL_TIMEOUT_MS = 120_000

// Why: a connect queues behind the target's serialized lifecycle ops and joins an in-flight
// attempt; a wedged one must fail the waiter instead of parking it forever. Covers a credential
// prompt plus a connect with slack for a first relay deploy — the same budget the renderer's
// SSH_RECONNECT_UI_TIMEOUT_MS uses for the same reasons.
export const SSH_CONNECT_ADMISSION_TIMEOUT_MS = 180_000

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
