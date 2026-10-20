import type { DeviceRegistry, DeviceScope } from '../device-registry'
import type {
  PairingCreateOfferParams,
  PairingCreateOfferResult
} from '../../../shared/mobile-relay-credential-contract'
import type { RuntimePairingReach } from '../../../shared/runtime-pairing-reach'
import { classifyRemotePairingHostname } from '../../../shared/remote-pairing-address'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../network-exposure-guidance'
import {
  resolveAdvertisedPairingEndpoint,
  resolveAdvertisedPairingHostname
} from '../pairing-endpoint'
import { renderServePairingQr } from '../../server/serve-pairing-output'
import { pairingUnavailable, type DirectPairingOffer } from './runtime-rpc-pairing-types'
import type { RuntimeDeviceGrant } from '../rpc/rpc-caller-scope'

// Why structural: the minter only needs the mint + widen + registry surface of
// the RPC server; keeping the dependency narrow keeps this testable in isolation.
export type LocalPairingOfferServer = {
  ensureNetworkExposure(): Promise<void>
  getDeviceRegistry(): DeviceRegistry | null
  getWebSocketEndpoint(): string | null
  createPairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
    scope?: DeviceScope
    reach?: RuntimePairingReach
    grants?: readonly RuntimeDeviceGrant[]
  }): DirectPairingOffer
}

// Why: unix-socket operator path (headless brokers). Unlike the startup
// readiness offers this is minted on demand — no serve restart, so a pairing
// flow never bounces connected SSH targets. Identical in-flight calls share one
// registry write so a churning caller cannot spawn a rotate storm.
export class RuntimeRpcLocalPairingOffer {
  private inFlight: {
    key: string
    request: Promise<PairingCreateOfferResult>
  } | null = null

  constructor(private readonly server: LocalPairingOfferServer) {}

  createOffer(params: PairingCreateOfferParams): Promise<PairingCreateOfferResult> {
    const key = JSON.stringify({
      scope: params.scope ?? 'runtime',
      name: params.name ?? null,
      rotate: params.rotate === true,
      address: params.address ?? null
    })
    if (this.inFlight?.key === key) {
      return this.inFlight.request
    }
    const request = this.createOfferSerial(params)
    this.inFlight = { key, request }
    void request.then(
      () => {
        if (this.inFlight?.request === request) {
          this.inFlight = null
        }
      },
      () => {
        if (this.inFlight?.request === request) {
          this.inFlight = null
        }
      }
    )
    return request
  }

  private async createOfferSerial(
    params: PairingCreateOfferParams
  ): Promise<PairingCreateOfferResult> {
    const scope = params.scope ?? 'runtime'
    // Why: STA-2370 — reach is derived from the endpoint the offer actually
    // advertises, never assumed. A loopback address must not widen the
    // listener; an off-host address must not mint before the listener can
    // serve it, or the URL is dead on arrival.
    const advertisedHostname = resolveAdvertisedPairingHostname(params.address)
    const thisComputerOnly =
      advertisedHostname === null ||
      classifyRemotePairingHostname(advertisedHostname) === 'loopback'
    if (!thisComputerOnly) {
      // Why: validate-then-widen — an unresolvable advertisement must fail here rather than
      // move the listener off loopback and then return invalid_advertised_endpoint.
      const bound = this.server.getWebSocketEndpoint()
      if (!bound) {
        return pairingUnavailable(
          'websocket_unavailable',
          'WebSocket pairing is unavailable. Inspect preceding runtime errors and choose an unused --port if the listener failed.'
        )
      }
      const advertised = resolveAdvertisedPairingEndpoint(bound, params.address)
      if (!advertised.ok) {
        return pairingUnavailable(advertised.reason, advertised.guidance)
      }
      try {
        await this.server.ensureNetworkExposure()
      } catch (error) {
        console.error(
          '[runtime] Network exposure failed while creating an operator pairing offer:',
          error
        )
        return pairingUnavailable('network_exposure_failed', NETWORK_EXPOSURE_FAILED_GUIDANCE)
      }
    }
    const registry = this.server.getDeviceRegistry()
    const pendingBefore = registry?.getPendingDevice(scope) ?? null
    // Why: an operator-supplied name must not be silently dropped when a
    // pending credential is reused — the label is the only audit handle.
    if (params.name && !params.rotate && pendingBefore && pendingBefore.name !== params.name) {
      try {
        registry?.setPendingDeviceName(pendingBefore.deviceId, params.name)
      } catch (error) {
        console.error('[runtime] Failed to persist the pending device name:', error)
      }
    }
    const offer = this.server.createPairingOffer({
      address: params.address,
      name: params.name ?? `Operator ${new Date().toLocaleDateString()}`,
      rotate: params.rotate,
      scope,
      reach: thisComputerOnly ? 'this-computer' : 'network'
    })
    if (!offer.available) {
      return { available: false, reason: offer.reason, guidance: offer.guidance }
    }
    return {
      available: true,
      pairingUrl: offer.pairingUrl,
      endpoint: offer.endpoint,
      deviceId: offer.deviceId,
      webClientUrl: offer.webClientUrl,
      scope,
      pendingAction:
        params.rotate && pendingBefore
          ? 'rotated'
          : pendingBefore && pendingBefore.deviceId === offer.deviceId
            ? 'reused'
            : 'created',
      qr: scope === 'mobile' ? await renderServePairingQr(offer.pairingUrl) : null
    }
  }
}
