/**
 * cli/grammar/vlan.ts — the VLAN database lines and their show command (ARCHITECTURE-P2 §5.1, §5.4, D3; §7 W2 cli):
 * `vlan <list>` (a section, mode `config-vlan`, one stored section per VLAN of the list), `no vlan <list>`, `name`
 * inside the section, and `show vlan [brief | id <v>]`.
 *
 * Scope: the `managed-switch` capability (D5: VLAN awareness keys on the `vlan` daemon that capability brings), so
 * the P1 switch models never list these until the catalog flips. VLAN 1 and 1002–1005 exist implicitly and are
 * never stored (D3); the handler refuses to create or remove them. Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { intArg, NFOS_ONLY, wordArg } from './core-exec.js';

/** Handler ids of the vlan fragment. Shared with the runtime and handler owners — never rename. */
export const VLAN_HANDLERS = {
  configVlan: 'config.vlan',
  vlanName: 'vlan.name',
  showVlan: 'show.vlan',
} as const;

/** Capabilities of VLAN-aware bridges (D5): the switching capability that brings the `vlan` daemon. */
export const VLAN_AWARE_CAPABILITIES = Object.freeze(['managed-switch'] as const);

/** Arg name the `show vlan` handler reads its form from (`fixedArgs`): `brief` or `id`. */
export const SHOW_VLAN_FORM_ARG = 'form';

/** Longest VLAN name a `name` line accepts. */
export const VLAN_NAME_MAX_LENGTH = 32;

const H = VLAN_HANDLERS;

/** The VLAN command table. */
export const VLAN_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['vlan', '<vlans>'],
    mode: 'config',
    privilege: 15,
    help: 'Create VLANs (a number, a list or a range) and configure them',
    args: { vlans: { type: 'vlan-list', help: 'VLAN numbers or ranges, e.g. 10,20,30-35' } },
    handler: H.configVlan,
    entersMode: 'config-vlan',
    sessionEffect: 'enter-mode',
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.2.1'],
  },
  {
    path: ['name', '<name>'],
    mode: 'config-vlan',
    privilege: 15,
    help: 'Give the VLAN a name (up to 32 characters, no spaces)',
    args: { name: wordArg('VLAN name', { maxLength: VLAN_NAME_MAX_LENGTH }) },
    handler: H.vlanName,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.2.1'],
  },
  {
    path: ['show', 'vlan'],
    mode: '@exec',
    privilege: 1,
    help: 'The VLAN database: number, name, status and the access ports of each VLAN',
    handler: H.showVlan,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.2.1'],
  },
  {
    path: ['show', 'vlan', 'brief'],
    mode: '@exec',
    privilege: 1,
    help: 'One line per VLAN: number, name, status and access ports',
    handler: H.showVlan,
    fixedArgs: { [SHOW_VLAN_FORM_ARG]: 'brief' },
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.2.1'],
  },
  {
    path: ['show', 'vlan', 'id', '<vlan>'],
    mode: '@exec',
    privilege: 1,
    help: 'One VLAN by number',
    args: { vlan: intArg('VLAN number', 1, 4094) },
    handler: H.showVlan,
    fixedArgs: { [SHOW_VLAN_FORM_ARG]: 'id' },
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.2.1'],
  },
]);
