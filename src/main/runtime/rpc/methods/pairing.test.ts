import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { LocalPairingRpcContext, PairingRpcContext } from '../core'
import { PAIRING_METHODS } from './pairing'

function dispatchPairing(
  method: string,
  params: unknown,
  pairing: PairingRpcContext | undefined,
  localPairing?: LocalPairingRpcContext
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: PAIRING_METHODS
    })
    void dispatcher.dispatchStreaming(
      { id: 'request-1', authToken: '', method, params },
      (response) => resolve(JSON.parse(response) as Record<string, unknown>),
      { pairing, localPairing }
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
        pairing
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
          pairing
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    await expect(
      dispatchPairing(
        'pairing.getEndpoints',
        { installReqId: 'status-1', basisConnId: 'injected' },
        pairing
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(pairing.provisionRelay).not.toHaveBeenCalled()
    expect(pairing.getEndpoints).not.toHaveBeenCalled()
  })

  it('mints an operator pairing offer through the unix-socket context', async () => {
    const createOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair?code=abc',
      endpoint: 'ws://10.0.0.1:6768',
      deviceId: 'dev-1',
      webClientUrl: null,
      scope: 'mobile',
      pendingAction: 'rotated',
      qr: 'QR-ART'
    })

    await expect(
      dispatchPairing('pairing.createOffer', { scope: 'mobile', rotate: true }, undefined, {
        createOffer
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { pairingUrl: 'orca://pair?code=abc', scope: 'mobile', qr: 'QR-ART' }
    })
    expect(createOffer).toHaveBeenCalledWith({ scope: 'mobile', rotate: true })
  })

  it('reports unavailable when the operator pairing context is absent', async () => {
    await expect(dispatchPairing('pairing.createOffer', {}, undefined)).resolves.toMatchObject({
      ok: false
    })
  })

  it('rejects malformed createOffer params', async () => {
    const createOffer = vi.fn()
    for (const bad of [
      { scope: 'satellite' },
      { name: '' },
      { name: 'evil\ninjected' },
      { name: 'evil\x1b[31meset' },
      { rotate: 'yes' },
      { unexpected: true }
    ]) {
      await expect(
        dispatchPairing('pairing.createOffer', bad, undefined, { createOffer })
      ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    expect(createOffer).not.toHaveBeenCalled()
  })
})
