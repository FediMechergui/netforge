/**
 * P2 acceptance — DHCPv6 (ARCHITECTURE-P2 §10.1 `accept.p2.dhcpv6`; D16, §3.11, §4.1–§4.3, §5.2, §7 W4 qa).
 *
 * Real worlds built with `createP2Simulation` (§0 rule 13) in the P2 profile, with every approved W1–W3 daemon
 * factory laid over the registry — what the real catalog holds once the W4 flip has landed. PC1 — R1 Gi0/0
 * 2001:db8:1::1/64 with pool LAN6:
 *   • stateless (O = 1): exactly INFORMATION-REQUEST (11) then REPLY (7); PC1 keeps its SLAAC address and learns the
 *     DNS server; a dual-stack PC with a DHCPv4 lease lists both DNS servers, IPv4 first;
 *   • stateful (M = 1): SOLICIT, ADVERTISE, REQUEST, REPLY in order; PC1 gets 2001:db8:1::2 with origin dhcpv6 and
 *     prefix 128; one `dhcpv6-bindings` row; `ping -6` to R1 5/5;
 *   • with M = O = 0 no DHCPv6 PDU is sent;
 *   • transaction ids identical over 3 runs.
 */
import { describe, expect, it } from 'vitest';
import type { Ipv6PortAddress } from '../src/contracts/port.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { Dhcpv6BindingRow, SocketRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { DHCPV6_ADVERTISE, DHCPV6_INFORMATION_REQUEST, DHCPV6_REPLY, DHCPV6_REQUEST, DHCPV6_SOLICIT } from '../src/pdu/codecs/dhcpv6.js';
import { createDhcpv6Client } from '../src/protocols/dhcpv6-client.js';
import { createDhcpv6Server } from '../src/protocols/dhcpv6-server.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { createHsrp } from '../src/protocols/hsrp.js';
import { createNat } from '../src/protocols/nat.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, output } from './sim.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const BOOT = 90 * SEC;
const PREFIX = '2001:db8:1::';
const R1_V6 = `${PREFIX}1`;
const DNS6 = '2001:db8:1::53';
const DNS4 = '192.168.1.53';

/** Every approved W1–W3 daemon with its real factory (the W4 flip registers exactly these; capwap-* arrive in W5). */
function p2Daemons(): P2FactoryOverlay {
  const out: Record<string, ProcessFactory> = {
    vlan: createVlan,
    dtp: createDtp,
    etherchannel: createEtherchannel,
    stp: createStp,
    nat: createNat,
    hsrp: createHsrp,
    'dhcpv6-client': createDhcpv6Client,
    'dhcpv6-server': createDhcpv6Server,
  };
  return out;
}

interface LabOptions {
  readonly seed?: number;
  /** R1 Gi0/0 `ipv6 nd managed-config-flag`. */
  readonly managed?: boolean;
  /** R1 Gi0/0 `ipv6 nd other-config-flag`. */
  readonly other?: boolean;
  /** The pool leases addresses (`address prefix …`). */
  readonly stateful?: boolean;
  /** PC1 also takes a DHCPv4 lease from R1's pool LAN4. */
  readonly dhcpv4?: boolean;
}

function r1Config(o: LabOptions): string {
  const pool6 = [`dns-server ${DNS6}`, 'domain-name lab.nf'];
  if (o.stateful) pool6.unshift(`address prefix ${PREFIX}/64 lifetime 86400 3600`);
  const gi = [`ipv6 address ${R1_V6}/64`, 'ipv6 dhcp server LAN6'];
  if (o.managed) gi.push('ipv6 nd managed-config-flag');
  if (o.other) gi.push('ipv6 nd other-config-flag');
  const globals = ['hostname R1', 'ipv6 unicast-routing'];
  const sections: (readonly string[])[] = [globals, section('ipv6 dhcp pool LAN6', pool6)];
  if (o.dhcpv4) {
    globals.push('ip dhcp excluded-address 192.168.1.1 192.168.1.9');
    sections.push(section('ip dhcp pool LAN4', ['network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', `dns-server ${DNS4}`, 'domain-name lab.nf']));
    gi.unshift('ip address 192.168.1.1 255.255.255.0');
  }
  gi.push('no shutdown');
  sections.push(section(`interface ${G0}`, gi));
  return configText(sections);
}

