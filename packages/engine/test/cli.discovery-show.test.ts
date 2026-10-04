/**
 * cli/handlers/discovery.ts, the W3 shows (ARCHITECTURE-P3 §5.8, D2, D18; §7 W3 cli part 2; rule 20): `show cdp`,
 * `show cdp neighbors [<if>] [detail]`, `show cdp entry <name|*>`, `show cdp interface [<if>]`, `show cdp traffic`,
 * `clear cdp table`, and the same six for LLDP. The settings come from the daemons' own configuration readers, the
 * neighbours from the `cdp-neighbours` / `lldp-neighbours` rows (the hold time left from `expiresAt`), the counters
 * from the daemons' StateViews (documented in protocols/cdp.ts and protocols/lldp.ts). Unit cases against fake rows;
 * the last block reads the rows real daemons wrote on `staged.world` (rule 13).
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { CdpNeighbourRow, LldpNeighbourRow, Table, TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createTable } from '../src/core/table.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { DISCOVERY_DETAIL_ARG } from '../src/cli/grammar/discovery.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import {
  CDP_CAPABILITY_LEGEND,
  DISCOVERY_ENTRY_SEPARATOR,
  LLDP_CAPABILITY_LEGEND,
  MSG_CDP_OFF,
  MSG_LLDP_OFF,
  MSG_NO_ENTRY,
  MSG_NOT_DISCOVERY_PORT,
} from '../src/cli/handlers/discovery.js';
import { matchCommand } from '../src/cli/parser.js';
import { createCdp } from '../src/protocols/cdp.js';
import { createLldp } from '../src/protocols/lldp.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const PC = catalogModel('pc.nfpc');
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const NOW = 500 * SEC;

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, false);
}

function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name as never, t as unknown as Table<TableRow>);
  return t;
}

const lines = (o: CommandOutcome): string[] => (o.output ?? '').split('\n');

const SW1: CdpNeighbourRow = {
  key: `${GI0}|SW1`, localPort: GI0, deviceId: 'SW1', remotePort: 'GigabitEthernet0/2', platform: 'NF-C2960-24', capabilities: 'S I',
  addresses: '10.0.12.2', version: 'NF-OS 3.0', holdtimeS: 180, cdpVersion: 2, nativeVlan: 1, duplex: 'full', expiresAt: NOW + 163 * SEC, updatedAt: NOW - 17 * SEC,
};
const R2: CdpNeighbourRow = {
  key: `${GI1}|R2`, localPort: GI1, deviceId: 'R2', remotePort: 'GigabitEthernet0/0', platform: 'NF-2911', capabilities: 'R',
  addresses: '', version: 'NF-OS 3.0', holdtimeS: 180, cdpVersion: 1, expiresAt: NOW + 150 * SEC, updatedAt: NOW - 30 * SEC,
};
const L_SW1: LldpNeighbourRow = {
  key: `${GI0}|00:1f:00:00:00:21|GigabitEthernet0/2`, localPort: GI0, chassisId: '00:1f:00:00:00:21', portId: 'GigabitEthernet0/2', ttlS: 120,
  systemName: 'SW1', portDescription: 'uplink to R1', systemDescription: 'NF-C2960-24 switch', capabilities: 'B', enabled: 'B', mgmtAddress: '10.0.12.2',
  expiresAt: NOW + 110 * SEC, updatedAt: 0,
};
const L_ANON: LldpNeighbourRow = {
  key: `${GI1}|00:1f:00:00:00:31|Gi0/0`, localPort: GI1, chassisId: '00:1f:00:00:00:31', portId: 'Gi0/0', ttlS: 120, capabilities: 'B,R', enabled: 'R',
  expiresAt: NOW + 90 * SEC, updatedAt: 0,
};

/** R1 with `cdp run` and `lldp run` stored, both neighbours of each protocol, and the daemons' counters. */
function r1(opts: { cdp?: boolean; lldp?: boolean } = {}): RecordingCtx {
  const r = commandCtxFor(ROUTER, {
    mode: 'priv-exec',
    processStates: {
      cdp: { process: 'cdp', state: { running: true, timerS: 60, holdtimeS: 180, advertiseV2: true, disabled: [], sent: 12, received: 10, errors: 1 } },
      lldp: { process: 'lldp', state: { running: true, timerS: 30, holdtimeS: 120, reinitS: 2, noTransmit: [], noReceive: [], sent: 5, received: 4, errors: 0 } },
    },
  });
  (r.ctx as { now: number }).now = NOW;
  if (opts.cdp !== false) r.running.set([], ['cdp', 'run']);
  if (opts.lldp !== false) r.running.set([], ['lldp', 'run']);
  const cdp = attach<CdpNeighbourRow>(r, 'cdp-neighbours');
  cdp.set(R2);
  cdp.set(SW1);
  const lldp = attach<LldpNeighbourRow>(r, 'lldp-neighbours');
  lldp.set(L_ANON);
  lldp.set(L_SW1);
  return r;
}

