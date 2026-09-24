// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveMobileSessionTerminalCommand } from './orca-runtime-resolve-mobile-session-terminal-command'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { placeCreatedSessionTab } from '../../shared/session-tab-placement'
import { getSshPtyProvider } from '../ipc/pty'
import {
  connectRegisteredSshTarget,
  getRegisteredSshState,
  getSshConnectionManager,
  getSshTargetRegistryStore
} from '../ssh/ssh-target-registry'
import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'
import { getPublicSshError } from './public-ssh-state'
import {
  buildHeadlessMobileSessionTabGroups,
  buildMaterializedHeadlessParentLayout,
  getHeadlessMobileSessionGroupId
} from './mobile-session-layout-projection'

// Why: mirrors ssh:needsPassphrasePrompt — a headless host cannot surface a
// passphrase dialog, so auto-dialing an interactive-credential target would only
// produce instant-fail retries (the paired client can still ssh.connect after
// fixing credentials). Runtime-owned targets are fenced: their connect lifecycle
// belongs to the owning runtime, not to on-demand terminal mints.
function shouldAutoConnectSshTarget(connectionId: string): boolean {
  if (isRuntimeOwnedSshTargetId(connectionId)) {
    return false
  }
  const target = getSshTargetRegistryStore()?.getTarget(connectionId)
  if (!target?.lastRequiredPassphrase) {
    return true
  }
  return !getSshConnectionManager()?.getConnection(connectionId)?.hasCachedCredential()
}

export class OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal extends OrcaRuntimeWithResolveMobileSessionTerminalCommand {
  protected async createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts: {
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      identity?: { tabId: string; leafId: string; sessionId?: string }
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      targetGroupId?: string
      supportsSplitGroupPlacement?: boolean
      launchConfig?: SleepingAgentLaunchConfig
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    // Why: in headless serve mode there is no desktop renderer to proactively connect the SSH
    // target when the worktree opens. A mobile client creating a terminal expects the relay to be
    // established automatically, so we connect on demand before attempting to spawn the PTY.
    const connectionId = workspace.connectionId
    if (
      connectionId &&
      !getSshPtyProvider(connectionId) &&
      shouldAutoConnectSshTarget(connectionId)
    ) {
      try {
        await connectRegisteredSshTarget(connectionId)
      } catch {
        // Why: mirror ssh.connect — raw SSH/relay errors stay HUB-private;
        // paired clients receive only the sanitized public state.
        const state = getRegisteredSshState(connectionId)
        throw new Error(getPublicSshError(state?.status ?? 'error'))
      }
    }
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    // Why: SshPtyProvider treats sessionId as a relay reattach; only synthesize local serve ids so SSH fresh terminals still call pty.spawn.
    const stableSessionId =
      opts.identity?.sessionId ?? (workspace.connectionId ? undefined : `serve-${randomUUID()}`)
    const isNewSession = stableSessionId !== undefined && opts.identity?.sessionId === undefined
    const terminal = await this.createTerminal(`id:${worktreeId}`, {
      focus: false,
      command: opts.command,
      cwd,
      env: opts.env,
      envToDelete: opts.envToDelete,
      ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
      startupCommandDelivery: opts.startupCommandDelivery,
      ...(opts.identity
        ? {
            tabId: opts.identity.tabId,
            leafId: opts.identity.leafId,
            ...(stableSessionId ? { sessionId: stableSessionId } : {})
          }
        : stableSessionId
          ? { sessionId: stableSessionId }
          : {}),
      ...(isNewSession ? { isNewSession: true } : {}),
      persistHostSessionBinding: true,
      // Why: this method publishes the authoritative snapshot below; skip the intermediate publish to avoid a wrong-group flash.
      deferMobileSessionPublish: true,
      signal: opts.signal
    })
    const livePty = this.getLivePtyForHandle(terminal.handle)
    if (!livePty) {
      throw new Error('terminal_handle_stale')
    }
    const parentTabId = livePty.pty.tabId ?? `pty:${livePty.pty.ptyId}`
    const leafId = parsePaneKey(livePty.pty.paneKey ?? '')?.leafId ?? randomUUID()
    if (opts.viewMode) {
      // Why: the runtime-owned binding must survive a serve restart with the same initial mode, not a later client's local default.
      this.persistHeadlessSessionTabProps(worktreeId, parentTabId, { viewMode: opts.viewMode })
    }
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    const existingSurface =
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === parentTabId &&
          candidate.leafId === leafId
      ) ?? null
    const parentLayout = buildMaterializedHeadlessParentLayout(
      leafId,
      livePty.pty.ptyId,
      existingSurface?.parentLayout
    )
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      ptyId: livePty.pty.ptyId,
      incarnationId: livePty.pty.incarnationId,
      title: terminal.title ?? livePty.pty.title ?? 'Terminal',
      ...(cwd ? { startupCwd: cwd } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
      parentLayout,
      isActive: activate
    }
    const tabs = placeCreatedSessionTab(
      (existing?.tabs ?? []).map((candidate) => ({
        ...candidate,
        ...(candidate.type === 'terminal' && candidate.parentTabId === parentTabId
          ? { parentLayout }
          : {}),
        isActive: activate ? false : candidate.isActive
      })),
      tab,
      afterTabId,
      { afterParentGroup: opts.supportsSplitGroupPlacement !== false }
    )
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      // Why: a fresh epoch retires the current publisher, so clients drop its later tab updates.
      publicationEpoch: existing?.publicationEpoch ?? `headless:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      // Why: activating the new tab also focuses its group, so a "+" targeting a specific split group makes that group active too.
      activeGroupId:
        activate && opts.targetGroupId
          ? opts.targetGroupId
          : (existing?.activeGroupId ?? getHeadlessMobileSessionGroupId(worktreeId)),
      activeTabId: activate ? tab.id : (existing?.activeTabId ?? null),
      activeTabType: activate ? 'terminal' : (existing?.activeTabType ?? null),
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        tabs,
        activate ? tab : null,
        existing?.tabGroups,
        opts.targetGroupId ? { tabId: parentTabId, groupId: opts.targetGroupId } : undefined
      ),
      // Why: keep group split geometry on new-tab creation, else opening a terminal while split loses the arrangement.
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    // Why: emit the stored snapshot, not the pre-store one — storing grafts on retirement
    // proofs, and subscribers dedupe on version so they would never see them otherwise.
    const stored = this.storeMobileSessionSnapshot(worktreeId, next)
    const result = this.toMobileSessionTabsResult(stored)
    const changeSequence = ++this.mobileSessionTabsChangeSequence
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
        changeSequence
      )
    }
    const created = result.tabs.find((candidate) => candidate.id === tab.id)
    if (!created || created.type !== 'terminal') {
      throw new Error('terminal_handle_stale')
    }
    return {
      tab: created,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }
}