/** PC1 (`ipv6 address autoconfig`, plus `ip address dhcp` when dual-stack) — R1 Gi0/0, booted and settled. */
function lab(o: LabOptions = {}): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 7, factories: p2Daemons() });
  const pcLines = ['ipv6 address autoconfig'];
  if (o.dhcpv4) pcLines.unshift('ip address dhcp');
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: configText([['hostname PC1'], section(`interface ${PC}`, pcLines)]) });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: r1Config(o) });
  sim.addLink({ id: 'l_pc1_r1', a: { device: 'pc1', port: PC }, b: { device: 'r1', port: G0 } });
  sim.runFor(BOOT);
  return sim;
}

const events = (sim: Simulation): TraceEvent[] => sim.trace(0).events;
/** `[device, msgType]` of every DHCPv6 message created in the world, in trace order. */
function messages(sim: Simulation): [string, number][] {
  return ofKind(events(sim), 'pduCreated')
    .filter((e) => e.pdu.tag?.startsWith('dhcpv6-'))
    .map((e) => [e.device, sim.pdu(e.pdu.id)!.layer('dhcpv6')!.fields.msgType as number]);
}
const addrs = (sim: Simulation, device: string, port: string): readonly Ipv6PortAddress[] => sim.device(device)!.port(port)!.l3.ipv6 ?? [];
const bindings = (sim: Simulation): Dhcpv6BindingRow[] => sim.device('r1')!.tables.get<Dhcpv6BindingRow>('dhcpv6-bindings')?.rows() ?? [];
const sockets = (sim: Simulation, device: string): string[] => (sim.device(device)!.tables.get<SocketRow>('sockets')?.rows() ?? []).map((r) => r.id);
const dnsServers = (sim: Simulation): unknown => sim.device('pc1')!.processes.get('dns-client')!.stateSnapshot().state.servers;

/** `ping -6 <target>` at PC1's host shell, run until idle. */
function ping6(sim: Simulation, target: string): string {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open('pc1', 'console');
  const r = sim.cli.exec(session, `ping -6 ${target}`);
  if (r.error !== undefined) throw new Error(`ping -6 ${target}: ${r.output}`);
  sim.runToIdle();
  return output(sim.trace(cursor).events, session);
}

describe('accept P2: DHCPv6 stateless (O = 1)', () => {
  it('sends exactly INFORMATION-REQUEST then REPLY; PC1 keeps its SLAAC address and learns the DNS server', () => {
    const sim = lab({ other: true });
    expect(messages(sim)).toEqual([
      ['pc1', DHCPV6_INFORMATION_REQUEST],
      ['r1', DHCPV6_REPLY],
    ]);
    expect(DHCPV6_INFORMATION_REQUEST).toBe(11);
    expect(DHCPV6_REPLY).toBe(7);
    const req = ofKind(events(sim), 'pduCreated').find((e) => e.device === 'pc1' && e.pdu.tag === 'dhcpv6-inforeq')!;
    const rep = ofKind(events(sim), 'pduCreated').find((e) => e.device === 'r1' && e.pdu.tag === 'dhcpv6-reply')!;
    expect(sim.pdu(req.pdu.id)!.layer('udp')!.fields).toMatchObject({ srcPort: 546, dstPort: 547 });
    expect(sim.pdu(rep.pdu.id)!.meta.triggeredBy).toBe(req.pdu.id);
    expect(sim.pdu(rep.pdu.id)!.layer('dhcpv6')!.fields).toMatchObject({ msgType: 7, dnsServers: DNS6, domainList: 'lab.nf' });
    const a = addrs(sim, 'pc1', PC);
    expect(a.filter((x) => x.origin === 'slaac').map((x) => [x.address.startsWith('2001:db8:1:'), x.prefixLen, x.state])).toEqual([[true, 64, 'preferred']]);
    expect(a.some((x) => x.origin === 'dhcpv6')).toBe(false);
    expect(dnsServers(sim)).toEqual([DNS6]);
    expect(bindings(sim)).toEqual([]);
  });

  it('a dual-stack PC with a DHCPv4 lease lists both DNS servers, IPv4 first', () => {
    const sim = lab({ other: true, dhcpv4: true });
    expect(sim.device('pc1')!.port(PC)!.l3.ipv4).toMatchObject({ address: '192.168.1.10', origin: 'dhcp' });
    expect(addrs(sim, 'pc1', PC).some((x) => x.origin === 'slaac')).toBe(true);
    expect(messages(sim)).toEqual([
      ['pc1', DHCPV6_INFORMATION_REQUEST],
      ['r1', DHCPV6_REPLY],
    ]);
    expect(dnsServers(sim)).toEqual([DNS4, DNS6]);
  });
});

