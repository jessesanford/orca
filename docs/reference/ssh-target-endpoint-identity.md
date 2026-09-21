# SSH target endpoint identity: surviving alias and path churn

Status: design proposal. Motivated by the Docker-Sandbox/DevPod deployment where an external
script (`sync-orca-workspace.sh`, in the regolith-devcontainer repo) currently rewrites
`orca-data.json` before every `orca serve` start. Everything the script does is reconciliation
Orca could do itself; this doc records the requirements and the shape of the fix that would
retire it.

## The shape of the problem

Orca persists **cosmetic identifiers**:

- `sshTargets[].configHost` — the `Host` alias line in `~/.ssh/config`
- `sshTargets[].host` — usually the alias again when the block has no `HostName`
- `repos[].path`, `projectHostSetups[].path`, worktree keys `<repoId>::<path>` — absolute paths
  on the remote

For DevPod-managed hosts both values are *derived and regenerated*: a recreated workspace gets a
new `Host` block name (e.g. `sbx-<name>-<hash8>.devpod`) and can get a new repo path
(`--workdir` in its `ProxyCommand`). After a recreate:

- `importFromSshConfig` (`src/main/ssh/ssh-connection-store.ts:130`) reconciles **by alias**
  (`syncableByAlias`, `:149-163`). The new alias matches nothing, so a *new* target row is
  inserted while the old row still owns every repo/worktree binding by target id.
- `readoptOrphanedWorkspacesForTarget` (`src/main/ssh/ssh-target-readoption.ts:52`) only fires on
  remove→re-add, and `tombstoneMatches` (`:26-44`) requires the *same* alias, or — when no real
  alias exists — the same `sshEndpointKey` = `host|port|username`
  (`src/main/ssh/ssh-target-identity.ts:25`). For a `ProxyCommand` target, `host` *is* the
  changed alias, so the tuple cannot match either.

Nothing in-tree answers "this new `Host` block is the same endpoint with a new name", so every
DevPod workspace recreate orphans the project's repos, setups, worktree keys, sessions, and
automations on a dead target id.

## What the external script does today

`sync-orca-workspace.sh` runs inside the Regolith container before each `orca serve`
(from `orca-serve-dgx`) and on `postStart`. It edits `orca-data.json` directly:

1. **Instance discovery** — parses `~/.ssh/config`; every `Host *.devpod` block is one
   instance. The `ProxyCommand`'s `--workdir` is the repo path (fallback
   `/workspaces/<alias-stem>`).
2. **Target binding** — each `sshTargets[]` row binds to exactly one instance: alias match
   (including `sbx-<name>-<8hex>` drift via `~/.config/agentic-sandbox/instances/*.env` names),
   falling back to a `(<suffix>)` label marker (`agentic-coding-tools-generic (vpn)`) for rows
   whose alias was already clobbered.
3. **Heal bound rows only** — sets the target's `host`/`configHost` to the current alias; sets
   bound `repos[].path`/`executionHostId` and `projectHostSetups[]` to the instance path;
   rewrites compound strings (`<repoId>::<path>` worktree keys, session refs) that carry a bound
   id; prunes `worktreeMeta` for bound repos at stale paths.
4. **Process ordering hazard** — must run while Orca is stopped or not yet started; the daemon
   caches the file in memory and rewrites it on exit. A single-instance ancestor of this script
   additionally stomped *every* matching target onto the default devpod, which is what motivated
   the per-instance binding scoping.

Cost of keeping it: a second implementation of Orca's own reconciliation, a stop-the-world
ordering requirement, and file-format coupling to the store internals.

## The durable fix: rebind by endpoint identity

**Principle:** the `Host` alias is a name; the `ProxyCommand` *is* the endpoint. Two aliases
that resolve to the same proxy command + workspace argument reach the same machine, account,
and filesystem — therefore the same target.

### Proposed changes

