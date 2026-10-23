import { describe, expect, it } from 'vitest'
import { orcadAssignedMachineIdentity } from './orcad-assigned-machine-identity'

describe('orcadAssignedMachineIdentity', () => {
  it('is stable for one target and differs across targets', () => {
    expect(orcadAssignedMachineIdentity('target-a')).toBe(orcadAssignedMachineIdentity('target-a'))
    expect(orcadAssignedMachineIdentity('target-a')).not.toBe(
      orcadAssignedMachineIdentity('target-b')
    )
  })

  it('stays within the lock record schema and names its provenance', () => {
    const identity = orcadAssignedMachineIdentity('target-a')
    expect(identity).toMatch(/^managed:[a-f0-9]{32}$/u)
    expect(identity.length).toBeLessThanOrEqual(255)
  })
})