describe('accept P2: DHCPv6 stateful (M = 1)', () => {
  it('SOLICIT, ADVERTISE, REQUEST, REPLY in order; PC1 gets 2001:db8:1::2/128 of origin dhcpv6; one binding; ping -6 5/5', () => {
    const sim = lab({ managed: true, stateful: true });
    expect(messages(sim)).toEqual([
      ['pc1', DHCPV6_SOLICIT],
      ['r1', DHCPV6_ADVERTISE],
      ['pc1', DHCPV6_REQUEST],
      ['r1', DHCPV6_REPLY],
    ]);
    expect([DHCPV6_SOLICIT, DHCPV6_ADVERTISE, DHCPV6_REQUEST, DHCPV6_REPLY]).toEqual([1, 2, 3, 7]);
    const leased = addrs(sim, 'pc1', PC).filter((x) => x.origin === 'dhcpv6');
    expect(leased).toHaveLength(1);
    expect(leased[0]).toMatchObject({ address: `${PREFIX}2`, prefixLen: 128, origin: 'dhcpv6', state: 'preferred', scope: 'global' });
    const rows = bindings(sim);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: `LAN6|${PREFIX}2`, address: `${PREFIX}2`, pool: 'LAN6' });
    expect(rows[0]!.expiresAt).toBe(rows[0]!.updatedAt + 86400 * SEC);
    expect(dnsServers(sim)).toEqual([DNS6]);
    const text = ping6(sim, R1_V6);
    expect(text).toContain(`Sending 5 echo requests to ${R1_V6}`);
    expect(text).toContain('Sent 5, received 5, lost 0');
    // the echoes left from the leased address
    const requests = ofKind(events(sim), 'pduCreated').filter((e) => e.device === 'pc1' && sim.pdu(e.pdu.id)?.get('icmpv6.type') === 128);
    expect(requests).toHaveLength(5);
    expect(requests.every((e) => sim.pdu(e.pdu.id)!.get('ipv6.src') === `${PREFIX}2`)).toBe(true);
    expect(sim.runToIdle(100_000).stopped).toBeUndefined();
  });
});

describe('accept P2: DHCPv6 silence and determinism', () => {
  it('with M = O = 0 no DHCPv6 PDU is sent in 600 s, even with a stateful pool served on the interface', () => {
    const sim = lab({ stateful: true });
    sim.runFor(600 * SEC);
    expect(messages(sim)).toEqual([]);
    expect(sockets(sim, 'pc1').filter((s) => s.startsWith('dhcpv6'))).toEqual([]);
    expect(bindings(sim)).toEqual([]);
    expect(addrs(sim, 'pc1', PC).some((x) => x.origin === 'dhcpv6')).toBe(false);
    expect(addrs(sim, 'pc1', PC).some((x) => x.origin === 'slaac')).toBe(true);
    expect(ofKind(events(sim), 'tableWrite').filter((e) => e.table === 'dhcpv6-bindings')).toEqual([]);
  });

  it('transaction ids (and the whole trace) are identical over 3 runs with one seed', () => {
    const runs = [1, 2, 3].map(() => {
      const sim = lab({ managed: true, stateful: true, seed: 11 });
      const xids = ofKind(events(sim), 'pduCreated')
        .filter((e) => e.pdu.tag?.startsWith('dhcpv6-'))
        .map((e) => sim.pdu(e.pdu.id)!.layer('dhcpv6')!.fields.transactionId as number);
      return { xids, trace: JSON.stringify(events(sim)), snapshot: JSON.stringify(sim.snapshot()) };
    });
    expect(runs[0]!.xids).toHaveLength(4);
    // a 24-bit id per exchange; the answer copies the id of the message it answers
    expect(runs[0]!.xids.every((x) => Number.isInteger(x) && x >= 0 && x < 1 << 24)).toBe(true);
    expect(runs[0]!.xids[1]).toBe(runs[0]!.xids[0]);
    expect(runs[0]!.xids[3]).toBe(runs[0]!.xids[2]);
    for (const run of runs.slice(1)) {
      expect(run.xids).toEqual(runs[0]!.xids);
      expect(run.trace).toBe(runs[0]!.trace);
      expect(run.snapshot).toBe(runs[0]!.snapshot);
    }
  });
});
