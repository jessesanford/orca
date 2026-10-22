import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../../ssh/config/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('../../ssh/connection/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../../ssh/connection/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../../ssh/port-forwarding/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)
vi.mock(import('../../ssh/connection/ssh-connection-timing'), async (importOriginal) => ({
  ...(await importOriginal()),
  SSH_CONNECT_ADMISSION_TIMEOUT_MS: 200
}))

import type { SshTarget } from '../../../shared/ssh-types'
import { createSshIpcHarness } from './ssh-ipc-test-harness'
import { decideHostServer } from './ssh-host-server-connect'
import { connectInFlight } from './ssh-connect-attempt-registry'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

const { mockSshStore } = mocks

const target: SshTarget = {
  id: 'ssh-1',
  label: 'Server',
  host: 'example.com',
  port: 22,
  username: 'deploy'
}

// A lifecycle op or in-flight connect that never settles used to park every ssh.connect for the
// target forever — each parked call held a serve-RPC dispatch slot (the dead-VM reconnect wedge).
// The admission bound fails the waiter while the queued work keeps running.
describe('ssh:connect admission bound', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers } = harness

  beforeEach(harness.reset)

  it('fails a connect parked behind a lifecycle op that never settles', async () => {
    mockSshStore.getTarget.mockReturnValue(target)
    void runTargetLifecycle('ssh-1', () => new Promise<never>(() => {}))

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toThrow(
      'Timed out waiting for pending lifecycle operations on SSH target "ssh-1"'
    )
  })

  it('fails a connect joining an in-flight attempt that never settles', async () => {
    mockSshStore.getTarget.mockReturnValue(target)
    vi.mocked(decideHostServer).mockImplementationOnce(() => new Promise<never>(() => {}))
    void Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    await vi.waitFor(() => expect(connectInFlight.has('ssh-1')).toBe(true))

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toThrow(
      'Timed out waiting for the in-flight connect on SSH target "ssh-1"'
    )
  })

  it('still joins an in-flight connect that settles within the bound', async () => {
    mockSshStore.getTarget.mockReturnValue(target)
    let releaseDecision = (): void => {}
    vi.mocked(decideHostServer).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof decideHostServer>>>((resolve) => {
          releaseDecision = () => resolve({ route: 'managed', environmentId: 'env-test' })
        })
    )
    const first = Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    await vi.waitFor(() => expect(connectInFlight.has('ssh-1')).toBe(true))

    const second = Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    releaseDecision()

    await expect(second).resolves.toMatchObject({ status: 'connected' })
    await expect(first).resolves.toMatchObject({ status: 'connected' })
  })
})
