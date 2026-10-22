import {
  getSshTargetIdForExecutionHost,
  type ExecutionHostId
} from '../../shared/execution-host'
import {
  getProjectIdForProviderIdentity,
  getProjectIdentityKey
} from '../../shared/project-host-setup-projection'
import type { ProjectHostSetupExistingFolderArgs } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import {
  SshHostNotServedError,
  sshTargetNotConnectedMessage
} from '../providers/ssh-host-not-served-error'
import { readCurrentGitRemoteIdentity } from '../repo-git-remote-identity'
import type { RuntimeStore } from './runtime-store-contract'

type ExistingFolderSetupDeps = {
  getStore: () => RuntimeStore | null
  listRepos: () => Repo[]
  addRepo: (path: string, kind: 'folder' | 'git', hostId: ExecutionHostId) => Promise<Repo>
}

export type ExistingFolderRepoResolution = {
  repo: Repo
  repoWasCreated: boolean
  folderRemote: Pick<Repo, 'gitRemoteIdentity'>
  projectId: string
}

export async function resolveExistingFolderRepo(
  deps: ExistingFolderSetupDeps,
  args: ProjectHostSetupExistingFolderArgs
): Promise<ExistingFolderRepoResolution> {
  const store = deps.getStore()
  if (!store) {
    throw new Error('runtime_unavailable')
  }
  const sshTargetId = getSshTargetIdForExecutionHost(args.hostId)
  if (sshTargetId) {
    throw new SshHostNotServedError(sshTargetId, sshTargetNotConnectedMessage(sshTargetId))
  }
  const kind = args.kind === 'folder' ? 'folder' : 'git'
  const knownRepoIds = new Set(deps.listRepos().map((repo) => repo.id))
  let repo = await deps.addRepo(args.path, kind, args.hostId)
  const repoWasCreated = !knownRepoIds.has(repo.id)
  if (args.hostLocal) {
    // Why: headless registrants (the broker's register-target script) declare a
    // `repo:`-scoped project — strip any provider/remote identity the add probe
    // stamped, or the folder projects into a phantom github:/git: project.
    const cleared = store.updateRepo(repo, {
      upstream: null,
      gitRemoteIdentity: null,
      repoIcon: null
    })
    if (!cleared) {
      throw new Error(
        `Project setup repo disappeared before its identity could be cleared: ${repo.id}`
      )
    }
    repo = cleared
  }
  // Why: a registered row's stored remote can predate a remote the user has since added.
  const folderRemote =
    args.hostLocal || (repoWasCreated && repo.gitRemoteIdentity !== undefined)
      ? repo
      : await readCurrentGitRemoteIdentity(repo)
  // Why: headless registrants can't know `repo:<id>` before the repo exists —
  // derive it here (explicit provider identity keeps its `github:` project id).
  const projectId =
    args.projectId ??
    (args.projectProviderIdentity
      ? getProjectIdForProviderIdentity(args.projectProviderIdentity)
      : getProjectIdentityKey(repo))
  return { repo, repoWasCreated, folderRemote, projectId }
}
