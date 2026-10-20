import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PairingCreateOfferResult } from '../../../../shared/mobile-relay-credential-contract'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { PAIRING_METHODS } from './pairing'

function dispatchPairing(
  method: string,
  params: unknown,
  options: Pick<RpcDispatchStreamingOptions, 'localPairing' | 'pairing'>
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const runtime = { getRuntimeId: () => 'test-runtime' }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Pairing handlers use the supplied pairing context; the envelope reads only getRuntimeId.
      runtime: runtime as OrcaRuntimeService,
      methods: PAIRING_METHODS
    })
    void dispatcher.dispatchStreaming(
      { id: 'request-1', authToken: '', method, params },
      (response) => resolve(JSON.parse(response) as Record<string, unknown>),
      options
    )
  })
}

describe('pairing RPC methods', () => {
  it('passes only phone-owned credential material to the server-bound provider', async () => {
    const provisionRelay = vi.fn().mockResolvedValue({
      v: 1,
      reqId: 'install-1',
      authorizationMode: 'authenticated-direct',
      currentVersion: 1,
      resumeExpiresAt: Date.now() + 60_000
    })
    const pairing = { getEndpoints: vi.fn(), provisionRelay }

    await expect(
      dispatchPairing(
        'pairing.provisionRelay',
        { reqId: 'install-1', newResumeTokenHash: 'A'.repeat(43) },
        { pairing }
      )
    ).resolves.toMatchObject({ ok: true })
    expect(provisionRelay).toHaveBeenCalledWith({
      reqId: 'install-1',
      newResumeTokenHash: 'A'.repeat(43)
    })
  })

  it('rejects caller-selected identity and authorization metadata', async () => {
    const pairing = { getEndpoints: vi.fn(), provisionRelay: vi.fn() }

    for (const injected of [
      { relayDeviceId: 'attacker-device' },
      { authorization: { mode: 'relay-basis', basisConnId: 'attacker-basis' } },
      { directAuthId: 'attacker-direct' },
      { acceptedCredentialVersion: 99 }
    ]) {
      await expect(
        dispatchPairing(
          'pairing.provisionRelay',
          { reqId: 'install-1', newResumeTokenHash: 'A'.repeat(43), ...injected },
          { pairing }
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    await expect(
      dispatchPairing(
        'pairing.getEndpoints',
        { installReqId: 'status-1', basisConnId: 'injected' },
        { pairing }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(pairing.provisionRelay).not.toHaveBeenCalled()
    expect(pairing.getEndpoints).not.toHaveBeenCalled()
  })

  it('mints an operator pairing offer through the unix-socket context', async () => {
    const offer: PairingCreateOfferResult = {
      available: true,
      pairingUrl: 'orca://pair#token',
      endpoint: 'ws://127.0.0.1:6768',
      deviceId: 'device-1',
      webClientUrl: null,
      scope: 'mobile',
      pendingAction: 'created',
      qr: null
    }
    const localPairing = { createOffer: vi.fn().mockResolvedValue(offer) }
    const pairing = { getEndpoints: vi.fn(), provisionRelay: vi.fn() }

    await expect(
      dispatchPairing(
        'pairing.createOffer',
        { scope: 'mobile', rotate: true },
        { pairing, localPairing }
      )
    ).resolves.toMatchObject({ ok: true, result: offer })
    expect(localPairing.createOffer).toHaveBeenCalledWith({ scope: 'mobile', rotate: true })
    expect(pairing.provisionRelay).not.toHaveBeenCalled()
  })

  it('refuses offer minting without the unix-socket pairing context', async () => {
    const pairing = { getEndpoints: vi.fn(), provisionRelay: vi.fn() }

    await expect(
      dispatchPairing('pairing.createOffer', { scope: 'mobile' }, { pairing })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_error', message: 'pairing_context_unavailable' }
    })
  })

  it('rejects malformed createOffer params before reaching the minter', async () => {
    const localPairing = { createOffer: vi.fn() }
    const pairing = { getEndpoints: vi.fn(), provisionRelay: vi.fn() }

    for (const malformed of [
      { scope: 'satellite' },
      { name: '' },
      { rotate: 'yes' },
      { unexpected: true }
    ]) {
      await expect(
        dispatchPairing('pairing.createOffer', malformed, { pairing, localPairing })
      ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    expect(localPairing.createOffer).not.toHaveBeenCalled()
  })
})
