/**
 * The P0.5 members of hand-built snapshot ports and devices, derived the way the engine derives them (the P1 web
 * fixture migration, ARCHITECTURE-P1 §11, finished in ARCHITECTURE-P3 §9.2 W0 item 7). Tests that build a snapshot
 * from a catalog spec or model spread these, so their fixtures are complete `PortSnapshot`s and `DeviceSnapshot`s and
 * the web readers take the same path as for engine data.
 */
import { ROLE_TRAITS } from '@netforge/engine';
import type { DeviceModel, DeviceSnapshot, PortSnapshot, PortSpec } from '@netforge/engine';

/** Port members that come from the spec (its role, roles, encapsulation, ordinal, connector) and the role's traits. */
export type SpecPortMembers = Pick<
  PortSnapshot,
  'role' | 'allowedRoles' | 'encap' | 'ordinal' | 'virtual' | 'linkable' | 'configurable' | 'connector'
>;

export function portMembersFromSpec(spec: PortSpec): SpecPortMembers {
  const traits = ROLE_TRAITS[spec.role];
  return {
    role: spec.role,
    allowedRoles: spec.allowedRoles,
    encap: spec.encap,
    ordinal: spec.ordinal,
    virtual: traits.virtual,
    linkable: traits.linkable,
    configurable: traits.configurable,
    connector: spec.connector,
  };
}

/** Device members that come from the model; the base MAC is the ordinal-0 form of the fixtures' port MACs. */
export type ModelDeviceMembers = Pick<
  DeviceSnapshot,
  'category' | 'family' | 'variant' | 'icon' | 'capabilities' | 'cli' | 'gui' | 'hostPorts' | 'baseMac'
>;

export function deviceMembersFromModel(model: DeviceModel, baseMac = '02:00:00:00:00:00'): ModelDeviceMembers {
  return {
    category: model.category,
    family: model.family,
    variant: model.variant,
    icon: model.icon,
    capabilities: model.capabilities,
    cli: { shell: model.cli.shell, grammar: model.cli.grammar },
    gui: model.gui,
    hostPorts: model.hostPorts,
    baseMac,
  };
}
