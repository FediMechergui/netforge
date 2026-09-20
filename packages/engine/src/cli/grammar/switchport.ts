/**
 * cli/grammar/switchport.ts — `switchport` / `no switchport` on Ethernet ports of bridging devices (ARCHITECTURE-P1
 * D3, §3.10, §6).
 *
 * `no switchport` asks for the routed role and `switchport` for the switched role; a port whose `allowedRoles`
 * lack the target answers `CLI_MESSAGES.roleLocked` (an NF-C2960 port). The line is stored as a stored negation
 * (`no switchport`), so the routed role survives save and reload; the device runtime performs the role change
 * (address withdrawal, link bounce, `portsVersion`). Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { kindsPort, NFOS_ONLY } from './core-exec.js';

/** Handler ids of the switchport fragment. */
export const SWITCHPORT_HANDLERS = {
  ifSwitchport: 'if.switchport',
} as const;

/** The switchport command table. */
export const SWITCHPORT_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['switchport'],
    mode: 'config-if',
    privilege: 15,
    help: 'Bridge this port (no switchport makes it a routed interface)',
    handler: SWITCHPORT_HANDLERS.ifSwitchport,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: ['switching'],
    portRequires: { kinds: ['ethernet'], roles: ['switched', 'routed'] },
    since: 'P0.5',
    objectives: ['CCNA2.4.1'],
  },
]);
