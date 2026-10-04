/**
 * ip.switch-transport — the dormant switch transport (ARCHITECTURE-P3 D22, D14, §4.3; §7 W1 l3 and the approved
 * [S13]/[S25] entries): on `staged.world` at stage P3 an NF-C2960 derives `udp` and `tcp` from the `managed-switch`
 * row, but ipv4 hands them nothing — a unicast datagram to its SVI draws ICMP 3/2, a SYN draws ICMP 3/2, and a DHCP
 * broadcast dies in ipv4 as `unsupported-protocol`, exactly P2's path — until a `DORMANT_TRANSPORT_OWNERS` line is
 * stored (`ntp server`; [S13] `transport input` other than `none` under `line vty`, never `line vty` alone; [S25]
 * `logging host`). Then the datagram draws 3/3 and the SYN a RST; removing the line restores 3/2.
 * [S13] Rulings R17/R27 (W3 svc, additive case): a telnet/ssh client session opened on the switch's own console wakes
 * the transport for as long as the session lasts, and only then.
 *
 * The configuration is written with `DeviceRuntime.applyConfigLine` (the config store, rule 13): the grammar for
 * `ntp`, `transport input` and `logging host` arrives with the W2 cli item, and the wake-up reads only what is stored.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceModel } from '../src/contracts/device.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { DORMANT_TRANSPORT_OWNERS, dormantTransportEligible, transportWakeLine } from '../src/protocols/ip-upper.js';
import { createVty } from '../src/protocols/vty.js';
import { createVtyClient } from '../src/protocols/vty-client.js';
import { createStagedSimulation } from './staged.world.js';

const SVI = '192.168.1.2';
const SEED = 22;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/**
 * R1 (the DHCP server, 192.168.1.1), SW1 (NF-C2960, Vlan1 = the SVI, up), PC1 (static 192.168.1.10) and PC2 (DHCP):
 * the synthetic guard world of D3, built on `staged.world`. Boot 60 s, then PC2 takes `ip address dhcp`, 30 s.
 */
function world(stage: 'P2' | 'P3'): Simulation {
  const sim = createStagedSimulation({ seed: SEED, stage });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      ['interface GigabitEthernet0/0', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown'],
      ['ip dhcp excluded-address 192.168.1.1 192.168.1.10'],
      ['ip dhcp pool GUARD', ' network 192.168.1.0 255.255.255.0', ' default-router 192.168.1.1'],
    ]),
  });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: startup([['hostname SW1'], ['interface Vlan1', ` ip address ${SVI} 255.255.255.0`, ' no shutdown'], ['ip default-gateway 192.168.1.1']]),
  });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 192.168.1.10 255.255.255.0'], ['ip default-gateway 192.168.1.1']]) });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: startup([['hostname PC2']]) });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.runFor(60 * SEC);
  const r = sim.configure('pc2', ['ip address dhcp']);
  expect(r.lines.every((l) => l.ok)).toBe(true);
  sim.runFor(30 * SEC);
  return sim;
}

/** Events of `fn` and the `runNs` after it. */
function during(sim: Simulation, fn: () => void, runNs = 20 * SEC): TraceEvent[] {
  const cursor = sim.trace(0).next;
  fn();
  sim.runFor(runNs);
  return sim.trace(cursor).events;
}

/** R1 traceroutes to the SVI (UDP probes) and PC1's browser fetches http://<SVI>/ (a SYN to port 80). */
function probe(sim: Simulation): TraceEvent[] {
  return during(sim, () => {
    const session = sim.cli.open('r1', 'console');
    sim.cli.exec(session, `traceroute ${SVI}`);
    sim.hostRequest('pc1', { app: 'http.get', url: `http://${SVI}/` });
  });
}

