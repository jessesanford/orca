import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SSH_METHODS } from './ssh'

const {
  connectRegisteredSshTargetMock,
  getRegisteredSshStateMock,
  getSshTargetRegistryStoreMock,
  listRegisteredSshTargetsMock,
  listRegisteredRemovedSshTargetLabelsMock,
  removeRegisteredSshTargetMock,
  rotateSshProviderAuthorityMock
} = vi.hoisted(() => ({
  connectRegisteredSshTargetMock: vi.fn(),
  getRegisteredSshStateMock: vi.fn(),
  getSshTargetRegistryStoreMock: vi.fn(),
  listRegisteredSshTargetsMock: vi.fn(),
  listRegisteredRemovedSshTargetLabelsMock: vi.fn(),
  removeRegisteredSshTargetMock: vi.fn(),
  rotateSshProviderAuthorityMock: vi.fn()
}))

vi.mock('../../../ssh/ssh-target-registry', () => ({
  connectRegisteredSshTarget: connectRegisteredSshTargetMock,
  getRegisteredSshState: getRegisteredSshStateMock,
  getSshTargetRegistryStore: getSshTargetRegistryStoreMock,
  listRegisteredSshTargets: listRegisteredSshTargetsMock,
  listRegisteredRemovedSshTargetLabels: listRegisteredRemovedSshTargetLabelsMock
}))

vi.mock('../../../ipc/ssh-session-teardown', () => ({
  removeRegisteredSshTarget: removeRegisteredSshTargetMock
}))