describe('parsing and scope', () => {
  it('parses every new discovery show and clear on a router and a switch; the hosts have none', () => {
    const cases: [string, string, Record<string, string>][] = [
      ['show cdp', HANDLERS.showCdp, {}],
      ['show cdp neighbors', HANDLERS.showCdpNeighbors, {}],
      ['show cdp neighbors detail', HANDLERS.showCdpNeighbors, { [DISCOVERY_DETAIL_ARG]: 'detail' }],
      ['show cdp neighbors g0/1 detail', HANDLERS.showCdpNeighbors, { iface: GI1, [DISCOVERY_DETAIL_ARG]: 'detail' }],
      ['show cdp entry *', HANDLERS.showCdpEntry, { name: '*' }],
      ['show cdp interface', HANDLERS.showCdpInterface, {}],
      ['show cdp traffic', HANDLERS.showCdpTraffic, {}],
      ['clear cdp table', HANDLERS.execClearCdpTable, {}],
      ['show lldp', HANDLERS.showLldp, {}],
      ['sh lldp nei', HANDLERS.showLldpNeighbors, {}],
      ['show lldp entry SW1', HANDLERS.showLldpEntry, { name: 'SW1' }],
      ['show lldp interface g0/1', HANDLERS.showLldpInterface, { iface: GI1 }],
      ['show lldp traffic', HANDLERS.showLldpTraffic, {}],
      ['clear lldp table', HANDLERS.execClearLldpTable, {}],
    ];
    for (const [line, handler, args] of cases) {
      const m = matchCommand(GRAMMAR, matchContextFor(ROUTER, 'priv-exec'), line);
      expect(m.ok, line).toBe(true);
      if (!m.ok) continue;
      expect(m.spec.handler, line).toBe(handler);
      expect({ ...m.args }, line).toEqual(args);
      expect(matchCommand(GRAMMAR, matchContextFor(SWITCH, 'priv-exec'), line.replace('g0/', 'gi0/')).ok, `${line} on a switch`).toBe(true);
      expect(matchCommand(GRAMMAR, matchContextFor(PC, 'user-exec'), line).ok, `${line} on a PC`).toBe(false);
    }
    // the shows are user-level; the clears need privileged EXEC
    expect(matchCommand(GRAMMAR, matchContextFor(ROUTER, 'user-exec'), 'show cdp neighbors').ok).toBe(true);
    expect(matchCommand(GRAMMAR, matchContextFor(ROUTER, 'user-exec'), 'clear cdp table').ok).toBe(false);
  });
});

