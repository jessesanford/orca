# Fork patch ledger — jessesanford/orca vs stablyai/orca

Ledger of fork-only patches carried on top of upstream `main`. Each entry names its PR
branch, the motivation, the surface it touches, and operational notes. Keep it current when
a patch lands upstream or a new one is added. The 2026-10-20 absorption matrix below is the
current per-branch verdict against upstream `main`.

## Branches

| Branch | Type | Commits | Purpose | Status (2026-10-20) |
| --- | --- | --- | --- | --- |
| `fix/headless-serve-ssh` | bugfix | `fix(serve): register SSH handlers…`, `fix(mobile): auto-connect SSH target…` | Make SSH targets usable under `orca serve` | ABSORBED upstream |
| `feat/ssh-target-registration-rpc` | feature | `feat(rpc): ssh.importConfig…`, `feat(rpc): ssh.removeTarget…` | Headless registration lifecycle for DevPod-managed targets | MOSTLY ABSORBED — `hostLocal` residual on `feat/hostlocal-existing-folder` |
| `feat/pairing-offer-rpc` | feature | `serve: emit both runtime and mobile pairing URLs`, `feat(rpc): pairing.createOffer…` | Operator-side client pairing without serve restart | STILL FORK-ONLY — re-ported as `feat/pairing-createoffer` |
| `feat/pairing-createoffer` | feature | `feat(rpc): pairing.createOffer + gated dual-scope offers for headless pairing` (`e536e28c5c`) | `pairing.createOffer` re-port off upstream/main | FORK-ONLY (active port) |
| `feat/hostlocal-existing-folder` | feature | `feat(runtime): hostLocal flag for setupExistingFolder — repo:-scoped headless registration` (`6d500f1ad1`) | `repo:`-scoped headless folder registration off upstream/main | FORK-ONLY (active port) |
| `docs/ssh-target-endpoint-identity` | docs | `docs(ssh): design proposal…` | Design: rebind targets by endpoint identity | docs/absorbed |
| `docs/ssh-target-endpoint-identity-rebind` | docs/feat | pre-rebase rpc stack (`ssh.importConfig`, `ssh.removeTarget`, `pairing.createOffer`) | Stacked carrier for the endpoint-identity rebind work | docs/absorbed |
| `fix/ssh-relay-phantom-accept` | bugfix | `fix(ssh-relay): treat accepted-but-unheld relay sockets as stale, probe with handshake at bind` | Unwedge relay relaunch over stale sockets on shared-mount homes | UNDER REVIEW |
| `serve-ssh-auto-connect` | bugfix | pre-split register-handlers + auto-connect + pairing URLs | Precursor of `fix/headless-serve-ssh` + `feat/pairing-offer-rpc` | docs/absorbed |
| `serve-ssh-handlers-temp` | bugfix | v1.4.201-era handler registration temp branch | Earliest headless-SSH handler spike | docs/absorbed |

Functional dependency: `feat/ssh-target-registration-rpc` registers methods on the SSH
surface that `fix/headless-serve-ssh` makes reachable in serve mode. Merge order:
fix → feat (the branches still compile and test independently).

## fix/headless-serve-ssh

**Status: ABSORBED upstream** (2026-10-20) — see the absorption matrix.

- `fix(serve): register SSH handlers in headless serve mode` — `main-process-runtime-launch.ts`.
  `orca serve` never runs `attachMainWindowServices`, so the SSH IPC layer stayed unregistered
  and every `ssh.connect` from a paired client threw `ssh_handlers_not_registered`. Registers
  handlers with a `() => null` window getter (no renderer to broadcast to).
- `fix(mobile): auto-connect SSH target on headless mobile terminal create` —
  `orca-runtime-create-runtime-owned-mobile-session-terminal.ts` (a `@ts-nocheck` split
  file — type-check removal is tracked debt, not status quo).
  A desktop renderer connects the SSH target when a worktree opens; headless has none, so a
  mobile client creating a terminal on a disconnected target failed. Connects on demand when
  `workspace.connectionId` is set and no `SshPtyProvider` exists yet.

## feat/ssh-target-registration-rpc

**Status: MOSTLY ABSORBED** (2026-10-20) — `hostLocal` residual ported to
`feat/hostlocal-existing-folder`; see the absorption matrix.

