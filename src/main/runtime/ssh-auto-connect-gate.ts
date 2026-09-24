import { getSshConnectionManager, getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'

// Why: mirrors ssh:needsPassphrasePrompt inverted — a headless host cannot surface a
// passphrase dialog and has no credential-submission RPC, so auto-dialing an
// interactive-credential target can only produce instant-fail retries. Such targets stay
// disconnected until connected once on a host with a dialog surface (which caches the
// credential). Runtime-owned targets are fenced: their connect lifecycle belongs to the
// owning runtime, not to on-demand terminal mints.
export function shouldAutoConnectSshTarget(connectionId: string): boolean {
  if (isRuntimeOwnedSshTargetId(connectionId)) {
    return false
  }
  const target = getSshTargetRegistryStore()?.getTarget(connectionId)
  if (!target?.lastRequiredPassphrase) {
    return true
  }
  return Boolean(
    getSshConnectionManager()?.getConnection(connectionId)?.hasCachedCredential()
  )
}