describe('show cdp', () => {
  it('on: the timers and the version from the configuration; off: one line', () => {
    expect(lines(run(r1(), HANDLERS.showCdp))).toEqual(['CDP is on', '  Announcements every 60 s, holdtime 180 s', '  Version 2 announcements: on']);
    const r = r1();
    r.running.set([], ['cdp', 'timer', '30']);
    r.running.set([], ['cdp', 'holdtime', '120']);
    r.running.apply([], ['cdp', 'advertise-v2'], true);
    expect(lines(run(r, HANDLERS.showCdp))).toEqual(['CDP is on', '  Announcements every 30 s, holdtime 120 s', '  Version 2 announcements: off (version 1 is sent)']);
    const off = r1({ cdp: false });
    for (const id of [HANDLERS.showCdp, HANDLERS.showCdpNeighbors, HANDLERS.showCdpEntry, HANDLERS.showCdpInterface]) expect(run(off, id), id).toEqual({ output: MSG_CDP_OFF });
  });

  it('on by default in a P3 world on a cdpDefault model (D2); a stored no cdp run wins', () => {
    const model: DeviceModel = { ...ROUTER, cdpDefault: true };
    const base = commandCtxFor(model, { mode: 'priv-exec' });
    const p3 = { ...base, ctx: { ...base.ctx, profile: 'P3' as const } };
    expect(lines(run(p3, HANDLERS.showCdp))[0]).toBe('CDP is on');
    const p2 = { ...base, ctx: { ...base.ctx, profile: 'P2' as const } };
    expect(run(p2, HANDLERS.showCdp)).toEqual({ output: MSG_CDP_OFF });
    p3.running.apply([], ['cdp', 'run'], true);
    expect(run(p3, HANDLERS.showCdp)).toEqual({ output: MSG_CDP_OFF });
  });
});

describe('show cdp neighbors / entry', () => {
  it('one line per neighbour in local-port order, the hold time left, short port names, the total', () => {
    expect(lines(run(r1(), HANDLERS.showCdpNeighbors))).toEqual([
      CDP_CAPABILITY_LEGEND,
      '',
      'Device ID        Local interface  Holdtime (s)  Capability  Platform     Port ID',
      'SW1              Gi0/0            163           S I         NF-C2960-24  Gi0/2',
      'R2               Gi0/1            150           R           NF-2911      Gi0/0',
      '',
      'Total: 2 neighbours',
    ]);
  });

  it('an interface keeps only its neighbours; a port that takes no part says so; an unknown one is refused', () => {
    const out = lines(run(r1(), HANDLERS.showCdpNeighbors, { iface: GI1 }));
    expect(out.slice(2)).toEqual([
      'Device ID        Local interface  Holdtime (s)  Capability  Platform  Port ID',
      'R2               Gi0/1            150           R           NF-2911   Gi0/0',
      '',
      'Total: 1 neighbour',
    ]);
    expect(run(r1(), HANDLERS.showCdpNeighbors, { iface: 'Serial0/0/0' })).toEqual({ output: MSG_NOT_DISCOVERY_PORT('Serial0/0/0') });
    expect(run(r1(), HANDLERS.showCdpNeighbors, { iface: 'Nope9' }).error).toBeDefined();
  });

  it('detail and entry print one block per neighbour', () => {
    const block = [
      DISCOVERY_ENTRY_SEPARATOR,
      'Device ID: SW1',
      '  Addresses: 10.0.12.2',
      '  Platform: NF-C2960-24, capabilities: S I',
      `  Interface: ${GI0}, port ID (its outgoing port): GigabitEthernet0/2`,
      '  Holdtime: 163 s',
      '  Software: NF-OS 3.0',
      '  CDP version: 2',
      '  Native VLAN: 1',
      '  Duplex: full',
    ];
    const detail = lines(run(r1(), HANDLERS.showCdpNeighbors, { [DISCOVERY_DETAIL_ARG]: 'detail' }));
    expect(detail.slice(0, block.length)).toEqual(block);
    expect(detail.slice(block.length)).toEqual([
      DISCOVERY_ENTRY_SEPARATOR,
      'Device ID: R2',
      '  Addresses: none',
      '  Platform: NF-2911, capabilities: R',
      `  Interface: ${GI1}, port ID (its outgoing port): GigabitEthernet0/0`,
      '  Holdtime: 150 s',
      '  Software: NF-OS 3.0',
      '  CDP version: 1',
      '',
      'Total: 2 neighbours',
    ]);
    expect(lines(run(r1(), HANDLERS.showCdpEntry, { name: 'SW1' }))).toEqual(block);
    expect(lines(run(r1(), HANDLERS.showCdpEntry, { name: '*' })).filter((l) => l.startsWith('Device ID'))).toEqual(['Device ID: SW1', 'Device ID: R2']);
    expect(run(r1(), HANDLERS.showCdpEntry, { name: 'sw1' })).toEqual({ output: MSG_NO_ENTRY('CDP', 'sw1') });
  });

  it('no neighbour yet: the header and a zero total', () => {
    const r = r1();
    r.extra.delete('cdp-neighbours' as never);
    expect(lines(run(r, HANDLERS.showCdpNeighbors)).slice(-1)).toEqual(['Total: 0 neighbours']);
  });
});

