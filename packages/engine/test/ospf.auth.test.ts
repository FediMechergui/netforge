/**
 * ospf.auth — OSPFv2 authentication (ARCHITECTURE-P3C §3.2 steps 1–3, §4.1, §4.3; RFC 2328 Appendix D; §7 W2a ospf
 * [S5]): the pure resolution (the interface line over the area line, `null`, the 8-byte simple key, the youngest MD5
 * key), the cryptographic sequence from the SIMULATION clock, simple and keyed-MD5 adjacencies on `staged.world`, every
 * refusal (type, key, unknown key id, digest) with its drop, row reason and debug line, the check on every packet type
 * (a link-state update refused after a key change), a key changed after Full dropping the adjacency at dead expiry, no
 * MD5 key byte in any PDU while the simple key is visible, the digest against an independent RFC 2328 D.4.3 MD5, a
 * restarted process not refused for its sequence, and `runToIdle` returning in a mismatched world.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import type { PduView } from '../src/contracts/pdu.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { OSPF_AUTH, OSPF_PACKET } from '../src/pdu/codecs/ospf.js';
import { cutToBytes, OSPF_AUTH_NONE, ospfAuthCheck, ospfAuthOf, ospfCryptoSeq, ospfSealLayers } from '../src/protocols/ospf/auth.js';
import { readOspfConfig } from '../src/protocols/ospf/config.js';
import { parseConfigText } from '../src/cli/config-ast.js';
import { addRouter, adminPort, cursor, debugLines, eventsSince, fsmOf, GI0, iface, ifRow, LO0, nbrRows, ospfWorld, setLine } from './ospf.harness.js';

const P2P = ['ip ospf network point-to-point'];
const HELLO_REFUSED = 'ip ospf hello';

/** R1 (1.1.1.1) and R2 (2.2.2.2) on a point-to-point GigE link in area 0, with extra interface and router lines. */
function pair(
  extra: { r1If?: string[]; r2If?: string[]; r1Rtr?: string[]; r2Rtr?: string[]; lo1?: boolean } = {},
  seed = 13,
): { sim: Simulation; pdus: Map<number, PduView>; created: { t: number; device: string; id: number }[] } {
  const sim = ospfWorld(seed);
  const pdus = new Map<number, PduView>();
  const created: { t: number; device: string; id: number }[] = [];
  sim.onTrace((e) => {
    if (e.kind !== 'pduCreated' || e.process !== 'ospf') return;
    const v = sim.pdu(e.pdu.id);
    if (v !== undefined) pdus.set(e.pdu.id, v);
    created.push({ t: e.t, device: e.device, id: e.pdu.id });
  });
  for (const n of [1, 2]) {
    const ifLines = n === 1 ? (extra.r1If ?? []) : (extra.r2If ?? []);
    const rtr = n === 1 ? (extra.r1Rtr ?? []) : (extra.r2Rtr ?? []);
    addRouter(sim, `r${n}`, `R${n}`, [
      iface(GI0, `10.0.12.${n}`, '255.255.255.252', [...P2P, ...ifLines]),
      ...(n === 1 && extra.lo1 === true ? [iface(LO0, '1.1.1.1', '255.255.255.255', [], false)] : []),
      ['router ospf 1', ` router-id ${n}.${n}.${n}.${n}`, ' network 10.0.12.0 0.0.0.3 area 0', ' network 1.1.1.1 0.0.0.0 area 0', ...rtr.map((l) => ` ${l}`)],
    ]);
  }
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
  sim.runFor(60 * SEC);
  return { sim, pdus, created };
}

const states = (sim: Simulation, device: string): string[][] => nbrRows(sim, device).map((n) => [n.routerId, n.state]);
const drops = (evs: readonly TraceEvent[], device: string): Extract<TraceEvent, { kind: 'drop' }>[] =>
  evs.filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop' && e.device === device && e.pdu.summary.startsWith('OSPF'));
const ospfLayer = (v: PduView) => v.layer('ospf')!;
const MD5 = ['ip ospf authentication message-digest', 'ip ospf message-digest-key 1 md5 s3cret-md5'];
const SIMPLE = (k: string): string[] => ['ip ospf authentication', `ip ospf authentication-key ${k}`];

