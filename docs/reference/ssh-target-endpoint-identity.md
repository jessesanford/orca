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

**Principle:** the `Host` alias is a name; a *self-identifying* `ProxyCommand` is the
endpoint. "Self-identifying" means the argv carries a concrete target argument (workspace
name, instance id) so two aliases resolving to the same argv reach the same machine,
account, and filesystem — e.g. `devpod ssh --context default --user vscode sbx-ws-123`.
For generic proxy-*through* commands (`ssh -W %h:%p jumphost`,
`cloudflared access ssh --hostname %h`, `nc %h %p`, fdpass transports) the ProxyCommand only
names a connector: two blocks with byte-identical argv can reach different machines, so the
key must fold in the resolved `host|port|username` before it can claim endpoint identity.

**Which argv tokens are identity, and which are mutable.** The key is built only from tokens
that answer "which machine and account": the connector argv itself (`devpod ssh`), the
provider context (`--context default`), the account (`--user vscode`), and the positional
workspace/instance argument (`sbx-ws-123`). Tokens that answer "where do I land after
connecting" are session attributes, not identity — `--workdir`, `--command`, and other
landing-dir/entrypoint directives are *excluded* from the key so a recreate that moves the
repo path still binds, and proposal 4 then heals the recorded path. The load-bearing
assumption: the positional workspace argument is stable across a recreate (it *names* the
workspace). If a tool regenerates the workspace argument itself, no argv-based identity can
survive — that case under-merges to the status quo (orphans, same as today) and is the
documented boundary of this design.

### Proposed changes

1. **Extend `SshIdentityFields` with a proxy-endpoint key.** Add
   `sshProxyEndpointKey(target)`:
   - Self-identifying proxy argv → normalized argv tokens minus transport flags
     (`--stdio`, `-o`, `-W`, port placeholders) *and* landing-dir directives
     (`--workdir`, `--command`), so
     `devpod ssh --context default --user vscode sbx-ws-123 --workdir /x` keys on
     `devpod ssh|default|vscode|sbx-ws-123` — unchanged when the workspace is recreated at a
     new workdir.
   - Generic transport proxy → `proxyTransport|resolved host|port|username|identityFile`,
     so the key can never collide two blocks that only share a connector.
   - Only key on ProxyCommands that parse to a clean argv: `sh -c`, `env VAR=…` prefixes,
     and nontrivial quoting make "tokenization" fragile — treat unparseable snippets as
     having no proxy key (never rebind on them).
   Non-proxy targets carry **no** `sshProxyEndpointKey` — this is deliberate. Their
   `sshEndpointKey` (`host|port|username`) already exists and, per `tombstoneMatches`,
   matching it across two different real aliases must stay a non-match ("deliberately
   distinct targets"). Giving non-proxy rows a proxy key would silently re-adopt
   `prod`/`prod-admin` pairs that share `host|port|username` but differ in `IdentityFile`
   or other directives — exactly what the current code refuses.
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
   - Multiple *incoming* config hosts can also share one endpoint key (a stale devpod `Host`
     block left beside the new one). Track `processedEndpointKeys` for the pass and let the
     first config host in file order win the bind; later duplicates take the plain insert
     path. Without this, last-wins rebinding flips `configHost` every sync and violates the
     "repeat sync is a no-op" requirement.
3. **`tombstoneMatches` falls back to the proxy key — for proxy targets only.** When a
   tombstoned target and a new target share a real `sshProxyEndpointKey`, re-adopt even
   across an alias change — same guarantee the alias/tuple match gives today, extended to
   renamed workspaces. This fallback never applies to non-proxy targets: two different real
   aliases sharing `host|port|username` remain deliberately distinct, as today.
   `buildRemovedSshTargetTombstone` (`ssh-target-readoption.ts:84-97`) persists no proxy
   fields, so the tombstone schema must grow an optional `proxyEndpointKey` (computed at
   removal time) — additive, ignored by old readers, absent ⇒ no proxy fallback.
4. **Repo path follows the endpoint's declared root.** When `ProxyCommand` carries
   `--workdir` (or an equivalent landing-dir directive), a bound repo whose path no longer
   resolves can be re-pointed to it. Keep this opt-in/narrow: only for `ssh-config` targets,
   only when the recorded path fails an existence probe on the remote, and only for repos
   whose recorded path sits under the *previous* declared root — `Repo` has no provenance
   field (`source` lives on `SshTarget`, not `Repo`), so "the user moved this repo
   deliberately" is inferred from "the recorded path is outside the endpoint's landing
   root," which that containment check expresses directly.

### Non-negotiable requirements

- **Never merge distinct endpoints.** Two different ProxyCommand argv (different workspace arg,
  user, or command) are different machines even under one alias — and two *identical* generic
  transport proxies are still distinct endpoints until `host|port|username` agree. In-place
  rebind additionally requires the candidate's identity-bearing directives to agree —
  `HostName` (when present), `Port`, `User`, `IdentityFile`. The `host` field itself is
  excluded from that comparison: for no-`HostName` proxy targets it echoes the alias, which
  is the value that changed. A colliding alias must never redirect an existing target's
  repos/automations onto a different real host.
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