describe('show cdp interface / traffic / clear cdp table', () => {
  it('every Ethernet port with its CDP state (no cdp enable turns one off); the serial ports take no part', () => {
    const r = r1();
    r.running.apply([['interface', GI1]], ['cdp', 'enable'], true);
    expect(lines(run(r, HANDLERS.showCdpInterface))).toEqual([
      `${GI0} is up, line protocol is up`,
      '  CDP: on; announcements every 60 s, holdtime 180 s',
      `${GI1} is up, line protocol is up`,
      '  CDP: off on this interface (no cdp enable)',
    ]);
    expect(lines(run(r, HANDLERS.showCdpInterface, { iface: GI0 }))).toHaveLength(2);
    expect(run(r, HANDLERS.showCdpInterface, { iface: 'Serial0/0/1' })).toEqual({ output: MSG_NOT_DISCOVERY_PORT('Serial0/0/1') });
  });

  it('the counters come from the cdp StateView (zeros while the daemon does not run)', () => {
    expect(lines(run(r1(), HANDLERS.showCdpTraffic))).toEqual(['CDP counters', '  Announcements sent: 12', '  Announcements received: 10', '  Errors: 1']);
    expect(lines(run(commandCtxFor(ROUTER, { mode: 'priv-exec' }), HANDLERS.showCdpTraffic)).slice(1)).toEqual([
      '  Announcements sent: 0',
      '  Announcements received: 0',
      '  Errors: 0',
    ]);
  });

  it('clear cdp table and clear lldp table empty their tables through the device', () => {
    const r = r1();
    expect(run(r, HANDLERS.execClearCdpTable)).toEqual({});
    expect(run(r, HANDLERS.execClearLldpTable)).toEqual({});
    expect(r.deviceCalls).toEqual(['clearTable cdp-neighbours', 'clearTable lldp-neighbours']);
  });
});

