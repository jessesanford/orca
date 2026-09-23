# Fork patch ledger — jessesanford/orca vs stablyai/orca

Ledger of fork-only patches carried on top of upstream `main`. Each entry names its PR
branch, the motivation, the surface it touches, and operational notes. Keep it current when
a patch lands upstream or a new one is added.

## Branches

| Branch | Type | Commits | Purpose |
| --- | --- | --- | --- |
| `fix/headless-serve-ssh` | bugfix | `fix(serve): register SSH handlers…`, `fix(mobile): auto-connect SSH target…` | Make SSH targets usable under `orca serve` |
| `feat/ssh-target-registration-rpc` | feature | `feat(rpc): ssh.importConfig…`, `feat(rpc): ssh.removeTarget…` | Headless registration lifecycle for DevPod-managed targets |
| `feat/pairing-offer-rpc` | feature | `serve: emit both runtime and mobile pairing URLs`, `feat(rpc): pairing.createOffer…` | Operator-side client pairing without serve restart |
| `docs/ssh-target-endpoint-identity` | docs | `docs(ssh): design proposal…` | Design: rebind targets by endpoint identity |

Functional dependency: `feat/ssh-target-registration-rpc` registers methods on the SSH
surface that `fix/headless-serve-ssh` makes reachable in serve mode. Merge order:
fix → feat (the branches still compile and test independently).

## fix/headless-serve-ssh

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

## feat/pairing-offer-rpc

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

## docs/ssh-target-endpoint-identity

- `docs(ssh): design proposal — rebind targets by endpoint identity` — records why
  alias-keyed reconciliation orphans DevPod repos/worktrees on recreate, what the external
  `sync-orca-workspace.sh` compensates for, and the shape of an in-tree rebind. Proposal
  only; no code.

## Verification performed

- `pnpm tc` clean on every branch.
- `pnpm test src/main/runtime/rpc/methods/ssh.test.ts` — 12/12.
- `pnpm test src/main/runtime/rpc/methods/pairing.test.ts` — 5/5.
- `oxlint` clean on all branch-touched files.
- Live end-to-end (serve container on the built unpack): `ssh.importConfig` → `ssh.connect`
  → `repo:`-scoped standalone project → mTLS daemon probe; idempotent re-register;
  `ssh.removeTarget` leaves zero residue. `pairing.createOffer` mints both scopes with a
  scannable terminal QR and the advertised `ws://` endpoint, without restarting serve.
