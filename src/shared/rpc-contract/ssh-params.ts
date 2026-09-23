import { z } from 'zod'
import { OptionalBoolean } from './rpc-param-primitives'

export const SshTarget = z.object({
  targetId: z.string().min(1)
})

export const SshImportConfig = z.object({
  reAdopt: OptionalBoolean
})
