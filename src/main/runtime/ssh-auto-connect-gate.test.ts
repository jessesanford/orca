import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldAutoConnectSshTarget } from './ssh-auto-connect-gate'

const { getSshTargetRegistryStoreMock, getSshConnectionManagerMock } = vi.hoisted(() => ({
  getSshTargetRegistryStoreMock: vi.fn(),
  getSshConnectionManagerMock: vi.fn()
}))

vi.mock('../ssh/ssh-target-registry', () => ({
  getSshTargetRegistryStore: getSshTargetRegistryStoreMock,
  getSshConnectionManager: getSshConnectionManagerMock
}))

function mockStore(target?: { lastRequiredPassphrase?: boolean } | undefined): void {
  getSshTargetRegistryStoreMock.mockReturnValue({
    getTarget: () => target
  })
}

function mockManager(hasCachedCredential?: boolean | undefined): void {
  getSshConnectionManagerMock.mockReturnValue(
    hasCachedCredential === undefined
      ? { getConnection: () => undefined }
      : { getConnection: () => ({ hasCachedCredential: () => hasCachedCredential }) }
  )
}

describe('shouldAutoConnectSshTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses runtime-owned targets', () => {
    expect(shouldAutoConnectSshTarget('runtime-ssh-abc123')).toBe(false)
    expect(getSshTargetRegistryStoreMock).not.toHaveBeenCalled()
  })

  it('connects targets that never required a passphrase', () => {
    mockStore({ lastRequiredPassphrase: false })
    expect(shouldAutoConnectSshTarget('ssh-1')).toBe(true)
    mockStore({})
    expect(shouldAutoConnectSshTarget('ssh-1')).toBe(true)
  })

  it('connects passphrase targets only when a live connection holds a cached credential', () => {
    mockStore({ lastRequiredPassphrase: true })
    mockManager(true)
    expect(shouldAutoConnectSshTarget('ssh-1')).toBe(true)
  })

  it('skips passphrase targets without a cached credential', () => {
    mockStore({ lastRequiredPassphrase: true })
    mockManager(false)
    expect(shouldAutoConnectSshTarget('ssh-1')).toBe(false)
  })

  it('skips passphrase targets when no connection exists', () => {
    mockStore({ lastRequiredPassphrase: true })
    mockManager(undefined)
    expect(shouldAutoConnectSshTarget('ssh-1')).toBe(false)
  })

  it('fails open to a connect attempt when the store or manager is absent', () => {
    getSshTargetRegistryStoreMock.mockReturnValue(undefined)
    expect(shouldAutoConnectSshTarget('ssh-1')).toBe(true)

    mockStore({ lastRequiredPassphrase: true })
    getSshConnectionManagerMock.mockReturnValue(undefined)
    expect(shouldAutoConnectSshTarget('ssh-1')).toBe(false)
  })
})
