import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeHandshakeFrame, RELAY_VERSION } from './protocol'
import { RelaySocketOwnership } from './relay-socket-ownership'
import { relayTestSocketPath } from './relay-test-socket-path'

// Unix-only: the stale-path takeover relies on socket-file inodes; Windows endpoints are
// named pipes where this orphan-by-unlink mechanism cannot occur.
describe.skipIf(process.platform === 'win32')('RelaySocketOwnership blocked-path probe', () => {
  let dir = ''
  const servers: Server[] = []
  const ownerships: RelaySocketOwnership[] = []

  function takeOwnership(sockPath: string): RelaySocketOwnership {
    const ownership = new RelaySocketOwnership(sockPath)
    ownerships.push(ownership)
    return ownership
  }

  function listenWith(server: Server, sockPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(sockPath, resolve)
    })
  }

  function fakeListener(sockPath: string, onConnection: (socket: Socket) => void): Promise<Server> {
    const server = createServer(onConnection)
    servers.push(server)
    return listenWith(server, sockPath).then(() => server)
  }

  afterEach(() => {
    for (const ownership of ownerships) {
      ownership.cleanup()
    }
    for (const server of servers) {
      server.close()
    }
    ownerships.length = 0
    servers.length = 0
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
    dir = ''
  })

  it('reclaims a path file left behind by an exited relay', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-sock-ownership-'))
    const sockPath = relayTestSocketPath(dir)

    const exited = await fakeListener(sockPath, () => {})
    exited.close()
    await new Promise((resolve) => exited.once('close', resolve))

    const ownership = takeOwnership(sockPath)
    await expect(ownership.listen(() => {})).resolves.toBeDefined()
    expect(ownership.owned).toBe(true)
  })

  it('reclaims a path whose acceptor dies on first write (phantom accept)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-sock-ownership-'))
    const sockPath = relayTestSocketPath(dir)

    // Simulates the shared-mount dead inode: the name accepts a connection, then the
    // socket tears down as soon as the probe writes a handshake frame.
    await fakeListener(sockPath, (socket) => socket.destroy())

    const ownership = takeOwnership(sockPath)
    await expect(ownership.listen(() => {})).resolves.toBeDefined()
    expect(ownership.owned).toBe(true)
  })

  it('refuses to steal a path that answers the handshake', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-sock-ownership-'))
    const sockPath = relayTestSocketPath(dir)

    await fakeListener(sockPath, (socket) => {
      socket.once('data', () => {
        socket.write(
          encodeHandshakeFrame({ type: 'orca-relay-handshake-ok', version: RELAY_VERSION })
        )
      })
    })

    const ownership = takeOwnership(sockPath)
    await expect(ownership.listen(() => {})).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(ownership.owned).toBe(false)
  })

  it('refuses to steal a path whose listener accepts but never answers', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-sock-ownership-'))
    const sockPath = relayTestSocketPath(dir)

    // Holds the connection open without responding — ambiguous, so the path stays.
    await fakeListener(sockPath, () => {})

    const ownership = takeOwnership(sockPath)
    await expect(ownership.listen(() => {})).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(ownership.owned).toBe(false)
  })

  it('refuses to steal a path whose listener closes cleanly without answering', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-sock-ownership-'))
    const sockPath = relayTestSocketPath(dir)

    await fakeListener(sockPath, (socket) => {
      socket.once('data', () => socket.end())
    })

    const ownership = takeOwnership(sockPath)
    await expect(ownership.listen(() => {})).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(ownership.owned).toBe(false)
  })

  it('connects a client through after reclaiming a stale path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-sock-ownership-'))
    const sockPath = relayTestSocketPath(dir)

    await fakeListener(sockPath, (socket) => socket.destroy())

    const ownership = takeOwnership(sockPath)
    const server = await ownership.listen(() => {})
    servers.push(server)

    await new Promise<void>((resolve, reject) => {
      const client = createConnection({ path: sockPath })
      client.once('connect', () => {
        client.destroy()
        resolve()
      })
      client.once('error', reject)
    })
  })
})