describe('[S5] the pure resolution (protocols/ospf/auth.ts)', () => {
  const cfgOf = (text: string) => readOspfConfig(parseConfigText(text));
  const base = (ifLines: string[], rtr: string[] = []): string =>
    ['interface GigabitEthernet0/0', ...ifLines.map((l) => ` ${l}`), '!', 'router ospf 1', ' network 10.0.0.0 0.255.255.255 area 0', ...rtr.map((l) => ` ${l}`), '!', 'end', ''].join('\n');

  it('the interface line wins over the area line; null forces none; absent both, none', () => {
    expect(ospfAuthOf(cfgOf(base([])), GI0, '0.0.0.0')).toEqual(OSPF_AUTH_NONE);
    expect(ospfAuthOf(cfgOf(base([], ['area 0 authentication'])), GI0, '0.0.0.0')).toEqual({ mode: 'simple', key: '' });
    expect(ospfAuthOf(cfgOf(base([], ['area 0 authentication'])), GI0, '0.0.0.1')).toEqual(OSPF_AUTH_NONE);
    expect(ospfAuthOf(cfgOf(base(['ip ospf authentication null'], ['area 0 authentication message-digest'])), GI0, '0.0.0.0')).toEqual(OSPF_AUTH_NONE);
    expect(ospfAuthOf(cfgOf(base(['ip ospf authentication', 'ip ospf authentication-key k1'], ['area 0 authentication message-digest'])), GI0, '0.0.0.0')).toEqual({ mode: 'simple', key: 'k1' });
    const md5 = ospfAuthOf(cfgOf(base(['ip ospf message-digest-key 3 md5 aa', 'ip ospf message-digest-key 1 md5 bb'], ['area 0.0.0.0 authentication message-digest'])), GI0, '0.0.0.0');
    expect(md5).toEqual({ mode: 'md5', keys: new Map([[3, 'aa'], [1, 'bb']]), youngest: { id: 1, key: 'bb' } });
    // without any key line: key id 0, empty secret
    expect(ospfAuthOf(cfgOf(base(['ip ospf authentication message-digest'])), GI0, '0.0.0.0')).toEqual({ mode: 'md5', keys: new Map([[0, '']]), youngest: { id: 0, key: '' } });
  });

  it('the simple key is cut to 8 bytes, an MD5 key to 16, never inside a character', () => {
    expect(ospfAuthOf(cfgOf(base(['ip ospf authentication', 'ip ospf authentication-key abcdefghij'])), GI0, '0.0.0.0')).toEqual({ mode: 'simple', key: 'abcdefgh' });
    expect(cutToBytes('0123456789abcdefXYZ', 16)).toBe('0123456789abcdef');
    expect(cutToBytes('abcdefgé', 8)).toBe('abcdefg');
  });

  it('the cryptographic sequence is whole seconds of the simulation clock', () => {
    expect(ospfCryptoSeq(0)).toBe(0);
    expect(ospfCryptoSeq(61 * SEC - 1)).toBe(60);
    expect(ospfCryptoSeq(61 * SEC)).toBe(61);
  });

  it('unauthenticated layers are returned as they are; a lower sequence is refused, an equal one accepted', () => {
    const layers = [{ proto: 'ospf' as const, fields: { type: OSPF_PACKET.hello, routerId: '1.1.1.1', area: '0.0.0.0', mask: '255.255.255.252' } }];
    expect(ospfSealLayers(layers, OSPF_AUTH_NONE, 5 * SEC)).toBe(layers);
    const auth = { mode: 'md5' as const, keys: new Map([[4, 'k']]), youngest: { id: 4, key: 'k' } };
    const bytes = encodeLayers(ospfSealLayers(layers, auth, 5 * SEC + 7));
    const f = decodeLayers(bytes, 'ospf')[0]!.fields;
    expect(f).toMatchObject({ auType: OSPF_AUTH.md5, keyId: 4, cryptoSeq: 5 });
    expect(ospfAuthCheck(auth, f, bytes, 4)).toEqual({ ok: true, seq: 5 });
    expect(ospfAuthCheck(auth, f, bytes, 5)).toEqual({ ok: true, seq: 5 });
    expect(ospfAuthCheck(auth, f, bytes, 6)).toEqual({ ok: false, reason: 'sequence', text: 'cryptographic sequence number 5 is lower than the last one received (6)' });
    expect(ospfAuthCheck({ ...auth, keys: new Map([[4, 'x']]) }, f, bytes, undefined)).toMatchObject({ ok: false, reason: 'digest' });
    expect(ospfAuthCheck(OSPF_AUTH_NONE, f, bytes, undefined)).toEqual({ ok: false, reason: 'type', text: "authentication type 2 does not match this interface's type 0" });
  });
});

