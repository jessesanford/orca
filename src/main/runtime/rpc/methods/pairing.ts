import { defineMethod } from '../core'
import {
  PairingCreateOfferParamsSchema,
  PairingGetEndpointsParamsSchema,
  PairingProvisionRelayParamsSchema
} from '../../../../shared/mobile-relay-credential-contract'

export const PAIRING_METHODS = [
  defineMethod({
    name: 'pairing.getEndpoints',
    params: PairingGetEndpointsParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.getEndpoints(params)
    }
  }),
  defineMethod({
    name: 'pairing.provisionRelay',
    params: PairingProvisionRelayParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.provisionRelay(params)
    }
  }),
  defineMethod({
    name: 'pairing.createOffer',
    params: PairingCreateOfferParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.localPairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.localPairing.createOffer(params)
    }
  })
]