/** What SW1 did with the probes: ICMP errors it created (by code word and transport), transport activity, drops. */
function switchAnswers(evs: readonly TraceEvent[]) {
  const created = evs.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === 'sw1');
  const icmp = (word: string, proto: 'udp' | 'tcp'): number =>
    created.filter((e) => e.process === 'icmpv4' && e.pdu.summary === `ICMP destination unreachable (${word})` && (e.pdu.flow ?? '').endsWith(`:${proto}`)).length;
  const transport = evs.filter((e) => (e.kind === 'pduCreated' || e.kind === 'pduConsumed') && e.device === 'sw1' && (e.process === 'udp' || e.process === 'tcp'));
  const drops = evs
    .filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => {
      if (e.kind !== 'drop' || e.device !== 'sw1') return false;
      const layers = e.pdu.layers ?? [e.pdu.proto];
      return layers.includes('udp') || layers.includes('tcp') || e.pdu.proto === 'udp' || e.pdu.proto === 'tcp';
    })
    .map((e) => `${e.reason}|${e.detail ?? ''}`);
  return {
    protoUdp: icmp('protocol', 'udp'),
    protoTcp: icmp('protocol', 'tcp'),
    portUdp: icmp('port', 'udp'),
    rst: created.filter((e) => e.process === 'tcp').length,
    transport: transport.length,
    drops: Array.from(new Set(drops)).sort(),
  };
}

const DORMANT = {
  protoUdp: 3,
  protoTcp: 1,
  portUdp: 0,
  rst: 0,
  transport: 0,
  drops: ['unsupported-protocol|ip protocol 17 has no listener', 'unsupported-protocol|ip protocol 6 has no listener'],
};

function expectDormant(evs: readonly TraceEvent[]): void {
  const a = switchAnswers(evs);
  expect(a).toMatchObject({ portUdp: 0, rst: 0, transport: 0, drops: DORMANT.drops });
  expect(a.protoUdp).toBeGreaterThanOrEqual(DORMANT.protoUdp);
  expect(a.protoTcp).toBeGreaterThanOrEqual(DORMANT.protoTcp);
}

function expectAwake(evs: readonly TraceEvent[]): void {
  const a = switchAnswers(evs);
  expect(a.protoUdp + a.protoTcp).toBe(0);
  expect(a.portUdp).toBeGreaterThanOrEqual(3);
  expect(a.rst).toBeGreaterThanOrEqual(1);
  expect(a.transport).toBeGreaterThan(0);
  expect(a.drops).toContain('unsupported-protocol|tcp port 80 closed');
  expect(a.drops.some((d) => /^unsupported-protocol\|udp port \d+ closed$/.test(d))).toBe(true);
  expect(a.drops.filter((d) => d.includes('has no listener'))).toEqual([]);
}

const setLine = (sim: Simulation, context: string[][], line: string[], negate = false): void => {
  expect(sim.device('sw1')!.applyConfigLine(context, line, negate)).toEqual({ ok: true });
};

describe('ip.switch-transport (D22): which devices are dormant-eligible', () => {
  it('a P3 managed switch runs udp and tcp only through managed-switch; routers, multilayer switches, hosts and the controller do not', () => {
    const sim = createStagedSimulation({ seed: 1, stage: 'P3' });
    const model = (type: string): DeviceModel => sim.catalog.get(type)!;
    const c2960 = model('switch.nfc2960');
    expect(c2960.processes).toEqual(expect.arrayContaining(['udp', 'tcp']));
    expect(dormantTransportEligible(c2960, 'udp')).toBe(true);
    expect(dormantTransportEligible(c2960, 'tcp')).toBe(true);
    for (const type of ['router.nf2911', 'mlswitch.nfc3650-24', 'pc.nfpc', 'wlc.nfwlc9800', 'ap.nfap-lw']) {
      expect(dormantTransportEligible(model(type), 'udp')).toBe(false);
      expect(dormantTransportEligible(model(type), 'tcp')).toBe(false);
    }
    // at stage P2 the switch runs no transport at all
    const p2 = createStagedSimulation({ seed: 1, stage: 'P2' }).catalog.get('switch.nfc2960')!;
    expect(p2.processes.includes('udp') || p2.processes.includes('tcp')).toBe(false);
    expect(dormantTransportEligible(p2, 'udp')).toBe(false);
  });
});

