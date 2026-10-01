/**
 * l4.hidden-listener [S13] — `tcp.listen {service: true}` (ARCHITECTURE-P3 D14, §2.4; §7 W1 svc [S13]): a hidden
 * service listener writes no `sockets` row and no debug line, gets no `sock.opened` (nor `sock.closed` when it
 * closes) and never appears in the tcp StateView, so a P1 or P2 router whose configuration holds `line vty` keeps its
 * bytes when the vty daemon (W2+) opens its listeners. It binds like any listener and accepts; its connections are
 * ordinary ones.
 */
import { describe, expect, it } from 'vitest';
import type { Pdu } from '../src/contracts/pdu.js';
import type { ProcessRequest } from '../src/contracts/process.js';
import type { SocketRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import { createTcp } from '../src/protocols/tcp.js';
import { createSimulation } from '../src/sim/simulation.js';
import { BOOT_NS, createWorld6, recorder, type Recorder, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';

const hidden = (socket: string, localPort: number, owner = 'http-server'): ProcessRequest => ({ kind: 'tcp.listen', owner, socket, family: 4, localPort, service: true });

describe('l4.hidden-listener [S13] on a P1 router', () => {
  it("opening and closing a hidden listener leaves the router's tcp StateView, snapshot and trace byte-identical", () => {
    const sim = createSimulation({ seed: 3 });
    sim.addDevice({
      id: 'r1', type: 'router.nf2911', name: 'R1',
      startupConfig: ['hostname R1', '!', `interface ${G0}`, ' ip address 10.0.0.1 255.255.255.0', ' no shutdown', '!', 'line vty 0 4', ' login', ' password nf', '!', 'end', ''].join('\n'),
    });
    sim.runFor(60 * SEC);
    expect(sim.profile).toBe('P1');
    expect(sim.device('r1')!.running.render()).toContain('line vty 0 4');
    const tcp = (): string => JSON.stringify(sim.device('r1')!.processes.get('tcp')!.stateSnapshot());
    const beforeView = tcp();
    const beforeSnap = JSON.stringify(sim.snapshot());
    const beforeTrace = sim.trace(0).next;
    const dev = sim.device('r1')!;
    // the vty daemon does not run in P1: the listener is opened on its behalf, exactly as it will be after W2
    dev.applyActions('vty', [{ type: 'request', to: 'tcp', req: hidden('vty#23', 23, 'vty') }], sim.now);
    dev.applyActions('vty', [{ type: 'request', to: 'tcp', req: hidden('vty#22', 22, 'vty') }], sim.now);
    expect(tcp()).toBe(beforeView);
    expect(JSON.stringify(sim.snapshot())).toBe(beforeSnap);
    expect(sim.trace(0).next).toBe(beforeTrace);
    expect(dev.tables.get('sockets')!.rows()).toEqual([]);
    dev.applyActions('vty', [{ type: 'request', to: 'tcp', req: { kind: 'tcp.close', socket: 'vty#23' } }], sim.now);
    expect(tcp()).toBe(beforeView);
    expect(JSON.stringify(sim.snapshot())).toBe(beforeSnap);
    expect(sim.trace(0).next).toBe(beforeTrace);
  });
});

describe('l4.hidden-listener [S13] behaviour', () => {
  function lab(): { w: World6; cli: Recorder; srv: Recorder } {
    const cli = recorder('http-client');
    const srv = recorder('http-server');
    const w = createWorld6({ seed: 7, extra: { tcp: createTcp, 'http-client': () => cli, 'http-server': () => srv } });
    w.add('pc1', 'pc');
    w.add('r1', 'router');
    w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
    w.runFor(BOOT_NS);
    w.iface('pc1', PC, 'ip address 192.168.1.2 255.255.255.0');
    w.iface('r1', G0, 'ip address 192.168.1.80 255.255.255.0', 'no shutdown');
    w.runFor(1 * SEC);
    return { w, cli, srv };
  }
  const tcpOf = (p: Pdu): Record<string, unknown> | undefined => p.layers.find((l) => l.proto === 'tcp')?.fields;
  const r1Tcp = (w: World6): Pdu[] => w.sentBy('r1').filter((p) => tcpOf(p) !== undefined);
  const r1TcpDebug = (w: World6): string[] => w.kinds('debug').filter((e) => e.event.device === w.dev('r1').id && e.event.category === 'tcp').map((e) => e.event.message);
  const kinds = (r: Recorder): string[] => r.evs.map((e) => e.kind);
  const ofKind = <K extends ProcessEvent['kind']>(r: Recorder, k: K): Extract<ProcessEvent, { kind: K }>[] =>
    r.evs.filter((e): e is Extract<ProcessEvent, { kind: K }> => e.kind === k);

  it('accepts like any listener; the accepted connection is an ordinary one (row, StateView, debug)', () => {
    const { w, cli, srv } = lab();
    w.request('r1', 'tcp', hidden('vty#23', 23));
    expect(srv.evs).toEqual([]);
    expect(r1TcpDebug(w)).toEqual([]);
    expect(w.dev('r1').tables.get('sockets')!.rows()).toEqual([]);
    expect(w.dev('r1').processes.get('tcp')!.stateSnapshot().state.listeners).toEqual([]);
    w.request('pc1', 'tcp', { kind: 'tcp.connect', owner: 'http-client', socket: 'c#1', dst: '192.168.1.80', dstPort: 23 });
    w.runFor(1 * SEC);
    expect(r1Tcp(w).map((p) => tcpOf(p)!.flags)).toEqual(['SA']);
    expect(kinds(cli)).toEqual(['sock.connected']);
    expect(kinds(srv)).toEqual(['sock.accepted']);
    expect(ofKind(srv, 'sock.accepted')[0]).toMatchObject({ socket: 'vty#23/1', listener: 'vty#23', localPort: 23 });
    const rows = w.dev('r1').tables.get('sockets')!.rows() as unknown as readonly SocketRow[];
    expect(rows.map((r) => [r.id, r.state])).toEqual([['vty#23/1', 'ESTABLISHED']]);
    const state = w.dev('r1').processes.get('tcp')!.stateSnapshot().state;
    expect(state.listeners).toEqual([]);
    expect((state.connections as { id: string }[]).map((c) => c.id)).toEqual(['vty#23/1']);
    expect(r1TcpDebug(w).length).toBeGreaterThan(0);
  });

  it('binds its port (a second listener conflicts) and closes silently; a SYN then draws a RST', () => {
    const { w, srv } = lab();
    w.request('r1', 'tcp', hidden('vty#23', 23));
    w.request('r1', 'tcp', { kind: 'tcp.listen', owner: 'http-server', socket: 'http-server#23', family: 4, localPort: 23 });
    expect(ofKind(srv, 'sock.error')).toEqual([{ kind: 'sock.error', socket: 'http-server#23', code: 'addr-in-use', detail: 'port 23 is already bound by vty#23' }]);
    srv.evs.length = 0;
    const debugs = r1TcpDebug(w).length;
    w.request('r1', 'tcp', { kind: 'tcp.close', socket: 'vty#23' });
    expect(srv.evs).toEqual([]);
    expect(r1TcpDebug(w).length).toBe(debugs);
    w.request('pc1', 'tcp', { kind: 'tcp.connect', owner: 'http-client', socket: 'c#1', dst: '192.168.1.80', dstPort: 23 });
    w.runFor(1 * SEC);
    expect(r1Tcp(w).map((p) => tcpOf(p)!.flags)).toEqual(['RA']);
  });

  it('an error on a hidden listen is reported to the owner without a debug line', () => {
    const { w, srv } = lab();
    w.request('r1', 'tcp', hidden('vty#bad', 70000));
    expect(ofKind(srv, 'sock.error')).toEqual([{ kind: 'sock.error', socket: 'vty#bad', code: 'bad-socket', detail: 'port 70000 is outside 1-65535' }]);
    expect(r1TcpDebug(w)).toEqual([]);
    // sending on a hidden listener is refused to its owner, still without a debug line
    w.request('r1', 'tcp', hidden('vty#23', 23));
    w.request('r1', 'tcp', { kind: 'tcp.send', socket: 'vty#23', data: new Uint8Array(4) });
    expect(ofKind(srv, 'sock.error').at(-1)).toEqual({ kind: 'sock.error', socket: 'vty#23', code: 'bad-socket', detail: 'the connection is not open for sending' });
    expect(r1TcpDebug(w)).toEqual([]);
    // an ordinary listen keeps its P1 row, debug line and sock.opened
    w.request('r1', 'tcp', { kind: 'tcp.listen', owner: 'http-server', socket: 'http-server#80', family: 4, localPort: 80 });
    expect(kinds(srv)).toEqual(['sock.error', 'sock.error', 'sock.opened']);
    expect(r1TcpDebug(w)).toEqual(['http-server#80 CLOSED -> LISTEN on 0.0.0.0:80 for http-server']);
    expect(w.dev('r1').tables.get('sockets')!.rows()).toHaveLength(1);
  });
});
