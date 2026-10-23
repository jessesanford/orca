/**
 * The machine identity a managing client assigns a host for orcad's instance lock.
 *
 * A host whose OS supplies no machine identity (a container without `/etc/machine-id`) cannot
 * otherwise prove its own previous boot wrote a stale lock record, so on a possibly-shared data
 * root every start after a restart is refused forever. The key derives from the target's
 * persistent registration id: the same host reconnecting — after a reboot or a container
 * recreate — records the same machine, while a genuinely different machine never shares it.
 */
import { createHash } from 'node:crypto'

export function orcadAssignedMachineIdentity(targetId: string): string {
  const key = createHash('sha256').update(`orcad-machine:${targetId}`).digest('hex')
  return `managed:${key.slice(0, 32)}`
}
