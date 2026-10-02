/**
 * device.extended-logging — [S25] the extended-logging default of a P3 world (ARCHITECTURE-P3 D2, D20, §3.7 step 8,
 * §4.3, §4.4; §7 W2 device, approved items), through the W1 `emitLog` seam:
 *  - at boot completion a start log (`SYS`, severity 5, mnemonic `BOOTED`);
 *  - on a port's oper change, a link log (`LINK`, 3, `UPDOWN`; physical ports, when the carrier changed and not for an
 *    administrative shutdown, which the P1 admin log already reports) then a line-protocol log (`LINEPROTO`, 5,
 *    `UPDOWN`; every port, once per change — an SVI logs its line protocol only);
 *  - a configuration log (`SYS`, 5, `CONFIGURED`) for typed or configure-seam lines that changed the running
 *    configuration, once per source and instant; never for the boot replay or a daemon's `configLine` action.
 * Only in P3 worlds and only on the models that take P3's network defaults (routers and managed switches with the
 * NF-OS CLI, the controller): a P1 or P2 world, a host, a home router or an access point never logs them, and the logs
 * every profile already had (the P1 admin-state log) are unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import {
  EXTENDED_LOG_SEVERITY,
  FACILITY_LINEPROTO,
  LINK_LOG_SEVERITY,
  LOG_MNEMONIC_BOOTED,
  LOG_MNEMONIC_CONFIGURED,
  LOG_MNEMONIC_UPDOWN,
  configurationChangedMessage,
  extendedLoggingDefault,
  extendedLoggingModel,
  lineProtocolMessage,
  linkStateMessage,
  systemStartedMessage,
} from '../src/device/device.js';
import { createStagedSimulation } from './staged.world.js';

type Log = Extract<TraceEvent, { kind: 'log' }>;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/** R1 (NF-2911) Gi0/0 ↔ SW1 (NF-C2960) Gi0/1; PC1 on SW1 Fa0/1; SW1 Vlan1 addressed and up. */
function world(profile: DefaultsProfile): { sim: Simulation; logs: () => Log[]; link: string } {
  const sim = createStagedSimulation({ seed: 9, stage: 'P3', profile });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], ['interface GigabitEthernet0/0', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown']]) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1'], ['interface Vlan1', ' ip address 10.0.0.2 255.255.255.0', ' no shutdown']]) });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 10.0.0.10 255.255.255.0']]) });
  const link = sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  let cursor = 0;
  const logs = (): Log[] => {
    const r = sim.trace(cursor);
    cursor = r.next;
    return r.events.filter((e): e is Log => e.kind === 'log');
  };
  return { sim, logs, link };
}

const of = (logs: readonly Log[], device: DeviceId): Log[] => logs.filter((l) => l.device === device);
const shape = (l: Log) => (l.mnemonic === undefined ? `${l.facility}-${l.severity}: ${l.message}` : `${l.facility}-${l.severity}-${l.mnemonic}: ${l.message}`);
const extended = (l: Log): boolean => l.mnemonic !== undefined || l.facility === FACILITY_LINEPROTO;

describe('the pure pieces', () => {
  it('original wording, the §3.7 severities and mnemonics', () => {
    expect(LINK_LOG_SEVERITY).toBe(3);
    expect(EXTENDED_LOG_SEVERITY).toBe(5);
    expect(FACILITY_LINEPROTO).toBe('LINEPROTO');
    expect(LOG_MNEMONIC_UPDOWN).toBe('UPDOWN');
    expect([LOG_MNEMONIC_BOOTED, LOG_MNEMONIC_CONFIGURED]).toEqual(['BOOTED', 'CONFIGURED']);
    expect(linkStateMessage('GigabitEthernet0/2', false)).toBe('Interface GigabitEthernet0/2: the link is down');
    expect(lineProtocolMessage('GigabitEthernet0/2', true)).toBe('Interface GigabitEthernet0/2: line protocol is up');
    expect(systemStartedMessage('NF-2911')).toBe('The system has started (NF-2911).');
    expect(configurationChangedMessage()).toBe('Configuration changed from the console.');
    expect(configurationChangedMessage({ via: 'restconf', user: 'admin', address: '10.0.99.10' })).toBe('Configuration changed over RESTCONF by admin from 10.0.99.10.');
    expect(configurationChangedMessage({ via: 'restconf' })).toBe('Configuration changed over RESTCONF.');
  });

  it('P3 worlds only; routers and managed switches with the NF-OS CLI and the controller only', () => {
    expect(['P1', 'P2', 'P3'].map((p) => extendedLoggingDefault(p as DefaultsProfile))).toEqual([false, false, true]);
    const sim = createStagedSimulation({ seed: 1, stage: 'P3' });
    const take = (type: string): boolean => extendedLoggingModel(sim.catalog.get(type)!);
    expect(['router.nf2911', 'router.nf4331', 'switch.nfc2960', 'mlswitch.nfc3650-24', 'wlc.nfwlc9800'].map(take)).toEqual([true, true, true, true, true]);
    expect(['pc.nfpc', 'wrouter.nfhome', 'ap.nfap-lw', 'hub.nfhub4', 'bridge.nfbr2', 'csu.nfcsu'].map(take)).toEqual([false, false, false, false, false, false]);
  });
});

