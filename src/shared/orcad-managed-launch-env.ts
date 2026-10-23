/**
 * Set only by a client's managed launch. Enables idle exit and names the host's activation
 * fence, so an update or rollback in flight keeps the server up. User-started servers never
 * carry it. Dependency-free so the orcad launcher can read it.
 */
export const ORCAD_MANAGED_ACTIVATION_ROOT_ENV = 'ORCA_ORCAD_MANAGED_ACTIVATION_ROOT'

/**
 * Set only by a client's managed launch: the machine identity the client assigns this host.
 * Hosts whose OS supplies none (a container without `/etc/machine-id`) otherwise cannot prove a
 * previous boot's lock holder was theirs, so every start after a restart is refused on a
 * possibly-shared data root. The OS identity always wins when present.
 */
export const ORCAD_MACHINE_IDENTITY_ENV = 'ORCA_ORCAD_MACHINE_IDENTITY'