describe('[S5] simple authentication (type 1)', () => {
  it('reaches Full with the key in clear in every packet; a 10-character key is sent as its first 8', () => {
    const { sim, pdus, created } = pair({ r1If: SIMPLE('abcdefghij'), r2If: SIMPLE('abcdefgh') });
    expect(states(sim, 'r1')).toEqual([['2.2.2.2', 'full']]);
    expect(states(sim, 'r2')).toEqual([['1.1.1.1', 'full']]);
    expect(ifRow(sim, 'r1', GI0)).toMatchObject({ auth: 'simple' });
    expect(ifRow(sim, 'r1', GI0)!.authKeyId).toBeUndefined();
    expect(created.length).toBeGreaterThan(4);
    for (const c of created) {
      const v = pdus.get(c.id)!;
      expect(ospfLayer(v).fields).toMatchObject({ auType: OSPF_AUTH.simple, authKey: 'abcdefgh' });
      expect(Buffer.from(v.bytes).includes(Buffer.from('abcdefgh'))).toBe(true);
    }
  });

  it('refuses a key mismatch with its reason, drop and debug line', () => {
    const { sim } = pair({ r1If: SIMPLE('alpha'), r2If: SIMPLE('beta') });
    const evs = eventsSince(sim, 0);
    expect(states(sim, 'r1')).toEqual([]);
    expect(states(sim, 'r2')).toEqual([]);
    const text = "the authentication key does not match this interface's key";
    expect(ifRow(sim, 'r2', GI0)!.rejected).toMatchObject({ from: '10.0.12.1', routerId: '1.1.1.1', reason: text });
    expect(debugLines(evs, 'r2', HELLO_REFUSED).map((l) => l.message)).toContain(`${GI0}: hello from 1.1.1.1 (10.0.12.1) refused: ${text}`);
    expect(drops(evs, 'r2')[0]).toMatchObject({ reason: 'other', detail: `OSPF hello refused: ${text}`, port: GI0 });
  });

  it('refuses a type mismatch in both directions', () => {
    const { sim } = pair({ r1If: SIMPLE('alpha') });
    const evs = eventsSince(sim, 0);
    expect(states(sim, 'r1')).toEqual([]);
    expect(states(sim, 'r2')).toEqual([]);
    expect(ifRow(sim, 'r2', GI0)!.rejected!.reason).toBe("authentication type 1 does not match this interface's type 0");
    expect(ifRow(sim, 'r1', GI0)!.rejected!.reason).toBe("authentication type 0 does not match this interface's type 1");
    expect(drops(evs, 'r1').every((d) => d.reason === 'other')).toBe(true);
    // a mismatched world still idles (rule 19)
    const stats = sim.runToIdle();
    expect(stats).toBeDefined();
    expect(states(sim, 'r1')).toEqual([]);
  });
});