describe('show lldp …', () => {
  it('show lldp: on with its timers, off by default (D2)', () => {
    expect(lines(run(r1(), HANDLERS.showLldp))).toEqual(['LLDP is on', '  Announcements every 30 s, holdtime 120 s, restart delay 2 s']);
    const off = r1({ lldp: false });
    for (const id of [HANDLERS.showLldp, HANDLERS.showLldpNeighbors, HANDLERS.showLldpEntry, HANDLERS.showLldpInterface]) expect(run(off, id), id).toEqual({ output: MSG_LLDP_OFF });
  });

  it('neighbors: the system name (else the chassis id), the enabled capabilities, the hold time left', () => {
    expect(lines(run(r1(), HANDLERS.showLldpNeighbors))).toEqual([
      LLDP_CAPABILITY_LEGEND,
      '',
      'Device ID          Local interface  Hold time (s)  Capability  Port ID',
      'SW1                Gi0/0            110            B           Gi0/2',
      '00:1f:00:00:00:31  Gi0/1            90             R           Gi0/0',
      '',
      'Total: 2 neighbours',
    ]);
  });

  it('detail and entry (by system name or chassis id)', () => {
    const block = [
      DISCOVERY_ENTRY_SEPARATOR,
      'Chassis ID: 00:1f:00:00:00:21',
      '  Port ID: GigabitEthernet0/2',
      '  Port description: uplink to R1',
      '  System name: SW1',
      '  System description: NF-C2960-24 switch',
      '  Capabilities: B; enabled: B',
      '  Management address: 10.0.12.2',
      `  Local interface: ${GI0}, hold time left 110 s`,
    ];
    expect(lines(run(r1(), HANDLERS.showLldpEntry, { name: 'SW1' }))).toEqual(block);
    expect(lines(run(r1(), HANDLERS.showLldpEntry, { name: '00:1f:00:00:00:31' }))).toEqual([
      DISCOVERY_ENTRY_SEPARATOR,
      'Chassis ID: 00:1f:00:00:00:31',
      '  Port ID: Gi0/0',
      '  System name: not sent',
      '  Capabilities: B,R; enabled: R',
      '  Management address: not sent',
      `  Local interface: ${GI1}, hold time left 90 s`,
    ]);
    expect(lines(run(r1(), HANDLERS.showLldpNeighbors, { [DISCOVERY_DETAIL_ARG]: 'detail', iface: GI0 }))).toEqual([...block, '', 'Total: 1 neighbour']);
    expect(run(r1(), HANDLERS.showLldpEntry, { name: 'R9' })).toEqual({ output: MSG_NO_ENTRY('LLDP', 'R9') });
  });

  it('interface: transmit and receive per Ethernet port; traffic from the lldp StateView', () => {
    const r = r1();
    r.running.apply([['interface', GI1]], ['lldp', 'receive'], true);
    expect(lines(run(r, HANDLERS.showLldpInterface))).toEqual([
      `${GI0} is up, line protocol is up`,
      '  LLDP transmit: on, receive: on',
      `${GI1} is up, line protocol is up`,
      '  LLDP transmit: on, receive: off',
    ]);
    expect(lines(run(r, HANDLERS.showLldpTraffic))).toEqual(['LLDP counters', '  Frames sent: 5', '  Frames received: 4', '  Errors: 0']);
  });
});

describe('on a real P3 world (staged.world, the real cdp and lldp daemons)', () => {
  it('R1 shows the switch CDP and LLDP heard on its link, and clear cdp table empties the rows until the next announcement', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3', factories: { cdp: createCdp, lldp: createLldp } });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: 'hostname R1\n!\nlldp run\n!\ninterface GigabitEthernet0/0\n ip address 10.0.12.1 255.255.255.0\n no shutdown\n!\nend\n' });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: 'hostname SW1\n!\nlldp run\n!\nend\n' });
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'sw1', port: GI1 } });
    sim.runFor(60 * SEC); // boot, link-up and the first announcements
    const session = sim.cli.open('r1', 'console');
    sim.cli.exec(session, 'enable');
    const typed = (line: string): string => sim.cli.exec(session, line).output ?? '';
    const cdp = typed('show cdp neighbors');
    expect(cdp).toMatch(/\nSW1 +Gi0\/0 +1[0-9]{2} +S I +\S+ +Gi0\/1\n/);
    expect(cdp).toContain('Total: 1 neighbour');
    const lldp = typed('show lldp neighbors');
    expect(lldp).toMatch(/\nSW1 +Gi0\/0 +1[0-9]{2} +B +Gi0\/1\n/);
    expect(typed('show cdp traffic')).toMatch(/Announcements received: [1-9]/);
    typed('clear cdp table');
    expect(sim.device('r1')!.tables.get<CdpNeighbourRow>('cdp-neighbours')!.rows()).toEqual([]);
    sim.runFor(61 * SEC);
    expect(sim.device('r1')!.tables.get<CdpNeighbourRow>('cdp-neighbours')!.rows().map((r) => r.deviceId)).toEqual(['SW1']);
  });
});