describe('ip.switch-transport (D22): the wake-up lines', () => {
  const wake = (lines: readonly (readonly [string[][], string[]])[]): string | undefined => {
    const ast = createConfigAst();
    for (const [context, line] of lines) ast.set(context, line);
    return transportWakeLine(ast.root)?.service;
  };

  it('lists the MUST lines and the approved [S13]/[S25] entries, nothing a P1/P2 file can hold', () => {
    const shape = (e: (typeof DORMANT_TRANSPORT_OWNERS)[number]) => [
      e.service, e.context.join(' '), e.lines.map((l) => l.join(' ')).join(' + '), (e.except ?? []).join(','), e.address === true ? '<address>' : '',
    ];
    expect(DORMANT_TRANSPORT_OWNERS.map(shape)).toEqual([
      ['ntp', '', 'ntp server', '', ''],
      ['ntp', '', 'ntp master', '', ''],
      ['restconf', '', 'restconf + ip http secure-server', '', ''],
      ['vty', 'line vty', 'transport input', 'none', ''],
      ['vty', '', 'crypto key generate rsa', '', ''],
      ['logger', '', 'logging host', '', ''],
      ['logger', '', 'logging', '', '<address>'],
    ]);
    expect(Object.isFrozen(DORMANT_TRANSPORT_OWNERS)).toBe(true);
  });

  it('reads the stored configuration: every entry wakes, a partial or negated line does not', () => {
    expect(wake([])).toBeUndefined();
    expect(wake([[[], ['hostname', 'SW1']], [[['interface', 'Vlan1']], ['ip', 'address', SVI, '255.255.255.0']]])).toBeUndefined();
    expect(wake([[[], ['ntp', 'server', '10.0.0.1']]])).toBe('ntp');
    expect(wake([[[], ['ntp', 'master', '3']]])).toBe('ntp');
    expect(wake([[[], ['ntp', 'master']]])).toBe('ntp');
    // RESTCONF needs both lines
    expect(wake([[[], ['restconf']]])).toBeUndefined();
    expect(wake([[[], ['ip', 'http', 'secure-server']]])).toBeUndefined();
    expect(wake([[[], ['ip', 'http', 'server']], [[], ['restconf']]])).toBeUndefined();
    expect(wake([[[], ['restconf']], [[], ['ip', 'http', 'secure-server']]])).toBe('restconf');
    // [S13] line vty alone (a P1 line) never wakes it; transport input other than none does; the key does
    const vty = [['line', 'vty', '0', '4']];
    expect(wake([[[], ['line', 'vty', '0', '4']], [vty, ['login', 'local']], [vty, ['password', 'nf']]])).toBeUndefined();
    expect(wake([[[], ['line', 'vty', '0', '4']], [vty, ['transport', 'input', 'none']]])).toBeUndefined();
    for (const t of [['ssh'], ['telnet'], ['ssh', 'telnet'], ['all']]) {
      expect(wake([[[], ['line', 'vty', '0', '4']], [vty, ['transport', 'input', ...t]]])).toBe('vty');
    }
    expect(wake([[[], ['line', 'vty', '5', '15']], [[['line', 'vty', '5', '15']], ['transport', 'input', 'ssh']]])).toBe('vty');
    expect(wake([[[], ['line', 'console', '0']], [[['line', 'console', '0']], ['transport', 'input', 'ssh']]])).toBeUndefined();
    expect(wake([[[], ['crypto', 'key', 'generate', 'rsa', 'modulus', '1024']]])).toBe('vty');
    // [S25]
    expect(wake([[[], ['logging', 'host', '10.0.0.5']]])).toBe('logger');
    expect(wake([[[], ['logging', '10.0.0.5']]])).toBe('logger');
    expect(wake([[[], ['logging', 'buffered', '4096']]])).toBeUndefined();
    expect(wake([[[], ['logging', 'trap', 'warnings']], [[], ['logging', 'console', '7']], [[], ['logging', 'source-interface', 'Vlan1']]])).toBeUndefined();
  });
});

