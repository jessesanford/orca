import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { resolveAdvertisedPairingEndpoint } from '../runtime/pairing-endpoint'
import { renderTerminalPairingQr } from '../runtime/pairing-qr'
import { notifyServeSupervisorReady } from '../serve-update-handoff'
import { mainProcessState as state } from './main-process-state'
import { getServeOptions, type ServeOptions } from './serve-options'

export { getServeOptions, type ServeOptions }

export function getBundledWebClientRoot(): string | undefined {
  const appPath = app.getAppPath()
  const roots = [
    join(appPath, 'out', 'web'),
    // Why: unpacked electron-vite entrypoints set appPath to out/main, next to the web bundle.
    join(appPath, '..', 'web')
  ]
  return roots.find((root) => existsSync(join(root, 'web-index.html')))
}

export async function printServeReady(options: ServeOptions): Promise<void> {
  const runtime = state.runtime
  const runtimeRpc = state.runtimeRpc
  if (!runtime || !runtimeRpc) {
    throw new Error('Runtime server must be initialized before printing serve readiness')
  }
  if (options.recipeJson) {
    if (!options.projectRoot) {
      throw new Error('--serve-recipe-json requires --serve-project-root')
    }
    if (!isAbsolute(options.projectRoot)) {
      throw new Error(`--serve-project-root must be absolute: ${options.projectRoot}`)
    }
    if (!statSync(options.projectRoot).isDirectory()) {
      throw new Error(`--serve-project-root must be a directory: ${options.projectRoot}`)
    }
  }
  const boundEndpoint = runtimeRpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ternary already narrows to the union's two literals; the assertion only names the union.
  const primaryScope = (options.mobilePairing ? 'mobile' : 'runtime') as 'mobile' | 'runtime'
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: complementary literal of primaryScope; same verified invariant.
  const secondaryScope = (options.mobilePairing ? 'runtime' : 'mobile') as 'mobile' | 'runtime'
  const pairing = options.noPairing
    ? ({
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      } as const)
    : runtimeRpc.createPairingOffer({
        address: options.pairingAddress,
        name: `${options.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`,
        scope: primaryScope
      })
  // Why: a second standing bearer credential is opt-in only — an operator who
  // asked for one scope must not silently mint the other (the runtime-scope
  // credential is strictly more powerful than a mobile one). Never minted in
  // recipe-json mode: the URL has no channel to reach anyone, so the credential
  // would persist unseen in the device registry.
  const secondaryPairing =
    options.pairingAllScopes && !options.recipeJson && pairing.available
      ? runtimeRpc.createPairingOffer({
          address: options.pairingAddress,
          name: `${options.mobilePairing ? 'CLI' : 'Mobile'} ${new Date().toLocaleDateString()}`,
          scope: secondaryScope,
          rotate: true
        })
      : null
  const pairingQr =
    pairing.available && options.mobilePairing
      ? await renderTerminalPairingQr(pairing.pairingUrl)
      : null
  await state.serveReadinessPublisher.publish(
    {
      runtimeId: runtime.getRuntimeId(),
      boundEndpoint,
      advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
      // Why: the WSL reconciliation barrier fails open, so 'pending' warns a WSL PTY launch may still race a repair.
      managedWslCliReconciliation: state.managedWslCliReconciliationStatus,
      pairing: pairing.available
        ? {
            available: true,
            url: pairing.pairingUrl,
            endpoint: pairing.endpoint,
            deviceId: pairing.deviceId,
            webClientUrl: pairing.webClientUrl,
            scope: primaryScope,
            qr: pairingQr
          }
        : pairing,
      // Why: the second credential travels inside the readiness envelope —
      // a raw console.log line corrupts --json output and escapes the audit trail.
      ...(secondaryPairing
        ? {
            secondaryPairing: secondaryPairing.available
              ? {
                  available: true,
                  url: secondaryPairing.pairingUrl,
                  endpoint: secondaryPairing.endpoint,
                  deviceId: secondaryPairing.deviceId,
                  webClientUrl: secondaryPairing.webClientUrl,
                  scope: secondaryScope,
                  qr: null
                }
              : secondaryPairing
          }
        : {})
    },
    options.recipeJson
      ? { mode: 'recipe-json', projectRoot: options.projectRoot! }
      : { mode: options.json ? 'json' : 'human' }
  )
  notifyServeSupervisorReady(runtime.getRuntimeId())
}
