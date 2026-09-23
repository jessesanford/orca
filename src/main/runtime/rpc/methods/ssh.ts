import {
  connectRegisteredSshTarget,
  getRegisteredSshState,
  getSshTargetRegistryStore,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSshTargets
} from '../../../ssh/ssh-target-registry'
import { removeRegisteredSshTarget } from '../../../ipc/ssh-session-teardown'
import { rotateSshProviderAuthority } from '../../../ssh/ssh-provider-authority'
import { defineMethod } from '../core'
import { getPublicSshError, getPublicSshState } from '../../public-ssh-state'
import type { SshTargetSummary } from '../../../../shared/ssh-types'
import { SshImportConfig, SshTarget } from '../../../../shared/rpc-contract/ssh-params'

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
  }),
  defineMethod({
    name: 'ssh.importConfig',
    params: SshImportConfig,
    // Why: headless serves have no IPC surface, so registration tooling needs the
    // same ~/.ssh/config reconcile the desktop's Settings→Import performs, over RPC.
    handler: (params) => {
      const store = getSshTargetRegistryStore()
      if (!store) {
        throw new Error('ssh_target_registry_unavailable')
      }
      const targets = store.importFromSshConfig({ reAdopt: params.reAdopt })
      // Why: mirrors the IPC handler's readoption tail (drain + provider rotation);
      // there is no renderer to notify on a headless serve — the caller gets them here.
      const repoReadoptions = store.lastRepoReadoptions
      store.lastRepoReadoptions = []
      for (const targetId of new Set(
        repoReadoptions.flatMap(({ oldTargetId, newTargetId }) => [oldTargetId, newTargetId])
      )) {
        rotateSshProviderAuthority(targetId)
      }
      return { targets, repoReadoptions }
    }
  }),
  defineMethod({
    name: 'ssh.removeTarget',
    params: SshTarget,
    // Why: de-registration needs the same teardown the IPC path performs —
    // transport dispose, lease cleanup, and browser-partition release — not a
    // bare store row delete.
    handler: async (params) => {
      await removeRegisteredSshTarget(params.targetId)
      return { removed: true }
    }
  })
]
