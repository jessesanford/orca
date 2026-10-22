import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { resolveAdvertisedPairingEndpoint } from '../runtime/pairing-endpoint'
import { assertServeProjectRoot, renderServePairingQr } from './serve-pairing-output'
import type { ServeReadiness, ServeReadinessOutput } from './serve-readiness'

/** Endpoint and pairing-offer fields shared by the Electron serve host and orcad. */
export async function buildServePairingReadiness(
  options: {
    pairingAddress?: string | null
    noPairing?: boolean
    mobilePairing?: boolean
    pairingAllScopes?: boolean
    grantDesktopControl?: boolean
  },
  rpc: Pick<OrcaRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
): Promise<
  Pick<ServeReadiness, 'boundEndpoint' | 'advertisedEndpoint' | 'pairing' | 'secondaryPairing'>
> {
  const boundEndpoint = rpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  const offer = options.noPairing
    ? ({
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      } as const)
    : rpc.createPairingOffer({
        address: options.pairingAddress,
        name: `${options.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`,
        scope: options.mobilePairing ? 'mobile' : 'runtime',
        grants: options.grantDesktopControl ? ['desktop-control'] : []
      })

  // Why: a second standing bearer credential is opt-in only — an operator who
  // asked for one scope must not silently mint the other (the runtime-scope
  // credential is strictly more powerful than a mobile one). recipe-json mode
  // refuses --pairing-all-scopes at option validation, before any mint.
  const secondaryScope = options.mobilePairing ? 'runtime' : 'mobile'
  const secondaryOffer =
    options.pairingAllScopes && offer.available
      ? rpc.createPairingOffer({
          address: options.pairingAddress,
          name: `${options.mobilePairing ? 'CLI' : 'Mobile'} ${new Date().toLocaleDateString()}`,
          scope: secondaryScope
        })
      : null

  return {
    boundEndpoint,
    advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
    pairing: offer.available
      ? {
          available: true,
          url: offer.pairingUrl,
          endpoint: offer.endpoint,
          deviceId: offer.deviceId,
          webClientUrl: offer.webClientUrl,
          scope: options.mobilePairing ? 'mobile' : 'runtime',
          qr: options.mobilePairing ? await renderServePairingQr(offer.pairingUrl) : null
        }
      : offer,
    // Why: the second credential travels inside the readiness envelope —
    // a raw console.log line corrupts --json output and escapes the audit trail.
    ...(secondaryOffer
      ? {
          secondaryPairing: secondaryOffer.available
            ? {
                available: true as const,
                url: secondaryOffer.pairingUrl,
                endpoint: secondaryOffer.endpoint,
                deviceId: secondaryOffer.deviceId,
                webClientUrl: secondaryOffer.webClientUrl,
                scope: secondaryScope,
                qr: null
              }
            : secondaryOffer
        }
      : {})
  }
}

export function servePublishMode(options: {
  recipeJson?: boolean
  projectRoot?: string | null
  json?: boolean
}): ServeReadinessOutput {
  return options.recipeJson && options.projectRoot
    ? { mode: 'recipe-json', projectRoot: assertServeProjectRoot(options.projectRoot) }
    : { mode: options.json ? 'json' : 'human' }
}
