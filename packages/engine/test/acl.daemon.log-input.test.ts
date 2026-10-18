/**
 * acl.daemon.log-input — [S12] the extended-entry extras in the acl daemon, protocols/acl.ts (ARCHITECTURE-P3C §5
 * [S12] rows, §7 W2a acl, ruling RC5 (c)):
 *  • `log-input` entries log (they parsed in W1a but did not log): the first packet of a flow at once, with the input
 *    interface and the frame's source MAC after the source (`(GigabitEthernet0/0 001f.0000.0001)`), later packets
 *    aggregated by the `acl-log` timer; a flow is told apart by its input too; an outbound filter names the packet's
 *    ingress interface (`inPort`);
 *  • `log` lines keep their P3 text exactly;
 *  • RC5 (c): the daemon asks `tupleOf(pdu, { dscp: true })`, so `dscp` and `precedence` terms match the datagram's
 *    DSCP; a packet without one reads as DSCP 0;
 *  • a real world (staged P3): PC1's pings denied by a `log-input` entry log one line naming Gi0/0 and PC1's MAC.
 */
import { describe, expect, it } from 'vitest';
import { macToDotted } from '../src/contracts/addr.js';
import type { LayerSpec } from '../src/contracts/pdu.js';
import { SEC } from '../src/contracts/time.js';
import { PING_COUNT } from '../src/cli/handlers/exec.js';
import { ACL_LOG_FACILITY, ACL_LOG_INTERVAL_NS, ACL_LOG_SEVERITY, ACL_LOG_TIMER } from '../src/protocols/acl.js';
import { echoRequest } from './ip.fake-ctx.js';
import { ofKind } from './sim.harness.js';
import { drops, GI0, GI1, logs, pingFrom, pkt, PC1, PC2, rig, SRV, tcpSyn, world, type AclRig } from './acl.daemon.rig.js';

const LIST = 'WATCH';
const SECTION = ['ip', 'access-list', 'extended', LIST];
const MAC_A = '00:1f:00:00:00:01';
const MAC_B = '00:1f:00:00:00:02';

function watch(r: AclRig, entry: string, iface = GI0, dir: 'in' | 'out' = 'in'): void {
  r.line([], SECTION.join(' '));
  r.line([SECTION], entry);
  r.line([SECTION], 'permit ip any any');
  r.line([['interface', iface]], `ip access-group ${LIST} ${dir}`);
}

const messages = (actions: Parameters<typeof logs>[0]) => logs(actions).map((l) => l.message);

describe('acl.daemon [S12]: log-input', () => {
  it('the first packet of a flow logs at once with the input interface and source MAC; the rest aggregate', () => {
    const r = rig();
    watch(r, `deny tcp host ${PC1} host ${SRV} eq www log-input`);
    const first = r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80), MAC_A), 'in', GI0).actions;
    expect(logs(first)).toEqual([
      { type: 'log', severity: ACL_LOG_SEVERITY, facility: ACL_LOG_FACILITY, message: `list ${LIST} line 10 denied tcp ${PC1}(49152) (${GI0} 001f.0000.0001) -> ${SRV}(80), 1 packet` },
    ]);
    expect(first.filter((a) => a.type === 'timer')).toEqual([{ type: 'timer', key: ACL_LOG_TIMER, delay: ACL_LOG_INTERVAL_NS, periodic: true }]);
    expect(drops(first)).toHaveLength(1);
    // the same flow again: counted only; the same addresses from another MAC are another flow
    expect(messages(r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80), MAC_A), 'in', GI0).actions)).toEqual([]);
    expect(messages(r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80), MAC_A), 'in', GI0).actions)).toEqual([]);
    expect(messages(r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80), MAC_B), 'in', GI0).actions)).toEqual([
      `list ${LIST} line 10 denied tcp ${PC1}(49152) (${GI0} ${macToDotted(MAC_B)}) -> ${SRV}(80), 1 packet`,
    ]);
    expect(r.acl.stateSnapshot().state).toMatchObject({ logFlows: 2 });
    expect(messages(r.acl.onTimer(r.ctx, ACL_LOG_TIMER))).toEqual([
      `list ${LIST} line 10 denied tcp ${PC1}(49152) (${GI0} 001f.0000.0001) -> ${SRV}(80), 2 packets`,
    ]);
    // the MAC_B flow saw no packet since its line: forgotten
    expect(r.acl.stateSnapshot().state).toMatchObject({ logFlows: 1 });
  });

  it('an ICMP or a non-port packet puts the input after the source too; a permit entry logs "permitted"', () => {
    const r = rig();
    watch(r, `permit icmp host ${PC1} any log-input`);
    const a = r.filter(pkt(r, echoRequest(PC1, SRV, 1, 1)), 'in', GI0).actions;
    expect(a[0]).toMatchObject({ type: 'request', to: 'ipv4' });
    expect(messages(a)).toEqual([`list ${LIST} line 10 permitted icmp ${PC1} (${GI0} 001f.0000.0001) -> ${SRV} (8/0), 1 packet`]);
    const r2 = rig();
    watch(r2, `deny 89 host ${PC1} any log-input`);
    const ospf: LayerSpec[] = [{ proto: 'ipv4', fields: { src: PC1, dst: SRV, protocol: 89, ttl: 1, id: 1 } }, { proto: 'payload', fields: { data: new Uint8Array(4) } }];
    expect(messages(r2.filter(pkt(r2, ospf), 'in', GI0).actions)).toEqual([`list ${LIST} line 10 denied ospf ${PC1} (${GI0} 001f.0000.0001) -> ${SRV}, 1 packet`]);
  });

  it('an outbound filter names the packet\'s ingress interface; a locally originated packet logs without input', () => {
    const r = rig();
    watch(r, `deny tcp any host ${SRV} eq www log-input`, GI1, 'out');
    expect(messages(r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80)), 'out', GI1, { inPort: GI0 }).actions)).toEqual([
      `list ${LIST} line 10 denied tcp ${PC1}(49152) (${GI0} 001f.0000.0001) -> ${SRV}(80), 1 packet`,
    ]);
    expect(messages(r.filter(pkt(r, tcpSyn('192.168.20.1', 1024, SRV, 80)), 'out', GI1).actions)).toEqual([
      `list ${LIST} line 10 denied tcp 192.168.20.1(1024) -> ${SRV}(80), 1 packet`,
    ]);
  });

  it('a plain log entry keeps its P3 line exactly (no input)', () => {
    const r = rig();
    watch(r, `deny tcp host ${PC1} host ${SRV} eq www log`);
    expect(messages(r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80)), 'in', GI0).actions)).toEqual([`list ${LIST} line 10 denied tcp ${PC1}(49152) -> ${SRV}(80), 1 packet`]);
  });
});