describe('ip.switch-transport (D22) on staged.world at stage P3', () => {
  it('dormant: the SVI answers a datagram and a SYN with 3/2 and the DHCP broadcasts die in ipv4 — as the P2 switch does', () => {
    const p3 = world('P3');
    const boot = p3.trace(0).events;
    const dhcpDrops = boot.filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop' && e.device === 'sw1' && e.pdu.proto === 'dhcp');
    expect(dhcpDrops.length).toBeGreaterThanOrEqual(2);
    expect(Array.from(new Set(dhcpDrops.map((e) => `${e.reason}|${e.detail ?? ''}`)))).toEqual(['unsupported-protocol|ip protocol 17 has no listener']);
    expect(boot.filter((e) => (e.kind === 'pduConsumed' || e.kind === 'pduCreated') && e.device === 'sw1' && (e.process === 'udp' || e.process === 'tcp'))).toEqual([]);
    const evs = probe(p3);
    expectDormant(evs);
    // the same script on the P2-stage switch (no transport at all) gives the same answers
    expect(switchAnswers(evs)).toEqual(switchAnswers(probe(world('P2'))));
    // no sockets row appears on the dormant switch
    expect(p3.device('sw1')!.tables.get('sockets')?.rows() ?? []).toEqual([]);
  });

  it('ntp server wakes it (3/3 and RST); removing the line restores 3/2', () => {
    const sim = world('P3');
    setLine(sim, [], ['ntp', 'server', '192.168.1.1']);
    expectAwake(probe(sim));
    setLine(sim, [], ['ntp', 'server', '192.168.1.1'], true);
    expectDormant(probe(sim));
  });

  it('[S13] line vty alone leaves it dormant; transport input ssh wakes it; none or its removal puts it back to sleep', () => {
    const sim = world('P3');
    const vty = [['line', 'vty', '0', '4']];
    setLine(sim, [], ['line', 'vty', '0', '4']);
    setLine(sim, vty, ['login', 'local']);
    expectDormant(probe(sim));
    setLine(sim, vty, ['transport', 'input', 'ssh']);
    expectAwake(probe(sim));
    setLine(sim, vty, ['transport', 'input', 'ssh'], true);
    expectDormant(probe(sim));
    setLine(sim, vty, ['transport', 'input', 'none']);
    expectDormant(probe(sim));
  });

  it('[S25] logging host wakes it', () => {
    const sim = world('P3');
    setLine(sim, [], ['logging', 'host', '192.168.1.1']);
    expectAwake(probe(sim));
    setLine(sim, [], ['logging', 'host', '192.168.1.1'], true);
    expectDormant(probe(sim));
  });
});

// ── [S13] rulings R17/R27 (W3 svc): the l3 half — an outbound client session wakes the switch for its own life ──

describe('ip.switch-transport [S13] R27: an outbound telnet/ssh session opened on the switch wakes it while it lasts', () => {
  /** R1 (a telnet vty with a line password), SW1 (no service line: dormant) and PC1; vty and vty-client registered. */
  function clientWorld(): Simulation {
    const sim = createStagedSimulation({ seed: SEED, stage: 'P3', factories: { vty: createVty, 'vty-client': createVtyClient } });
    sim.addDevice({
      id: 'r1', type: 'router.nf2911', name: 'R1',
      startupConfig: startup([['hostname R1'], ['interface GigabitEthernet0/0', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown'], ['line vty 0 4', ' password nf', ' login']]),
    });
    sim.addDevice({
      id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
      startupConfig: startup([['hostname SW1'], ['interface Vlan1', ` ip address ${SVI} 255.255.255.0`, ' no shutdown'], ['ip default-gateway 192.168.1.1']]),
    });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 192.168.1.10 255.255.255.0'], ['ip default-gateway 192.168.1.1']]) });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
    sim.runFor(90 * SEC);
    return sim;
  }

  /** A line typed on a console session; the prompt it ends at after `runNs`. */
  const typeLine = (sim: Simulation, session: string, line: string, runNs = 5 * SEC): string | undefined => {
    const cursor = sim.trace(0).next;
    sim.cli.exec(session, line);
    sim.runFor(runNs);
    const prompts = sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'cliPrompt' }> => e.kind === 'cliPrompt' && e.session === session);
    return prompts.at(-1)?.prompt;
  };

  it('dormant before, awake (3/3, RST) while SW1 is logged in to R1, dormant again once the session ended', () => {
    const sim = clientWorld();
    expectDormant(probe(sim));
    const sw = sim.cli.open('sw1', 'console');
    expect(typeLine(sim, sw, 'telnet 192.168.1.1')).toBe('Password: ');
    expect(typeLine(sim, sw, 'nf')).toBe('R1>');
    expect(sim.cli.session(sw)).toMatchObject({ remote: 'R1 via Telnet', busy: false });
    // the session's own segments reached SW1's tcp: R1 logged it in
    expect(sim.device('r1')!.tables.get('vty-logins')!.rows().map((r) => (r as unknown as { result: string }).result)).toEqual(['success']);
    // while it lasts the transport answers like a configured service
    expectAwake(probe(sim));
    expect(sim.cli.session(sw)).toMatchObject({ prompt: 'R1>', remote: 'R1 via Telnet' });
    expect(typeLine(sim, sw, 'exit', 3 * SEC)).toBe('SW1>');
    expect(sim.cli.session(sw)?.remote).toBeUndefined();
    // the hold went with the connection
    expectDormant(probe(sim));
    expect(sim.device('sw1')!.tables.get('sockets')?.rows() ?? []).toEqual([]);
  });
});