- `feat(rpc): ssh.importConfig` — imports a `Host` block (name, user, port, proxy command,
  identity, display label) as a registered SSH target over the runtime unix socket, so an
  operator script (the broker's `register-target.py`) needs no renderer and no
  `orca-data.json` edits.
- `hostLocal` flag on `projectHostSetup.setupExistingFolder` — suppresses provider-identity
  detection (`upstream`, `repoIcon`, `gitRemoteIdentity`) so a registered repo gets standalone
  `repo:`-scoped project semantics instead of a phantom GitHub identity.
- `feat(rpc): ssh.removeTarget` — headless de-registration routed through
  `removeRegisteredSshTarget` (transport dispose, lease cleanup, browser partitions), not a
  store-row delete.
- `Store`-owned persistence: `projects`/`projectHostSetups` rows are derived from
  `state.repos`, so the RPC needs no project-row upsert.

## feat/hostlocal-existing-folder

**Status: FORK-ONLY — active port** (2026-10-20). Re-port of the one piece of
`feat/ssh-target-registration-rpc` upstream did not absorb.

- `feat(runtime): hostLocal flag for setupExistingFolder — repo:-scoped headless
  registration` (`6d500f1ad1`, single commit off upstream/main) — suppresses
  provider-identity detection (`upstream`, `repoIcon`, `gitRemoteIdentity`) so a
  headless-registered repo gets standalone `repo:`-scoped project semantics instead of
  a phantom GitHub identity. Needed when `register-target.py` registers folders as
  `repo:`-scoped projects.

## feat/pairing-offer-rpc

**Status: STILL FORK-ONLY** (2026-10-20) — re-ported as `feat/pairing-createoffer`
(`e536e28c5c`) off upstream/main; see the absorption matrix.

- `serve: emit both runtime and mobile pairing URLs` — `printServeReady` mints a primary and
  a secondary offer; `--mobile-pairing` selects which scope is primary and renders the
  terminal QR. Adds the shared pairing-scope selection and QR packaging
  (`config/packaged-runtime-node-modules.cjs`).
- `feat(rpc): pairing.createOffer` — operator mints a pairing offer over the runtime unix
  socket (`localPairing` context; unix-socket only, WS `PairingRpcContext` untouched).
  Params: `scope` (runtime|mobile, default runtime), `name`, `rotate`, `address` (advertised
  endpoint override; omitted ⇒ loopback-only `127.0.0.1` by design). Extracts terminal-QR
  rendering into `src/main/runtime/pairing-qr.ts` so both the CLI readiness path and the RPC
  share it. `dispatcher.ts`/`rpc-streaming-dispatcher.ts` now forward `localPairing` on the
  unary and streaming dispatch paths.
- Operational caveat: minted codes are durable in `orca-devices.json` (survive restarts)
  and are standing bearer credentials. `orca serve`'s own readiness output prints the
  pairing URL/QR to stdout on every start — in supervised/container deployments that
  output *is* the docker/journal log stream. Run `--no-pairing` when pairing isn't
  needed and prefer `pairing.createOffer` (returned to the caller, never printed)
  over startup minting where stdout is captured.

## feat/pairing-createoffer

**Status: FORK-ONLY — active port** (2026-10-20). Re-port of `feat/pairing-offer-rpc`
off upstream/main; nothing equivalent exists upstream.

- `feat(rpc): pairing.createOffer + gated dual-scope offers for headless pairing`
  (`e536e28c5c`, single commit off upstream/main) — `pairing.createOffer` unix-socket
  operator RPC, reach-derived minting, coalesced in-flight mints,
  rotate-revokes-relay-binding, and the `--pairing-all-scopes` `secondaryPairing`
  envelope. This is the surface the broker's pair flow consumes.

## docs/ssh-target-endpoint-identity

**Status: docs/absorbed** (2026-10-20) — recorded here; nothing left to port.

- `docs(ssh): design proposal — rebind targets by endpoint identity` — records why
  alias-keyed reconciliation orphans DevPod repos/worktrees on recreate, what the external
  `sync-orca-workspace.sh` compensates for, and the shape of an in-tree rebind. Proposal
  only; no code.

## fix/ssh-relay-phantom-accept

**Status: UNDER REVIEW** (2026-10-20) — `RelaySocketOwnership` was deleted upstream;
the verdict logic now lives in `src/main/ssh/legacy-relay/`. See the absorption matrix.

- `src/main/ssh/ssh-relay-endpoint-incumbent.ts` — `LISTEN=accepted` + a complete holder
  enumeration of zero is now `unverifiable`/`inconclusive` instead of `live`. A dead relay
  socket on a virtiofs durable-home mount phantom-accepts: `connect()` succeeds on the
  inode and dies on first write, so a bare accept is not positive evidence of life.
  `unverifiable` still permits the relaunch; the daemon arbitrates atomically at bind.
- `src/relay/relay-socket-ownership.ts` — `probeBlockedPath` no longer treats a bare
  accept as held. It writes a real `orca-relay-handshake` frame: a reply means a live
  listener (fail, never steal), `EPIPE`/`ECONNRESET` (plus existing
  `ECONNREFUSED`/`ENOENT`) means phantom accept (identity-checked unlink + retry), and
  silence or a clean close stays held. Probe timeout 500 → 1000ms to cover the
  handshake round-trip.
- Motivation: devpod durable-home `.orca-remote` socket files survive relay death and
  phantom-accept, producing the `probe ALIVE → reconnect → EPIPE` wedge loop where
  terminals hang at "Connecting…" forever.
- New `src/relay/relay-socket-ownership.test.ts` covers dead file reclaim, accept-then-
  destroy reclaim, handshake-answer refuse, silent-listener refuse, and clean-close
  refuse. `docs/reference/ssh-execution-boundary.md` documents the evidence asymmetry.

## Absorption matrix — 2026-10-20

Re-check of every fork branch against upstream `main` after the Phase 3.5 SSH/remote
rework (`e3639ef8d6`, #26483, which fixed SSH/remote at the root cause). Verdicts:

- `fix/headless-serve-ssh` — **ABSORBED upstream.** Upstream's
  `src/main/startup/headless-serve-ssh-registration.ts` registers the SSH handlers in
  serve mode — the same `ssh_handlers_not_registered` gap — so the Phase 3.5 rework
  covers both commits.
- `feat/ssh-target-registration-rpc` — **MOSTLY ABSORBED.** Upstream
  `src/main/runtime/rpc/methods/ssh.ts` serves the registration lifecycle —
  `ssh.listTargets`, `ssh.listTargetSummaries`, `ssh.listRemovedTargetLabels`,
  `ssh.listEditableTargets`, `ssh.addTarget`, `ssh.updateTarget`, `ssh.removeTarget`
  (the `ssh.target-management.v1` surface) — with `ssh:importConfig` on the renderer
  IPC side. Fork-only residual: the `hostLocal` flag on `setupExistingFolder`, now
  ported as `feat/hostlocal-existing-folder` (`6d500f1ad1`) off upstream/main.
- `feat/pairing-offer-rpc` — **STILL FORK-ONLY.** Re-ported as
  `feat/pairing-createoffer` (`e536e28c5c`) off upstream/main: `pairing.createOffer`
  unix-socket operator RPC, reach-derived minting, coalesced in-flight mints,
  rotate-revokes-relay-binding, `--pairing-all-scopes` `secondaryPairing` envelope.
- `fix/ssh-relay-phantom-accept` — **UNDER REVIEW.** `RelaySocketOwnership`
  (`src/relay/`) was deleted upstream; the verdict logic now lives in
  `src/main/ssh/legacy-relay/`. A separate investigation is deciding whether the fix
  ports to `legacy-relay`, to orcad's bind path, or is obsolete.
- `docs/ssh-target-endpoint-identity`, `docs/ssh-target-endpoint-identity-rebind`,
  `serve-ssh-auto-connect`, `serve-ssh-handlers-temp` — **docs/absorbed.** Pre-rebase
  carriers whose content is recorded here or superseded upstream; nothing left to port.

### Provenance note

The broker dist running today reported build `0.1.0+7a87e80a2a8a` /
`0.1.0+650039fdb4a9`. Neither hash resolves as a git object — the dist predates the
rebase. Rebuild source: `feat/pairing-createoffer` (createOffer), plus
`feat/hostlocal-existing-folder` if `register-target.py` needs `hostLocal`.

The matrix verdicts above come from branch/tree inspection (upstream file and method
inventory); the test results below predate it and cover the original pre-rebase
branches.

## Verification performed

- `pnpm tc` clean on every branch.
- `pnpm test src/main/runtime/rpc/methods/ssh.test.ts` — 12/12.
- `pnpm test src/main/runtime/rpc/methods/pairing.test.ts` — 5/5.
- `pnpm test src/relay/relay-socket-ownership.test.ts src/main/ssh/ssh-relay-endpoint-incumbent.test.ts` — 36/36.
- `pnpm test src/main/ssh/` — 181 files, 2,731 tests, all pass.
- `oxlint` clean on all branch-touched files.
- Live end-to-end (serve container on the built unpack): `ssh.importConfig` → `ssh.connect`
  → `repo:`-scoped standalone project → mTLS daemon probe; idempotent re-register;
  `ssh.removeTarget` leaves zero residue. `pairing.createOffer` mints both scopes with a
  scannable terminal QR and the advertised `ws://` endpoint, without restarting serve.
