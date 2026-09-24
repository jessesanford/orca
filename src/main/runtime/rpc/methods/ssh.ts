import {
  connectRegisteredSshTarget,
  getRegisteredSshState,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSshTargets
} from '../../../ssh/ssh-target-registry'
import { defineMethod } from '../core'
import { getPublicSshError, getPublicSshState } from '../../public-ssh-state'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import type { SshTargetSummary } from '../../../../shared/ssh-types'
import { SshTarget } from '../../../../shared/rpc-contract/ssh-params'

// Why: `generation` stays optional on the wire — an old server simply omits it and its rows key on target id alone.
function listRegisteredSshTargetSummaries(): SshTargetSummary[] {
  return listRegisteredSshTargets().map(({ id, label, generation }) => {
    const state = getRegisteredSshState(id)
    const remotePlatform = state?.remotePlatform
    return {
      id,
      label,
      ...(generation === undefined ? {} : { generation }),
      connected: state?.status === 'connected',
      ...(state?.status === undefined ? {} : { connectionStatus: state.status }),
      ...(remotePlatform === undefined ? {} : { remotePlatform })
    }
  })
}

export const SSH_METHODS = [
  defineMethod({
    name: 'ssh.getState',
    params: SshTarget,
    handler: (params) => ({
      state: getPublicSshState(getRegisteredSshState(params.targetId) ?? null)
    })
  }),
  defineMethod({
    name: 'ssh.connect',
    params: SshTarget,
    handler: async (params) => {
      // Why: runtime-owned targets are the owning runtime's transport — a paired client
      // dialing one would detach the owner's session and churn its relay leases.
      if (isRuntimeOwnedSshTargetId(params.targetId)) {
        throw new Error('ssh_target_protected')
      }
      try {
        return { state: getPublicSshState(await connectRegisteredSshTarget(params.targetId)) }
      } catch {
        const state = getRegisteredSshState(params.targetId)
        throw new Error(getPublicSshError(state?.status ?? 'error'))
      }
    }
  }),
  defineMethod({
    name: 'ssh.listTargets',
    params: null,
    // Why: legacy clients can call this method directly, so it must preserve the same HUB-private secret boundary.
    handler: () => ({ targets: listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listTargetSummaries',
    params: null,
    // Why: paired clients need display identity only; SSH addresses, jump chains, and credentials remain HUB-private.
    handler: () => ({ targets: listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listRemovedTargetLabels',
    params: null,
    handler: () => ({ labels: listRegisteredRemovedSshTargetLabels() })
  })
]
