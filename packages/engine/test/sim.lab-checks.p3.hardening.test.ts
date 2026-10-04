/**
 * sim.lab-checks.p3.hardening — the l2 area's checker adapter (ARCHITECTURE-P3 D5, D13, D14, §2.10, §3.4, §3.14; §7
 * W3 "ospf, acl, l2, qos, disc, svc, http"): the DHCP snooping, DAI and SSH/vty facts of sim/lab-checks/hardening.ts,
 * wired into sim/lab-checks/facts.ts.
 *
 * Against fakes (§7 W3): the switch's `dhcp-snooping` and `arp-inspection` rows are written by this test (the rows
 * eth-switch would write on an ACK and on inspected ARPs, §3.4); every configuration fact reads lines stored through
 * the real CLI, on a switch and on routers (§3.14, D14 "on switches too"). Pinned, each fact with a wrong answer and
 * its original detail, the absent fact, and the subject problems; `snooping.bindingPort` compares as a 'port' (both
 * name forms) and finds the host by name, by MAC or by address.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LabAssertion, LabFactName } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { vlanKey, type ArpInspectionRow, type DhcpSnoopingRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { FACT_READERS } from '../src/sim/lab-checks/facts.js';
import { HARDENING_FACT_READERS } from '../src/sim/lab-checks/hardening.js';
import { runCheck } from '../src/sim/lab-checks/registry.js';
import { createStagedSimulation } from './staged.world.js';

let sim: Simulation;
let pc1Mac: string;

/** Configure through the real CLI; a refused line fails the test with its error. */
function cfg(id: string, lines: readonly string[]): void {
  const r = sim.configure(id, lines);
  if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/**
 * SW1 (§3.4 and §3.14 on a switch): snooping on VLANs 10 and 20, DAI on VLAN 10, Gi0/1 trusted for both; an RSA key of
 * 2048 bits, `login local`, `transport input ssh` and `access-class 10 in` on `line vty 0 4`. R1: a key of 1024 bits,
 * `ip ssh version 2`, `transport input telnet ssh` (stored `ssh telnet`). R2: none of it (no `line vty` section). R3:
 * `line vty 0 4` with `login local` only (the transport line absent). PC1's binding on Fa0/1 (VLAN
 * 10); a static binding on Fa0/3; VLAN 10's arp-inspection row with 3 drops. Built once: no test changes it.
 */
beforeAll(() => {
  sim = createStagedSimulation({ seed: 8, stage: 'P3' });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2' });
  sim.addDevice({ id: 'r3', type: 'router.nf2911', name: 'R3' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2' });
  sim.runFor(60 * SEC);
  cfg('sw1', [
    'hostname ACCESS1',
    'ip domain-name lab.nf',
    'crypto key generate rsa modulus 2048',
    'ip dhcp snooping',
    'ip dhcp snooping vlan 10,20',
    'ip arp inspection vlan 10',
    'interface GigabitEthernet0/1',
    'ip dhcp snooping trust',
    'ip arp inspection trust',
    'exit',
    'access-list 10 permit host 192.168.10.10',
    'line vty 0 4',
    'login local',
    'transport input ssh',
    'access-class 10 in',
  ]);
  cfg('r1', ['hostname EDGE', 'ip domain-name lab.nf', 'crypto key generate rsa modulus 1024', 'ip ssh version 2', 'line vty 0 4', 'transport input telnet ssh']);
  cfg('r3', ['line vty 0 4', 'login local']);
  const sw1 = sim.device('sw1')!;
  pc1Mac = [...sim.device('pc1')!.ports.values()][0]!.mac;
  const binding = (mac: string, ip: string, port: string, kind: DhcpSnoopingRow['kind']): DhcpSnoopingRow => ({
    key: `10|${mac}`,
    updatedAt: 0,
    mac,
    ip,
    vlan: 10,
    port,
    kind,
    ...(kind === 'learned' ? { leaseS: 86400 } : {}),
  });
  const snoop = sw1.tables.get<DhcpSnoopingRow>('dhcp-snooping')!;
  snoop.set(binding(pc1Mac, '192.168.10.11', 'FastEthernet0/1', 'learned'));
  snoop.set(binding('02:00:00:00:00:99', '192.168.10.99', 'FastEthernet0/3', 'static'));
  const dai = sw1.tables.get<ArpInspectionRow>('arp-inspection')!;
  dai.set({ key: vlanKey(10), updatedAt: 0, vlan: 10, forwarded: 7, dropped: 3, droppedNoBinding: 3, droppedAcl: 0 });
});

/** The detail of one assertion (undefined = it passed). */
function detail(a: LabAssertion): string | undefined {
  const r = runCheck({ sim, host: undefined }, a);
  return r.pass ? undefined : (r.detail ?? '(no detail)');
}

const fact = (device: string, f: LabFactName, over: { subject?: string; equals?: string | number | boolean; atLeast?: number; atMost?: number } = {}): LabAssertion => ({
  kind: 'fact',
  device,
  fact: f,
  ...over,
});

describe('the l2 adapter is wired (rule 12) and names its sources (rule 20)', () => {
  it('FACT_READERS reads the adapter’s entries, each with its type and source', () => {
    for (const f of Object.keys(HARDENING_FACT_READERS) as LabFactName[]) expect(FACT_READERS[f]).toBe(HARDENING_FACT_READERS[f]);
    const sources = Object.fromEntries(Object.entries(HARDENING_FACT_READERS).map(([f, r]) => [f, `${r.type} ${r.source}`]));
    expect(sources).toEqual({
      'snooping.enabled': 'boolean configuration: ip dhcp snooping, ip dhcp snooping vlan',
      'dai.enabled': 'boolean configuration: ip arp inspection vlan',
      'dai.dropped': 'number arp-inspection.dropped',
      'snooping.trusted': 'boolean configuration: interface ip dhcp snooping trust',
      'dai.trusted': 'boolean configuration: interface ip arp inspection trust',
      'snooping.bindingPort': 'port dhcp-snooping.port',
      'ssh.enabled': 'boolean configuration: crypto key generate rsa',
      'ssh.version': 'number configuration: ip ssh version',
      'ssh.keyBits': 'number configuration: crypto key generate rsa modulus',
      'vty.transport': 'string configuration: line vty / transport input',
      'vty.loginLocal': 'boolean configuration: line vty / login local',
      'vty.accessClass': 'string configuration: line vty / access-class',
    });
  });
});

describe('DHCP snooping and DAI (subject a VLAN)', () => {
  it('snooping.enabled needs the global line and a vlan line naming the VLAN', () => {
    expect(detail(fact('SW1', 'snooping.enabled', { subject: '10', equals: true }))).toBeUndefined();
    expect(detail(fact('SW1', 'snooping.enabled', { subject: '20', equals: true }))).toBeUndefined();
    expect(detail(fact('SW1', 'snooping.enabled', { subject: '30', equals: true }))).toBe('SW1 snooping.enabled of 30 is false, expected true.');
    expect(detail(fact('R2', 'snooping.enabled', { subject: '10', equals: false }))).toBeUndefined();
  });

  it('dai.enabled', () => {
    expect(detail(fact('SW1', 'dai.enabled', { subject: '10', equals: true }))).toBeUndefined();
    expect(detail(fact('SW1', 'dai.enabled', { subject: '20', equals: true }))).toBe('SW1 dai.enabled of 20 is false, expected true.');
  });

  it('dai.dropped reads the VLAN’s arp-inspection row (0 before any; not set without the table)', () => {
    expect(detail(fact('SW1', 'dai.dropped', { subject: '10', equals: 3 }))).toBeUndefined();
    expect(detail(fact('SW1', 'dai.dropped', { subject: '10', atLeast: 4 }))).toBe('SW1 dai.dropped of 10 is 3, expected at least 4.');
    expect(detail(fact('SW1', 'dai.dropped', { subject: '20', atLeast: 1 }))).toBe('SW1 dai.dropped of 20 is 0, expected at least 1.');
    expect(detail(fact('R2', 'dai.dropped', { subject: '10', atLeast: 0 }))).toBe('R2 dai.dropped of 10 is not set, expected at least 0.');
  });

  it('a missing or malformed VLAN fails', () => {
    expect(detail(fact('SW1', 'snooping.enabled', { equals: true }))).toBe('snooping.enabled needs a VLAN as its subject.');
    expect(detail(fact('SW1', 'dai.enabled', { subject: '5000', equals: true }))).toBe('"5000" is not a VLAN (1-4094).');
    expect(detail(fact('SW1', 'dai.dropped', { subject: 'ten', atLeast: 1 }))).toBe('"ten" is not a VLAN (1-4094).');
  });
});

describe('trusted ports (subject an interface)', () => {
  it('snooping.trusted and dai.trusted', () => {
    expect(detail(fact('SW1', 'snooping.trusted', { subject: 'Gi0/1', equals: true }))).toBeUndefined();
    expect(detail(fact('SW1', 'dai.trusted', { subject: 'GigabitEthernet0/1', equals: true }))).toBeUndefined();
    expect(detail(fact('SW1', 'snooping.trusted', { subject: 'Fa0/24', equals: true }))).toBe('SW1 snooping.trusted of Fa0/24 is false, expected true.');
    expect(detail(fact('SW1', 'dai.trusted', { subject: 'Fa0/5', equals: true }))).toBe('SW1 dai.trusted of Fa0/5 is false, expected true.');
  });

  it('a missing or unknown interface fails', () => {
    expect(detail(fact('SW1', 'dai.trusted', { equals: true }))).toBe('dai.trusted needs an interface as its subject.');
    expect(detail(fact('SW1', 'snooping.trusted', { subject: 'Fa0/99', equals: true }))).toBe('SW1 has no interface called Fa0/99.');
  });
});

describe('snooping.bindingPort (subject a host; a port fact)', () => {
  it('the host’s binding, compared in either name form', () => {
    expect(detail(fact('SW1', 'snooping.bindingPort', { subject: 'PC1', equals: 'Fa0/1' }))).toBeUndefined();
    expect(detail(fact('SW1', 'snooping.bindingPort', { subject: 'PC1', equals: 'FastEthernet0/1' }))).toBeUndefined();
    expect(detail(fact('SW1', 'snooping.bindingPort', { subject: pc1Mac.toUpperCase() }))).toBeUndefined();
    expect(detail(fact('SW1', 'snooping.bindingPort', { subject: '192.168.10.99', equals: 'Fa0/3' }))).toBeUndefined();
  });

  it('wrong answers: another port, a port the switch lacks, a host without a binding', () => {
    expect(detail(fact('SW1', 'snooping.bindingPort', { subject: 'PC1', equals: 'Fa0/2' }))).toBe('SW1 snooping.bindingPort of PC1 is FastEthernet0/1, expected Fa0/2.');
    expect(detail(fact('SW1', 'snooping.bindingPort', { subject: 'PC1', equals: 'Fa0/99' }))).toBe('SW1 has no interface called Fa0/99.');
    expect(detail(fact('SW1', 'snooping.bindingPort', { subject: 'PC2', equals: 'Fa0/2' }))).toBe('SW1 snooping.bindingPort of PC2 is not set, expected Fa0/2.');
  });

  it('a missing subject, or one that names nothing', () => {
    expect(detail(fact('SW1', 'snooping.bindingPort', { equals: 'Fa0/1' }))).toBe('snooping.bindingPort needs a host as its subject.');
    expect(detail(fact('SW1', 'snooping.bindingPort', { subject: 'Nowhere', equals: 'Fa0/1' }))).toBe('There is no device called Nowhere in this topology.');
  });
});

describe('SSH and vty facts (configuration; on a switch and on routers)', () => {
  it('ssh.enabled, ssh.version and ssh.keyBits', () => {
    expect(detail(fact('SW1', 'ssh.enabled', { equals: true }))).toBeUndefined();
    expect(detail(fact('SW1', 'ssh.keyBits', { equals: 2048 }))).toBeUndefined();
    expect(detail(fact('R1', 'ssh.keyBits', { atLeast: 768 }))).toBeUndefined();
    expect(detail(fact('R1', 'ssh.version', { equals: 2 }))).toBeUndefined();
    expect(detail(fact('R2', 'ssh.enabled', { equals: false }))).toBeUndefined();
  });

  it('wrong answers and absent facts', () => {
    expect(detail(fact('R2', 'ssh.enabled', { equals: true }))).toBe('R2 ssh.enabled is false, expected true.');
    expect(detail(fact('R1', 'ssh.keyBits', { atLeast: 2048 }))).toBe('R1 ssh.keyBits is 1024, expected at least 2048.');
    expect(detail(fact('R2', 'ssh.keyBits', { atLeast: 768 }))).toBe('R2 ssh.keyBits is not set, expected at least 768.');
    expect(detail(fact('R1', 'ssh.version', { equals: 1 }))).toBe('R1 ssh.version is 2, expected 1.');
    expect(detail(fact('SW1', 'ssh.version', { equals: 2 }))).toBe('SW1 ssh.version is not set, expected 2.');
  });

  it('vty.transport: as stored, both protocols as `ssh telnet`', () => {
    expect(detail(fact('SW1', 'vty.transport', { equals: 'ssh' }))).toBeUndefined();
    expect(detail(fact('R1', 'vty.transport', { equals: 'ssh telnet' }))).toBeUndefined();
    expect(detail(fact('R1', 'vty.transport', { equals: 'ssh' }))).toBe('R1 vty.transport is ssh telnet, expected ssh.');
  });

  it('without a transport line the effective transport is both protocols; without a vty section nothing is set', () => {
    expect(detail(fact('R3', 'vty.transport', { equals: 'ssh telnet' }))).toBeUndefined();
    expect(detail(fact('R3', 'vty.loginLocal', { equals: true }))).toBeUndefined();
    expect(detail(fact('R2', 'vty.transport', { equals: 'ssh' }))).toBe('R2 vty.transport is not set, expected ssh.');
    expect(detail(fact('R2', 'vty.loginLocal'))).toBe('R2 vty.loginLocal is not set.');
  });

  it('vty.loginLocal and vty.accessClass', () => {
    expect(detail(fact('SW1', 'vty.loginLocal', { equals: true }))).toBeUndefined();
    expect(detail(fact('SW1', 'vty.accessClass', { equals: '10' }))).toBeUndefined();
    expect(detail(fact('SW1', 'vty.accessClass', { equals: 10 }))).toBeUndefined();
    expect(detail(fact('R1', 'vty.loginLocal', { equals: true }))).toBe('R1 vty.loginLocal is false, expected true.');
    expect(detail(fact('SW1', 'vty.accessClass', { equals: '11' }))).toBe('SW1 vty.accessClass is 10, expected 11.');
    expect(detail(fact('R1', 'vty.accessClass', { equals: '10' }))).toBe('R1 vty.accessClass is not set, expected 10.');
  });
});
