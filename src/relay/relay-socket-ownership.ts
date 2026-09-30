import { existsSync, statSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { encodeHandshakeFrame, RELAY_VERSION } from './protocol'
import { relayLogLine } from './relay-diagnostic-log'

const STALE_SOCKET_PROBE_TIMEOUT_MS = 1000

// Why these codes: each proves the path does not terminate at a live listener — nothing
// listening (ECONNREFUSED), the file vanished mid-probe (ENOENT), or the connection died
// the moment we wrote to a phantom accept (EPIPE/ECONNRESET, seen on virtiofs dead inodes).
// Ambiguous errors (EACCES, ETIMEDOUT) keep the path.
const STALE_PROBE_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'EPIPE', 'ECONNRESET'])

type SocketIdentity = {
  dev: bigint
  ino: bigint
  ctimeNs: bigint
}

function sameSocketIdentity(a: SocketIdentity, b: SocketIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs
}

// Why both codes: libuv reports a path that already exists as EADDRINUSE once someone listens on
// it and as EEXIST while the file exists but its owner has not reached listen() yet (macOS), so a
// bind racing another starter sees either. Both mean "held or stale", never "free".
function isSocketPathOccupiedError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EADDRINUSE' || error.code === 'EEXIST'
}

export function isRelayNamedPipePath(sockPath: string): boolean {
  return process.platform === 'win32' && /^\\\\[.?]\\pipe\\/i.test(sockPath)
}

export class RelaySocketOwnership {
  private ownsSocketPath = false
  private ownedSocketIdentity: SocketIdentity | null = null
  private socketServer: Server | null = null

  constructor(readonly sockPath: string) {}

  get server(): Server | null {
    return this.socketServer
  }

  get owned(): boolean {
    return this.ownsSocketPath
  }

  ownsCurrentPath(): boolean {
    if (isRelayNamedPipePath(this.sockPath)) {
      return this.ownsSocketPath
    }
    const currentIdentity = this.readIdentity()
    return (
      this.ownsSocketPath &&
      this.ownedSocketIdentity !== null &&
      currentIdentity !== null &&
      sameSocketIdentity(currentIdentity, this.ownedSocketIdentity)
    )
  }

  async listen(onConnection: (socket: Socket) => void): Promise<Server> {
    const server = createServer(onConnection)
    const shouldSetUmask = !isRelayNamedPipePath(this.sockPath)
    const previousUmask = shouldSetUmask ? process.umask(0o177) : 0
    let umaskRestored = false
    const restoreUmask = (): void => {
      if (shouldSetUmask && !umaskRestored) {
        process.umask(previousUmask)
        umaskRestored = true
      }
    }

    await new Promise<void>((resolve, reject) => {
      let staleRetryAttempted = false

      const removeStartupListeners = (): void => {
        server.off('listening', onListening)
        server.off('error', onInitialError)
        server.off('error', failInitial)
      }
      const listenForStartupError = (onError: (error: NodeJS.ErrnoException) => void): void => {
        server.once('listening', onListening)
        server.once('error', onError)
        server.listen(this.sockPath)
      }
      const onListening = (): void => {
        removeStartupListeners()
        restoreUmask()
        this.ownsSocketPath = true
        this.ownedSocketIdentity = this.readIdentity()
        this.socketServer = server
        server.on('error', (error) => {
          relayLogLine(`[relay] Socket server error: ${error.message}`)
        })
        relayLogLine(`[relay] Socket server listening: ${this.sockPath}`)
        resolve()
      }
      const failInitial = (error: NodeJS.ErrnoException): void => {
        removeStartupListeners()
        restoreUmask()
        if (isSocketPathOccupiedError(error)) {
          relayLogLine(
            `[relay] Socket path already in use: ${this.sockPath}; another relay is likely active. Use --connect instead of starting a new daemon.`
          )
        } else {
          relayLogLine(`[relay] Socket server error before listen: ${error.message}`)
        }
        reject(error)
      }
      const onInitialError = (error: NodeJS.ErrnoException): void => {
        if (
          !isSocketPathOccupiedError(error) ||
          staleRetryAttempted ||
          isRelayNamedPipePath(this.sockPath)
        ) {
          failInitial(error)
          return
        }
        staleRetryAttempted = true
        this.probeBlockedPath(error, failInitial, () => {
          relayLogLine(`[relay] Removed stale socket at ${this.sockPath} and retrying listen`)
          removeStartupListeners()
          listenForStartupError(failInitial)
        })
      }
      listenForStartupError(onInitialError)
    })
    return server
  }

  closeAndCleanup(): void {
    if (this.socketServer && this.ownsCurrentPath()) {
      this.socketServer.close()
    }
    this.cleanup()
  }

  cleanup(): void {
    if (this.ownsCurrentPath()) {
      this.unlinkPath()
    }
    this.ownsSocketPath = false
    this.ownedSocketIdentity = null
  }

  private readIdentity(): SocketIdentity | null {
    if (isRelayNamedPipePath(this.sockPath)) {
      return null
    }
    try {
      const stat = statSync(this.sockPath, { bigint: true })
      return { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs }
    } catch {
      return null
    }
  }

  private probeBlockedPath(
    listenError: NodeJS.ErrnoException,
    fail: (error: NodeJS.ErrnoException) => void,
    retry: () => void
  ): void {
    const blockedIdentity = this.readIdentity()
    const probe = createConnection({ path: this.sockPath })
    let settled = false
    let timeout: NodeJS.Timeout | null = null
    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      callback()
    }
    const held = (): void => {
      finish(() => {
        probe.destroy()
        fail(listenError)
      })
    }
    const stale = (probeError: NodeJS.ErrnoException): void => {
      finish(() => {
        if (
          !STALE_PROBE_ERROR_CODES.has(probeError.code ?? '') ||
          !this.unlinkIfStillStale(blockedIdentity)
        ) {
          fail(listenError)
          return
        }
        retry()
      })
    }
    probe.once('connect', () => {
      // A bare accept is not proof of life: shared-mount socket files (virtiofs — the
      // durable-home mount in devpods) phantom-accept on a dead inode and the socket then
      // dies on first write. A live relay answers a valid handshake frame, so write one:
      // a reply means `held`, an I/O error means `stale`, and silence or a clean close
      // without a reply stays `held` — we never unlink a path whose owner we could not
      // positively rule out.
      probe.once('data', held)
      probe.once('close', (hadError) => {
        if (!hadError) {
          held()
        }
      })
      probe.write(encodeHandshakeFrame({ type: 'orca-relay-handshake', version: RELAY_VERSION }))
    })
    probe.once('error', stale)
    timeout = setTimeout(() => {
      finish(() => {
        probe.destroy()
        fail(listenError)
      })
    }, STALE_SOCKET_PROBE_TIMEOUT_MS)
  }

  private unlinkIfStillStale(blockedIdentity: SocketIdentity | null): boolean {
    const currentIdentity = this.readIdentity()
    if (currentIdentity === null) {
      return true
    }
    if (blockedIdentity === null || !sameSocketIdentity(currentIdentity, blockedIdentity)) {
      return false
    }
    try {
      unlinkSync(this.sockPath)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }

  private unlinkPath(): void {
    if (isRelayNamedPipePath(this.sockPath)) {
      return
    }
    try {
      if (existsSync(this.sockPath)) {
        unlinkSync(this.sockPath)
      }
    } catch {
      // Best-effort cleanup.
    }
  }
}
