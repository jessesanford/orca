import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { openFramedSession, sendRequest, sleep, waitFor } from './runtime-rpc-test-harness'

// A dispatch that never settles pins its connection's inflight slot and suspends the socket's
// idle reaper; enough of them wedge `orca serve` into "accepts connections, never answers" (the
// parked ssh.connect reconnect spiral). The dispatch deadline answers a wedged non-long-poll
// request so cleanupDispatch frees the slot — long-polls keep their own keepalive/abort bound.
describe('serve-RPC dispatch deadline', () => {
  it('answers a wedged non-long-poll dispatch with runtime_timeout and frees the request slot', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rpc-deadline-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, dispatchDeadlineMs: 50 })
    vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(
      () => new Promise<never>(() => {})
    )
    await server.start()
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const session = openFramedSession(metadata!.transports[0]!.endpoint, {
        id: 'req_wedged',
        authToken: metadata!.authToken,
        method: 'ssh.connect',
        params: { targetId: 'ssh-1' }
      })
      await session.done

      expect(session.frames.filter((frame) => frame.ok !== undefined)).toEqual([
        expect.objectContaining({
          id: 'req_wedged',
          ok: false,
          error: {
            code: 'runtime_timeout',
            message: expect.stringContaining('ssh.connect handler did not settle')
          }
        })
      ])
      // The synthesized reply ran cleanupDispatch, so the request no longer counts as in flight.
      await waitFor(() => server['clientRequestsInFlight'] === 0)
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('keeps a wedged long-poll dispatch open past the deadline on keepalives', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rpc-deadline-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      dispatchDeadlineMs: 50,
      keepaliveIntervalMs: 30
    })
    vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(
      () => new Promise<never>(() => {})
    )
    await server.start()
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const session = openFramedSession(metadata!.transports[0]!.endpoint, {
        id: 'req_wait',
        authToken: metadata!.authToken,
        method: 'terminal.wait',
        params: { for: 'exit', timeoutMs: 60_000 }
      })

      await sleep(200)
      expect(session.frames.filter((frame) => frame.ok !== undefined)).toEqual([])
      expect(
        session.frames.filter((frame) => frame._keepalive === true).length
      ).toBeGreaterThanOrEqual(2)

      session.socket.destroy()
      await session.done
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('answers a fast dispatch normally', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rpc-deadline-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (request) => ({
      id: request.id,
      ok: true,
      result: { pong: true },
      _meta: { runtimeId: runtime.getRuntimeId() }
    }))
    await server.start()
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const response = await sendRequest(metadata!.transports[0]!.endpoint, {
        id: 'req_fast',
        authToken: metadata!.authToken,
        method: 'status.get'
      })
      expect(response).toMatchObject({ id: 'req_fast', ok: true, result: { pong: true } })
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('absorbs a late rejection from the raced-off dispatch', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rpc-deadline-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, dispatchDeadlineMs: 30 })
    let rejectDispatch: (error: unknown) => void = () => {}
    vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectDispatch = reject
        })
    )
    try {
      const response = await server['handleMessage'](
        JSON.stringify({ id: 'req_late', method: 'ssh.connect', authToken: server['authToken'] })
      )
      expect(response).toMatchObject({ ok: false, error: { code: 'runtime_timeout' } })
      // The dispatch keeps running after losing the race; a late rejection must stay handled —
      // vitest fails the run on an unhandled rejection escaping here.
      rejectDispatch(new Error('late handler failure'))
      await sleep(10)
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