vi.mock('../../../ssh/ssh-provider-authority', () => ({
  rotateSshProviderAuthority: rotateSshProviderAuthorityMock
}))

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('ssh RPC methods', () => {
  it('returns the registered SSH target state', async () => {
    const state = {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    getRegisteredSshStateMock.mockReturnValueOnce(state)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.getState', { targetId: 'ssh-1' }))

    expect(getRegisteredSshStateMock).toHaveBeenCalledWith('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { state } })
  })

  it('connects through the registered desktop SSH lifecycle', async () => {
    const state = {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    connectRegisteredSshTargetMock.mockResolvedValueOnce(state)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.connect', { targetId: 'ssh-1' }))

    expect(connectRegisteredSshTargetMock).toHaveBeenCalledWith('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { state } })
  })

  it('returns null when the target has no registered state yet', async () => {
    getRegisteredSshStateMock.mockReturnValueOnce(undefined)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.getState', { targetId: 'ssh-1' }))

    expect(response).toMatchObject({ ok: true, result: { state: null } })
  })

  it('redacts HUB-private diagnostics from state and connect failures', async () => {
    const privateMessage = 'identity /Users/hub/.ssh/private via bastion.internal failed'
    getRegisteredSshStateMock.mockReturnValue({
      targetId: 'ssh-1',
      status: 'auth-failed',
      error: privateMessage,
      reconnectAttempt: 0
    })
    connectRegisteredSshTargetMock.mockRejectedValueOnce(new Error(privateMessage))
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const stateResponse = await dispatcher.dispatch(
      makeRequest('ssh.getState', { targetId: 'ssh-1' })
    )
    const connectResponse = await dispatcher.dispatch(
      makeRequest('ssh.connect', { targetId: 'ssh-1' })
    )

    expect(stateResponse).toMatchObject({
      ok: true,
      result: { state: { error: 'SSH authentication failed' } }
    })
    expect(connectResponse).toMatchObject({
      ok: false,
      error: { message: 'SSH authentication failed' }
    })
    expect(JSON.stringify([stateResponse, connectResponse])).not.toContain(privateMessage)
  })

  it('lists redacted SSH target summaries for paired clients', async () => {
    const targets = [
      {
        id: 'ssh-1',
        label: 'Dev box',
        host: 'dev.internal',
        port: 22,
        username: 'me',
        identityFile: '/secret/key',
        jumpHost: 'bastion',
        proxyCommand: 'private proxy'
      }
    ]
    listRegisteredSshTargetsMock.mockReturnValueOnce(targets)
    getRegisteredSshStateMock.mockReturnValueOnce({ status: 'connected', remotePlatform: 'win32' })
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listTargetSummaries'))

    expect(response).toMatchObject({
      ok: true,
      result: {
        targets: [
          {
            id: 'ssh-1',
            label: 'Dev box',
            connected: true,
            connectionStatus: 'connected',
            remotePlatform: 'win32'
          }
        ]
      }
    })
    expect(JSON.stringify(response)).not.toContain('dev.internal')
    expect(JSON.stringify(response)).not.toContain('/secret/key')
    expect(JSON.stringify(response)).not.toContain('bastion')
  })

  it('does not invent a platform before the SSH host has been detected', async () => {
    listRegisteredSshTargetsMock.mockReturnValueOnce([{ id: 'ssh-1', label: 'Dev box' }])
    getRegisteredSshStateMock.mockReturnValueOnce(undefined)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listTargetSummaries'))

    expect(response).toMatchObject({
      ok: true,
      result: { targets: [{ id: 'ssh-1', label: 'Dev box' }] }
    })
    expect(JSON.stringify(response)).not.toContain('remotePlatform')
  })

  it('reports disconnected lifecycle states without calling them connected', async () => {
    listRegisteredSshTargetsMock.mockReturnValueOnce([{ id: 'ssh-1', label: 'Dev box' }])
    getRegisteredSshStateMock.mockReturnValueOnce({ status: 'reconnecting' })
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listTargetSummaries'))

    expect(response).toMatchObject({
      ok: true,
      result: {
        targets: [{ id: 'ssh-1', connected: false, connectionStatus: 'reconnecting' }]
      }
    })
  })

  it('redacts the legacy target response for older clients', async () => {
    const targets = [
      {
        id: 'ssh-1',
        label: 'Dev box',
        host: 'dev.internal',
        port: 22,
        username: 'me',
        identityFile: '/secret/key',
        jumpHost: 'bastion'
      }
    ]
    listRegisteredSshTargetsMock.mockReturnValueOnce(targets)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listTargets'))

    expect(response).toMatchObject({
      ok: true,
      result: { targets: [{ id: 'ssh-1', label: 'Dev box' }] }
    })
    expect(JSON.stringify(response)).not.toContain('dev.internal')
    expect(JSON.stringify(response)).not.toContain('/secret/key')
    expect(JSON.stringify(response)).not.toContain('bastion')
  })

  it('lists removed-target labels for ghost-host display on paired clients', async () => {
    const labels = { 'ssh-old': 'Dev box' }
    listRegisteredRemovedSshTargetLabelsMock.mockReturnValueOnce(labels)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listRemovedTargetLabels'))

    expect(response).toMatchObject({ ok: true, result: { labels } })
  })

  it('imports ssh-config targets redacted, drains repo readoptions with authority rotation', async () => {
    const store = {
      importFromSshConfig: vi
        .fn()
        .mockReturnValue([
          { id: 'ssh-2', label: 'sbx-demo.devpod', configHost: 'sbx-demo.devpod' }
        ]),
      lastRepoReadoptions: [
        { oldTargetId: 'ssh-old', newTargetId: 'ssh-2', repoIds: ['repo-1'] },
        { oldTargetId: 'ssh-old', newTargetId: 'ssh-2', repoIds: ['repo-2'] }
      ]
    }
    getSshTargetRegistryStoreMock.mockReturnValueOnce(store)
    listRegisteredSshTargetsMock.mockReturnValueOnce([
      { id: 'ssh-2', label: 'sbx-demo.devpod', configHost: 'sbx-demo.devpod' },
      { id: 'ssh-9', label: 'other', configHost: 'other' }
    ])
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.importConfig', { reAdopt: true }))

    expect(store.importFromSshConfig).toHaveBeenCalledWith({ reAdopt: true })
    expect(store.lastRepoReadoptions).toEqual([])
    expect(rotateSshProviderAuthorityMock).toHaveBeenCalledTimes(2)
    expect(rotateSshProviderAuthorityMock).toHaveBeenCalledWith('ssh-old')
    expect(rotateSshProviderAuthorityMock).toHaveBeenCalledWith('ssh-2')
    // Why: the return must stay inside the HUB-private summary shape — imported
    // row located by id/label, never host/proxy/credential detail.
    expect(response).toMatchObject({
      ok: true,
      result: {
        targets: [{ id: 'ssh-2', label: 'sbx-demo.devpod', connected: false }],
        repoReadoptions: [{ repoIds: ['repo-1'] }, { repoIds: ['repo-2'] }]
      }
    })
    expect(JSON.stringify(response)).not.toContain('configHost')
  })

  it('refuses ssh.importConfig and ssh.removeTarget from paired clients', async () => {
    const store = { importFromSshConfig: vi.fn(), lastRepoReadoptions: [], getTarget: vi.fn() }
    getSshTargetRegistryStoreMock.mockReturnValue(store)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    for (const method of ['ssh.importConfig', 'ssh.removeTarget']) {
      const response = await dispatcher.dispatch(
        makeRequest(method, method === 'ssh.removeTarget' ? { targetId: 'ssh-1' } : {}),
        { clientKind: 'runtime' }
      )
      expect(response).toMatchObject({
        ok: false,
        error: { message: 'ssh_target_management_requires_local_caller' }
      })
    }
    expect(store.importFromSshConfig).not.toHaveBeenCalled()
    expect(removeRegisteredSshTargetMock).not.toHaveBeenCalled()
  })

  it('defaults ssh.importConfig params and fails closed when the registry is absent', async () => {
    const store = { importFromSshConfig: vi.fn().mockReturnValue([]), lastRepoReadoptions: [] }
    getSshTargetRegistryStoreMock.mockReturnValueOnce(store)
    listRegisteredSshTargetsMock.mockReturnValueOnce([])
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.importConfig'))

    expect(store.importFromSshConfig).toHaveBeenCalledWith({ reAdopt: undefined })
    expect(response).toMatchObject({ ok: true, result: { targets: [] } })

    getSshTargetRegistryStoreMock.mockReturnValueOnce(null)
    const failure = await dispatcher.dispatch(makeRequest('ssh.importConfig'))
    expect(failure).toMatchObject({
      ok: false,
      error: { message: 'ssh_target_registry_unavailable' }
    })
  })

  it('removes a target through the registered teardown path', async () => {
    getSshTargetRegistryStoreMock.mockReturnValueOnce({
      getTarget: vi.fn().mockReturnValue({ id: 'ssh-1' })
    })
    removeRegisteredSshTargetMock.mockResolvedValueOnce(undefined)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ssh.removeTarget', { targetId: 'ssh-1' })
    )

    expect(removeRegisteredSshTargetMock).toHaveBeenCalledWith('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { removed: true } })
  })

  it('refuses ssh.removeTarget for runtime-owned and unknown targets', async () => {
    removeRegisteredSshTargetMock.mockClear()
    getSshTargetRegistryStoreMock.mockReturnValue({
      getTarget: vi.fn().mockReturnValue(undefined)
    })
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const runtimeOwned = await dispatcher.dispatch(
      makeRequest('ssh.removeTarget', { targetId: 'runtime-ssh-abc123' })
    )
    expect(runtimeOwned).toMatchObject({
      ok: false,
      error: { message: 'ssh_target_protected' }
    })

    const unknown = await dispatcher.dispatch(
      makeRequest('ssh.removeTarget', { targetId: 'ssh-missing' })
    )
    expect(unknown).toMatchObject({ ok: false, error: { message: 'ssh_target_not_found' } })
    expect(removeRegisteredSshTargetMock).not.toHaveBeenCalled()
  })
})