describe('a P3 world logs the extended default', () => {
  it('boot: the start log, then each port coming up: link, then line protocol; an SVI logs its line protocol only; a host logs nothing', () => {
    const { sim, logs } = world('P3');
    sim.runFor(70 * SEC);
    const all = logs();
    const r1 = of(all, 'r1').filter(extended).map(shape);
    expect(r1).toEqual([
      'SYS-5-BOOTED: The system has started (NF-2911).',
      'LINK-3-UPDOWN: Interface GigabitEthernet0/0: the link is up',
      'LINEPROTO-5-UPDOWN: Interface GigabitEthernet0/0: line protocol is up',
    ]);
    const sw1 = of(all, 'sw1').filter(extended).map(shape);
    expect(sw1[0]).toBe('SYS-5-BOOTED: The system has started (NF-C2960).');
    for (const port of ['GigabitEthernet0/1', 'FastEthernet0/1']) {
      const link = sw1.indexOf(`LINK-3-UPDOWN: ${linkStateMessage(port, true)}`);
      const line = sw1.indexOf(`LINEPROTO-5-UPDOWN: ${lineProtocolMessage(port, true)}`);
      expect(link).toBeGreaterThan(0);
      expect(line).toBe(link + 1);
    }
    expect(sw1).toContain(`LINEPROTO-5-UPDOWN: ${lineProtocolMessage('Vlan1', true)}`);
    expect(sw1).not.toContain(`LINK-3-UPDOWN: ${linkStateMessage('Vlan1', true)}`);
    expect(sw1.filter((s) => s.startsWith('LINK-'))).toHaveLength(2);
    expect(of(all, 'pc1').filter(extended)).toEqual([]);
    // every extended log carries its mnemonic; the boot replay of the startup configuration logs no configuration
    expect(all.filter(extended).every((l) => l.mnemonic !== undefined)).toBe(true);
    expect(all.filter((l) => l.mnemonic === LOG_MNEMONIC_CONFIGURED)).toEqual([]);
  });

  it('a cable cut: link down then line protocol down on both ends (§3.7 step 8)', () => {
    const { sim, logs, link } = world('P3');
    sim.runFor(70 * SEC);
    logs();
    sim.removeLink(link);
    sim.runFor(SEC);
    const got = logs();
    expect(of(got, 'r1').map(shape)).toEqual([
      'LINK-3-UPDOWN: Interface GigabitEthernet0/0: the link is down',
      'LINEPROTO-5-UPDOWN: Interface GigabitEthernet0/0: line protocol is down',
    ]);
    expect(of(got, 'sw1').filter((l) => l.message.includes('GigabitEthernet0/1')).map(shape)).toEqual([
      'LINK-3-UPDOWN: Interface GigabitEthernet0/1: the link is down',
      'LINEPROTO-5-UPDOWN: Interface GigabitEthernet0/1: line protocol is down',
    ]);
  });

  it('shutdown: the P1 admin log stands for the link log; line protocol down; no shutdown: link and line protocol up', () => {
    const { sim, logs } = world('P3');
    sim.runFor(70 * SEC);
    logs();
    expect(sim.configure('r1', ['interface GigabitEthernet0/0', 'shutdown']).lines.every((l) => l.ok)).toBe(true);
    sim.runFor(SEC);
    expect(of(logs(), 'r1').map(shape)).toEqual([
      'LINK-3: Interface GigabitEthernet0/0 administratively down',
      'LINEPROTO-5-UPDOWN: Interface GigabitEthernet0/0: line protocol is down',
      'SYS-5-CONFIGURED: Configuration changed from the console.',
    ]);
    expect(sim.configure('r1', ['interface GigabitEthernet0/0', 'no shutdown']).lines.every((l) => l.ok)).toBe(true);
    sim.runFor(5 * SEC);
    const up = of(logs(), 'r1').map(shape);
    expect(up[0]).toBe('LINK-3: Interface GigabitEthernet0/0 administratively enabled');
    expect(up).toContain('LINK-3-UPDOWN: Interface GigabitEthernet0/0: the link is up');
    expect(up.indexOf('LINEPROTO-5-UPDOWN: Interface GigabitEthernet0/0: line protocol is up')).toBe(up.indexOf('LINK-3-UPDOWN: Interface GigabitEthernet0/0: the link is up') + 1);
    expect(up.filter((s) => s.startsWith('SYS-5-CONFIGURED'))).toHaveLength(1);
  });

  it('configuration: one log per source and instant; none when nothing changed; none for a daemon line', () => {
    const { sim, logs } = world('P3');
    sim.runFor(70 * SEC);
    logs();
    expect(sim.configure('r1', ['interface GigabitEthernet0/1', 'description uplink', 'interface Serial0/0/0', 'description wan']).lines.every((l) => l.ok)).toBe(true);
    const first = of(logs(), 'r1').filter((l) => l.mnemonic === LOG_MNEMONIC_CONFIGURED);
    expect(first.map(shape)).toEqual(['SYS-5-CONFIGURED: Configuration changed from the console.']);
    // the same lines again change nothing: no log
    sim.runFor(SEC);
    expect(sim.configure('r1', ['interface GigabitEthernet0/1', 'description uplink']).lines.every((l) => l.ok)).toBe(true);
    expect(of(logs(), 'r1').filter((l) => l.mnemonic === LOG_MNEMONIC_CONFIGURED)).toEqual([]);
    // a change at a later instant logs again
    expect(sim.configure('r1', ['interface GigabitEthernet0/1', 'description core uplink']).lines.every((l) => l.ok)).toBe(true);
    expect(of(logs(), 'r1').filter((l) => l.mnemonic === LOG_MNEMONIC_CONFIGURED)).toHaveLength(1);
    // the configure seam names its origin (D21), separately from the console at the same instant
    const r1 = sim.device('r1')!;
    const origin = { via: 'restconf' as const, user: 'admin', address: '10.0.0.10' };
    expect(r1.applyConfigLine([['interface', 'GigabitEthernet0/1']], ['description', 'api'], false, origin)).toEqual({ ok: true });
    expect(r1.applyConfigLine([['interface', 'GigabitEthernet0/1']], ['description', 'api two'], false, origin)).toEqual({ ok: true });
    expect(of(logs(), 'r1').filter((l) => l.mnemonic === LOG_MNEMONIC_CONFIGURED).map(shape)).toEqual([
      'SYS-5-CONFIGURED: Configuration changed over RESTCONF by admin from 10.0.0.10.',
    ]);
    // a daemon's own configLine action (eth-switch's sticky MACs) is not a configuration by a user
    const sw1 = sim.device('sw1')!;
    sw1.applyActions('eth-switch', [{ type: 'configLine', context: [['interface', 'FastEthernet0/2']], line: ['description', 'learned'], negate: false }], sim.now);
    const after = of(logs(), 'sw1');
    expect(after.filter((l) => l.mnemonic === LOG_MNEMONIC_CONFIGURED)).toEqual([]);
    expect(sw1.running.render()).toContain(' description learned\n');
  });

  it('a reload logs the start and the ports again; nothing is logged while the device is off', () => {
    const { sim, logs } = world('P3');
    sim.runFor(70 * SEC);
    logs();
    sim.setPower('r1', false);
    sim.runFor(SEC);
    expect(of(logs(), 'r1').filter(extended)).toEqual([]);
    sim.setPower('r1', true);
    sim.runFor(60 * SEC);
    expect(of(logs(), 'r1').filter(extended).map(shape)).toEqual([
      'SYS-5-BOOTED: The system has started (NF-2911).',
      'LINK-3-UPDOWN: Interface GigabitEthernet0/0: the link is up',
      'LINEPROTO-5-UPDOWN: Interface GigabitEthernet0/0: line protocol is up',
    ]);
  });
});

describe('none in P1 and P2 worlds', () => {
  /** Boot, a cable cut, a shutdown and a configuration: every log the world produced. */
  function script(profile: DefaultsProfile): Log[] {
    const { sim, logs, link } = world(profile);
    sim.runFor(70 * SEC);
    sim.configure('r1', ['interface GigabitEthernet0/1', 'description uplink', 'exit', 'interface GigabitEthernet0/0', 'shutdown', 'no shutdown']);
    sim.runFor(10 * SEC);
    sim.removeLink(link);
    sim.runFor(10 * SEC);
    return logs();
  }

  it('no start, link, line-protocol or configuration log; the logs every profile had are the same as in P3', () => {
    const p3 = script('P3');
    expect(p3.filter(extended).length).toBeGreaterThan(0);
    for (const profile of ['P1', 'P2'] as const) {
      const got = script(profile);
      expect(got.filter(extended)).toEqual([]);
      expect(got.some((l) => l.message === 'Interface GigabitEthernet0/0 administratively down')).toBe(true);
    }
    // the P2 world's logs are exactly the P3 world's without the extended ones (same events, same times)
    expect(script('P2')).toEqual(p3.filter((l) => !extended(l)));
  });
});