describe('acl.daemon [S12]: dscp and precedence terms match (RC5 (c): tupleOf with { dscp: true })', () => {
  it('a dscp ef term matches EF only; a packet without a DSCP reads as 0', () => {
    const r = rig();
    watch(r, 'deny ip any any dscp ef');
    expect(drops(r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80, { dscp: 46 })), 'in', GI0).actions)).toHaveLength(1);
    expect(r.table.get(`4|${LIST}|10`)!.matches).toBe(1);
    const af41 = r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80, { dscp: 34 })), 'in', GI0);
    expect(af41.actions).toEqual([af41.onPermit]);
    const none = r.filter(pkt(r, tcpSyn(PC2, 49152, SRV, 80)), 'in', GI0);
    expect(none.actions).toEqual([none.onPermit]);
    expect(r.table.get(`4|${LIST}|20`)!.matches).toBe(2);
    // dscp 0 by number matches the unmarked packet
    const r0 = rig();
    watch(r0, 'deny ip any any dscp 0');
    expect(drops(r0.filter(pkt(r0, tcpSyn(PC2, 49152, SRV, 80)), 'in', GI0).actions)).toHaveLength(1);
  });

  it('a precedence term matches DSCP >> 3', () => {
    const r = rig();
    watch(r, 'deny ip any any precedence critical');
    expect(drops(r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80, { dscp: 46 })), 'in', GI0).actions)).toHaveLength(1);
    const p4 = r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80, { dscp: 34 })), 'in', GI0);
    expect(p4.actions).toEqual([p4.onPermit]);
  });
});

describe('acl.daemon [S12]: log-input in a real world (staged P3)', () => {
  it('PC1\'s pings denied by a log-input entry: one line naming Gi0/0 and PC1\'s MAC, then one aggregated line', () => {
    const sim = world([
      `interface ${GI0}`, ` ip access-group ${LIST} in`, '!',
      `ip access-list extended ${LIST}`, ` deny icmp host ${PC1} any log-input`, ' permit ip any any',
    ]);
    const mac = sim.device('pc1')!.port('GigabitEthernet0')!.mac;
    const t0 = sim.now;
    const { text, evs } = pingFrom(sim, 'pc1', SRV);
    expect(text).toContain(`Sent ${PING_COUNT}, received 0`);
    const lines = (from: typeof evs) => ofKind(from, 'log').filter((l) => l.device === 'r1' && l.facility === 'ACL').map((l) => l.message);
    expect(lines(evs)).toEqual([`list ${LIST} line 10 denied icmp ${PC1} (${GI0} ${macToDotted(mac)}) -> ${SRV} (8/0), 1 packet`]);
    const cursor = sim.trace(0).next;
    sim.runFor(t0 + ACL_LOG_INTERVAL_NS + 10 * SEC - sim.now);
    expect(lines(sim.trace(cursor).events)).toEqual([`list ${LIST} line 10 denied icmp ${PC1} (${GI0} ${macToDotted(mac)}) -> ${SRV} (8/0), ${PING_COUNT - 1} packets`]);
  });
});
