import { app } from 'electron'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environments/runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentStatusOwner } from '../ipc/runtime-environments/runtime-environment-request-connections'
import { isGatedOffWslHost } from '../wsl/wsl-host-gate'

const ACTIVATE_INTERVAL_MS = 30_000

/**
 * Activates every configured environment's status owner on `orca serve`, then re-runs so
 * environments provisioned after startup (an ssh.connect that converts a target to a managed
 * orcad) get activated too. Why: only window attach ran this activation, so a headless host
 * published no status snapshots — `mobileRelay.hosts.list` then relayed every environment as
 * 'unavailable' and paired phones could see hosts but never open their workspaces.
 */
export function activateHeadlessServeEnvironmentStatuses(): () => void {
  const userDataPath = app.getPath('userData')
  const activate = (): void => {
    for (const environment of listEnvironments(userDataPath)) {
      if (
        isRuntimeEnvironmentManuallyDisconnected(environment.id) ||
        isGatedOffWslHost(environment)
      ) {
        continue
      }
      try {
        getRuntimeEnvironmentStatusOwner(userDataPath, environment.id).activate()
      } catch (error) {
        console.warn('[serve] environment status activation failed:', environment.id, error)
      }
    }
  }
  activate()
  const timer = setInterval(activate, ACTIVATE_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