describe('[S5] keyed MD5 (type 2)', () => {
  it('reaches Full through the area line; the digest is RFC 2328 D.4.3; no key byte in any PDU; cryptoSeq is the sim clock', () => {
    const { sim, pdus, created } = pair({ r1If: ['ip ospf message-digest-key 1 md5 s3cret-md5'], r2If: ['ip ospf message-digest-key 1 md5 s3cret-md5'], r1Rtr: ['area 0 authentication message-digest'], r2Rtr: ['area 0 authentication message-digest'] });
    expect(states(sim, 'r1')).toEqual([['2.2.2.2', 'full']]);
    expect(states(sim, 'r2')).toEqual([['1.1.1.1', 'full']]);
    expect(ifRow(sim, 'r2', GI0)).toMatchObject({ auth: 'md5', authKeyId: 1 });
    const kinds = new Set<number>();
    for (const c of created) {
      const v = pdus.get(c.id)!;
      const o = ospfLayer(v);
      kinds.add(o.fields.type as number);
      expect(o.fields).toMatchObject({ auType: OSPF_AUTH.md5, keyId: 1, cryptoSeq: Math.floor(c.t / SEC), checksum: 0 });
      expect(Buffer.from(v.bytes).includes(Buffer.from('s3cret-md5'))).toBe(false);
      // an independent keyed MD5 over the packet (its length octets) followed by the key padded to 16
      const len = (v.bytes[o.offset + 2]! << 8) | v.bytes[o.offset + 3]!;
      const data = Buffer.concat([Buffer.from(v.bytes.subarray(o.offset, o.offset + len)), Buffer.from('s3cret-md5'), Buffer.alloc(6)]);
      expect(Buffer.from(v.bytes.subarray(o.offset + len, o.offset + len + 16)).toString('hex')).toBe(createHash('md5').update(data).digest('hex'));
    }
    // every packet type of an adjacency was signed
    expect([...kinds].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('signs with the youngest key (the last line)', () => {
    const keys = ['ip ospf message-digest-key 1 md5 one', 'ip ospf message-digest-key 2 md5 two'];
    const { sim, pdus, created } = pair({ r1If: ['ip ospf authentication message-digest', ...keys], r2If: ['ip ospf authentication message-digest', ...keys] });
    expect(states(sim, 'r1')).toEqual([['2.2.2.2', 'full']]);
    expect(ifRow(sim, 'r1', GI0)!.authKeyId).toBe(2);
    expect(ospfLayer(pdus.get(created[0]!.id)!).fields.keyId).toBe(2);
  });

  it('refuses a wrong key (digest) and an unknown key id', () => {
    const wrong = pair({ r1If: MD5, r2If: ['ip ospf authentication message-digest', 'ip ospf message-digest-key 1 md5 other'] });
    expect(states(wrong.sim, 'r2')).toEqual([]);
    expect(ifRow(wrong.sim, 'r2', GI0)!.rejected!.reason).toBe('the message digest does not match key 1');
    const unknown = pair({ r1If: MD5, r2If: ['ip ospf authentication message-digest', 'ip ospf message-digest-key 7 md5 s3cret-md5'] });
    expect(states(unknown.sim, 'r2')).toEqual([]);
    expect(ifRow(unknown.sim, 'r2', GI0)!.rejected!.reason).toBe('message-digest key 1 is not configured on this interface');
    expect(drops(eventsSince(unknown.sim, 0), 'r2')[0]!.detail).toBe('OSPF hello refused: message-digest key 1 is not configured on this interface');
  });

  it('`ip ospf authentication null` overrides the area line', () => {
    const { sim } = pair({ r1If: ['ip ospf authentication null'], r1Rtr: ['area 0 authentication message-digest'] });
    expect(states(sim, 'r1')).toEqual([['2.2.2.2', 'full']]);
    expect(ifRow(sim, 'r1', GI0)!.auth).toBeUndefined();
  });

  it('checks every packet type: after a key change the next update is refused, and the adjacency drops at dead expiry', () => {
    const { sim } = pair({ r1If: MD5, r2If: MD5, lo1: true });
    expect(states(sim, 'r1')).toEqual([['2.2.2.2', 'full']]);
    const c = cursor(sim);
    setLine(sim, 'r2', [['interface', GI0]], ['ip', 'ospf', 'message-digest-key', '1', 'md5', 'changed']);
    adminPort(sim, 'r1', LO0, true);
    sim.runFor(60 * SEC);
    const evs = eventsSince(sim, c);
    const text = 'the message digest does not match key 1';
    expect(debugLines(evs, 'r2', 'ip ospf packet').map((l) => l.message)).toContain(`${GI0}: link-state update from 1.1.1.1 (10.0.12.1) refused: ${text}`);
    expect(drops(evs, 'r2').map((d) => d.detail)).toContain(`OSPF link-state update refused: ${text}`);
    // the dead interval runs from the last hello R1 accepted from R2
    const accepted = debugLines(eventsSince(sim, 0), 'r1', HELLO_REFUSED).filter((l) => l.message.startsWith(`${GI0}: hello from 2.2.2.2 (10.0.12.2): priority`));
    expect(accepted.length).toBeGreaterThan(0);
    const lastOk = accepted[accepted.length - 1]!.t;
    const down = fsmOf(evs, 'r1', 'ospf-nbr', `${GI0} 2.2.2.2`).find((f) => f.to === 'down');
    expect(down).toBeDefined();
    expect(down!.t).toBe(lastOk + 40 * SEC);
    expect(down!.cause).toMatch(/inactivity/i);
    expect(states(sim, 'r1')).toEqual([]);
    expect(ifRow(sim, 'r1', GI0)!.rejected!.reason).toBe(text);
  });

  it('a process restarted in one instant is not refused for its sequence (the simulation clock, not process time)', () => {
    const { sim, pdus, created } = pair({ r1If: MD5, r2If: MD5 });
    expect(states(sim, 'r1')).toEqual([['2.2.2.2', 'full']]);
    const before = created.filter((c) => c.device === 'r2').map((c) => ospfLayer(pdus.get(c.id)!).fields.cryptoSeq as number);
    const c = cursor(sim);
    const at = created.length;
    const r = sim.configure('r2', ['no router ospf 1', 'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.12.0 0.0.0.3 area 0', 'end']);
    expect(r.ok).toBe(true);
    sim.runFor(60 * SEC);
    const evs = eventsSince(sim, c);
    expect(states(sim, 'r1')).toEqual([['2.2.2.2', 'full']]);
    expect(debugLines(evs, 'r1', HELLO_REFUSED).filter((l) => l.message.includes('refused'))).toEqual([]);
    const after = created.slice(at).filter((x) => x.device === 'r2').map((x) => ospfLayer(pdus.get(x.id)!).fields.cryptoSeq as number);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!).toBeGreaterThanOrEqual(Math.max(...before));
  });
});