1. **Extend `SshIdentityFields` with a proxy-endpoint key.** Add
   `sshProxyEndpointKey(target)`: a normalized form of the effective `ProxyCommand` —
   argv tokens minus transport flags (`--stdio`, `-o`, `-W`, port placeholders), so
   `devpod ssh --context default --user vscode sbx-ws-123 --workdir /x` keys on
   `devpod ssh|vscode|sbx-ws-123|/x`. For non-proxy targets the key is the existing
   `sshEndpointKey` (`host|port|username`).
2. **Import reconciles by endpoint identity, not just alias.** In
   `importFromSshConfig`, when a config host's alias matches no existing target, check
   `sshProxyEndpointKey` against existing `ssh-config`-sourced targets *before* inserting:
   - match → `updateSshTarget(existing.id, { configHost: newAlias, host: …, proxyCommand: … })`
     in place. The id survives, so every repo/worktree/setup binding survives — no orphan
     cascade, no tombstone round-trip.
   - no match → current insert path.
   - Multiple existing rows with the same endpoint key must not silently merge: bind only when
     exactly one unambiguous candidate exists (mirror the ambiguity rules in
     `tombstoneMatches`: a row carrying a different *real* alias is a deliberate distinct
     target unless the endpoint key also matches).
3. **`tombstoneMatches` falls back to the proxy key.** When a tombstoned target and a new
   target share `sshProxyEndpointKey`, re-adopt even across an alias change — same guarantee
   the alias/tuple match gives today, extended to renamed workspaces.
4. **Repo path follows the endpoint's declared root.** When `ProxyCommand` carries
   `--workdir` (or an equivalent landing-dir directive), a bound repo whose path no longer
   resolves can be re-pointed to it. Keep this opt-in/narrow: only for `ssh-config` targets,
   only when the recorded path fails an existence probe on the remote, and never for repos the
   user moved deliberately (`source === 'manual'` repos untouched).

### Non-negotiable requirements

- **Never merge distinct endpoints.** Two different ProxyCommand argv (different workspace arg,
  user, or command) are different machines even under one alias.
- **`source: 'manual'` rows untouched**, same as today (`ssh-connection-store.ts:153-159`).
- **Tombstoned aliases stay suppressed** unless explicitly re-added (`reclaimAlias`,
  `:111-123`); endpoint matching must not resurrect them via the back door.
- **Wire compatibility** (`docs/reference/remote-wire-compatibility.md`): a new optional
  `endpointKey`/`proxyEndpoint` field on `SshTarget` is additive — old servers ignore it.
- **Idempotent and bounded**: reconciliation is a map lookup per config host; no remote probing
  during import. Remote existence checks (path heal) must be lazy/connection-time, not
  import-time.
- **`generation` semantics** (`allocateSshTargetGeneration`): an in-place alias rebind is an
  update, not a re-registration — do not allocate a new generation (same rule as
  `upsertRuntimeOwnedTarget`, `ssh-connection-store.ts:74-75`), or automations fenced on the
  earlier generation lose their target.

## Rejected alternatives

- **"Re-import + existing readoption."** Covered above: alias-keyed, cannot cross an alias
  change.
- **Keep the external script.** It duplicates Orca's reconciliation in bash, must run with
  Orca stopped (daemon caches the file), and already caused one multi-instance stomping bug —
  its host matcher collapsed every `*agentic-coding-tools*` target onto the default devpod.
  The in-tree version is strictly safer: same persistence layer, same transaction, no stop
  requirement.
- **Match on resolved remote facts (probe `hostname`/workspace after connect).** Stronger
  identity but requires a live connection during import — unbounded latency and a chicken-and-egg
  with the very connect the target exists to make. A lazy variant (mark suspected-same, confirm
  on next connect, then offer merge) is a possible v2, not v1.

## Verification

- New target behavior: recreate the DevPod workspace under a new alias → `importFromSshConfig`
  run → existing target's `configHost` updated, same `id`, repos still bound, no duplicate row.
- Safety: two `Host` aliases with different ProxyCommands → no merge; a manually-deleted alias
  stays deleted; `source: 'manual'` target with matching endpoint is not adopted.
- Regression: `pnpm test src/main/ssh/ssh-connection-store` +
  `ssh-target-readoption` suites, plus a new case covering alias-change rebind.
