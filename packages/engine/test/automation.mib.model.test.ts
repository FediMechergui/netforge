/**
 * automation/mib/model.ts — the §3.5 MIB subset as data, its readers, and the Q10 legal rules (L1, L2). [S33]
 */
import { describe, expect, it } from 'vitest';
import {
  MIB_ENTERPRISE_ARC,
  MIB_ENTERPRISE_NUMBER,
  MIB_OBJECTS,
  MIB_TRAP_DESCRIPTIONS,
  MIB_TRAP_OIDS,
  SNMP_MAX_BULK,
  compareOids,
  isOid,
  mibGet,
  mibGetBulk,
  mibGetNext,
  mibGroupObjects,
  mibInstanceOid,
  mibInstances,
  mibObject,
  mibObjectOfOid,
  mibOidName,
  mibSysDescr,
  mibSysObjectId,
  mibTrapOfOid,
  mibTrapVarbinds,
  mibWalk,
  planMibSet,
  type MibDeviceView,
  type MibInterfaceView,
} from '../src/automation/mib/model.js';
import { findBannedWords } from '../src/device/catalog/validate.js';

/** The automation tool name Q10 / L3 bans, matched case-insensitively (built reversed so this file never spells it). */
const TOOL_WORD = new RegExp([...'elbisna'].reverse().join(''), 'i');

const iface = (ifIndex: number, descr: string, name: string, over: Partial<MibInterfaceView> = {}): MibInterfaceView => ({
  ifIndex, descr, name, kind: 'ethernet', mtu: 1500, speedBps: 1_000_000_000, physAddress: `0011.2233.44${ifIndex.toString(16).padStart(2, '0')}`,
  adminUp: true, operUp: true, inOctets: 100 * ifIndex, inErrors: 0, outOctets: 200 * ifIndex, outErrors: 0, ...over,
});

const DEV: MibDeviceView = {
  sysDescr: mibSysDescr('NF-2911', '15.7'),
  sysObjectId: mibSysObjectId(3),
  upTime: 12345,
  contact: 'Lab desk',
  name: 'R1',
  location: 'Rack 2',
  routes: true,
  interfaces: [
    iface(3, 'Loopback0', 'Lo0', { kind: 'virtual', physAddress: undefined, speedBps: 8_000_000_000 }),
    iface(1, 'GigabitEthernet0/0', 'Gi0/0'),
    iface(2, 'GigabitEthernet0/1', 'Gi0/1', { adminUp: false, operUp: false, inOctets: 2 ** 32 + 7 }),
  ],
};

describe('the §3.5 table', () => {
  it('lists exactly the §3.5 objects, with their IETF OIDs, types and access', () => {
    const rows = MIB_OBJECTS.map((o) => [o.name, o.instance === 'scalar' ? mibInstanceOid(o) : o.oid, o.syntax, o.access]);
    expect(rows).toEqual([
      ['sysDescr', '1.3.6.1.2.1.1.1.0', 'octets', 'ro'],
      ['sysObjectID', '1.3.6.1.2.1.1.2.0', 'oid', 'ro'],
      ['sysUpTime', '1.3.6.1.2.1.1.3.0', 'timeticks', 'ro'],
      ['sysContact', '1.3.6.1.2.1.1.4.0', 'octets', 'rw'],
      ['sysName', '1.3.6.1.2.1.1.5.0', 'octets', 'rw'],
      ['sysLocation', '1.3.6.1.2.1.1.6.0', 'octets', 'rw'],
      ['ifNumber', '1.3.6.1.2.1.2.1.0', 'integer', 'ro'],
      ['ifIndex', '1.3.6.1.2.1.2.2.1.1', 'integer', 'ro'],
      ['ifDescr', '1.3.6.1.2.1.2.2.1.2', 'octets', 'ro'],
      ['ifType', '1.3.6.1.2.1.2.2.1.3', 'integer', 'ro'],
      ['ifMtu', '1.3.6.1.2.1.2.2.1.4', 'integer', 'ro'],
      ['ifSpeed', '1.3.6.1.2.1.2.2.1.5', 'gauge32', 'ro'],
      ['ifPhysAddress', '1.3.6.1.2.1.2.2.1.6', 'octets', 'ro'],
      ['ifAdminStatus', '1.3.6.1.2.1.2.2.1.7', 'integer', 'rw'],
      ['ifOperStatus', '1.3.6.1.2.1.2.2.1.8', 'integer', 'ro'],
      ['ifInOctets', '1.3.6.1.2.1.2.2.1.10', 'counter32', 'ro'],
      ['ifInErrors', '1.3.6.1.2.1.2.2.1.14', 'counter32', 'ro'],
      ['ifOutOctets', '1.3.6.1.2.1.2.2.1.16', 'counter32', 'ro'],
      ['ifOutErrors', '1.3.6.1.2.1.2.2.1.20', 'counter32', 'ro'],
      ['ipForwarding', '1.3.6.1.2.1.4.1.0', 'integer', 'ro'],
      ['ifName', '1.3.6.1.2.1.31.1.1.1.1', 'octets', 'ro'],
      ['snmpTrapOID', '1.3.6.1.6.3.1.1.4.1.0', 'oid', 'notify'],
    ]);
    for (let i = 1; i < MIB_OBJECTS.length; i++) expect(compareOids(MIB_OBJECTS[i - 1]!.oid, MIB_OBJECTS[i]!.oid)).toBe(-1);
    expect(mibGroupObjects('system').map((o) => o.name)).toEqual(['sysDescr', 'sysObjectID', 'sysUpTime', 'sysContact', 'sysName', 'sysLocation']);
    expect(mibObject('ifType')!.enums).toEqual({ 6: 'ethernet', 22: 'serial', 24: 'loopback', 53: 'virtual' });
  });

  it('the trap identifiers are the standard ones', () => {
    expect(MIB_TRAP_OIDS).toEqual({
      coldStart: '1.3.6.1.6.3.1.1.5.1', linkDown: '1.3.6.1.6.3.1.1.5.3', linkUp: '1.3.6.1.6.3.1.1.5.4', authenticationFailure: '1.3.6.1.6.3.1.1.5.5',
    });
    expect(mibTrapOfOid('.1.3.6.1.6.3.1.1.5.3')).toBe('linkDown');
    expect(mibTrapOfOid('1.3.6.1.6.3.1.1.5.2')).toBeUndefined();
  });

  it('every object OID is an IETF standard one: under mib-2 or snmpV2, never an enterprise arc', () => {
    for (const o of MIB_OBJECTS) expect(o.oid.startsWith('1.3.6.1.2.1.') || o.oid.startsWith('1.3.6.1.6.3.'), o.name).toBe(true);
    for (const t of Object.values(MIB_TRAP_OIDS)) expect(t.startsWith('1.3.6.1.6.3.1.1.5.')).toBe(true);
  });
});

describe('legal (Q10)', () => {
  it('L1: sysObjectID is 1.3.6.1.4.1.32473.1.<model index> (RFC 5612)', () => {
    expect(MIB_ENTERPRISE_NUMBER).toBe(32473);
    expect(MIB_ENTERPRISE_ARC).toBe('1.3.6.1.4.1.32473');
    expect(mibSysObjectId(1)).toBe('1.3.6.1.4.1.32473.1.1');
    expect(mibSysObjectId(14)).toBe('1.3.6.1.4.1.32473.1.14');
    expect(() => mibSysObjectId(0)).toThrow(RangeError);
    expect(() => mibSysObjectId(1.5)).toThrow(RangeError);
    expect(mibGet(DEV, '1.3.6.1.2.1.1.2.0')).toEqual({ type: 'oid', value: '1.3.6.1.4.1.32473.1.3' });
  });

  it('L2: every learner-visible string is free of vendor words and of the banned tool name', () => {
    const texts = [
      ...MIB_OBJECTS.flatMap((o) => [o.name, o.description, ...Object.values(o.enums ?? {})]),
      ...Object.keys(MIB_TRAP_DESCRIPTIONS), ...Object.values(MIB_TRAP_DESCRIPTIONS),
      mibSysDescr('NF-2911', '15.7'),
    ];
    for (const t of texts) {
      expect(findBannedWords(t), t).toEqual([]);
      expect(TOOL_WORD.test(t), t).toBe(false);
    }
    expect(mibSysDescr('NF-2911', '15.7')).toBe('NetForge NF-2911 running NF-OS version 15.7 (simulated device)');
  });

  it('L2: every description is written out, distinct, and ends as a sentence', () => {
    const ds = MIB_OBJECTS.map((o) => o.description);
    expect(new Set(ds).size).toBe(ds.length);
    for (const d of ds) expect(d).toMatch(/^[A-Z0-9].{10,}\.$/);
  });
});

describe('OIDs', () => {
  it('validates, orders and names OIDs', () => {
    expect(isOid('1.3.6.1')).toBe(true);
    expect(isOid('.1.3.6.1')).toBe(true);
    expect(isOid('1')).toBe(false);
    expect(isOid('1.03')).toBe(false);
    expect(isOid('1.3.x')).toBe(false);
    expect(isOid('1.4294967296')).toBe(false);
    expect(compareOids('1.3.6.1.2.1.2.2.1.10.1', '1.3.6.1.2.1.2.2.1.2.1')).toBe(1);
    expect(compareOids('1.3.6', '1.3.6.1')).toBe(-1);
    expect(compareOids('.1.3.6', '1.3.6')).toBe(0);
    expect(mibOidName('1.3.6.1.2.1.1.5.0')).toBe('sysName.0');
    expect(mibOidName('1.3.6.1.2.1.2.2.1.2.3')).toBe('ifDescr.3');
    expect(mibOidName('1.3.6.1.2.1.2.2.1.2')).toBe('ifDescr');
    expect(mibOidName('1.3.6.1.6.3.1.1.5.4')).toBe('linkUp');
    expect(mibOidName('1.3.6.1.4.1.9')).toBe('1.3.6.1.4.1.9');
    expect(mibObjectOfOid('1.3.6.1.2.1.31.1.1.1.1.2')).toEqual({ object: mibObject('ifName'), instance: '2' });
  });
});

describe('GET, GETNEXT, GETBULK and walk', () => {
  it('GET answers by exact OID, with the RFC 3416 exceptions', () => {
    expect(mibGet(DEV, '1.3.6.1.2.1.1.5.0')).toEqual({ type: 'octets', value: 'R1' });
    expect(mibGet(DEV, '1.3.6.1.2.1.1.3.0')).toEqual({ type: 'timeticks', value: 12345 });
    expect(mibGet(DEV, '1.3.6.1.2.1.2.1.0')).toEqual({ type: 'integer', value: 3 });
    expect(mibGet(DEV, '1.3.6.1.2.1.4.1.0')).toEqual({ type: 'integer', value: 1 });
    expect(mibGet({ ...DEV, routes: false }, '1.3.6.1.2.1.4.1.0')).toEqual({ type: 'integer', value: 2 });
    expect(mibGet(DEV, '1.3.6.1.2.1.2.2.1.3.3')).toEqual({ type: 'integer', value: 53 });
    expect(mibGet(DEV, '1.3.6.1.2.1.2.2.1.6.1')).toEqual({ type: 'octets', value: '\x00\x11\x22\x33\x44\x01' });
    expect(mibGet(DEV, '1.3.6.1.2.1.2.2.1.6.3')).toEqual({ type: 'octets', value: '' });
    expect(mibGet(DEV, '1.3.6.1.2.1.2.2.1.5.3')).toEqual({ type: 'gauge32', value: 4294967295 });
    expect(mibGet(DEV, '1.3.6.1.2.1.2.2.1.7.2')).toEqual({ type: 'integer', value: 2 });
    expect(mibGet(DEV, '1.3.6.1.2.1.2.2.1.10.2')).toEqual({ type: 'counter32', value: 7 });
    expect(mibGet(DEV, '1.3.6.1.2.1.31.1.1.1.1.1')).toEqual({ type: 'octets', value: 'Gi0/0' });
    expect(mibGet(DEV, '1.3.6.1.2.1.1.5.1')).toEqual({ type: 'noSuchInstance' });
    expect(mibGet(DEV, '1.3.6.1.2.1.1.5')).toEqual({ type: 'noSuchInstance' });
    expect(mibGet(DEV, '1.3.6.1.2.1.2.2.1.2.9')).toEqual({ type: 'noSuchInstance' });
    expect(mibGet(DEV, '1.3.6.1.2.1.1.9.0')).toEqual({ type: 'noSuchObject' });
    expect(mibGet(DEV, '1.3.6.1.6.3.1.1.4.1.0')).toEqual({ type: 'noSuchObject' });
  });

  it('GETNEXT walks in lexicographic order and ends with endOfMibView', () => {
    expect(mibGetNext(DEV, '1.3.6.1.2.1.1')).toEqual({ oid: '1.3.6.1.2.1.1.1.0', value: { type: 'octets', value: DEV.sysDescr } });
    expect(mibGetNext(DEV, '1.3.6.1.2.1.2.2.1.2.3').oid).toBe('1.3.6.1.2.1.2.2.1.3.1');
    expect(mibGetNext(DEV, '1.3.6.1.2.1.31.1.1.1.1.3')).toEqual({ oid: '1.3.6.1.2.1.31.1.1.1.1.3', value: { type: 'endOfMibView' } });
    const all = mibInstances(DEV);
    expect(all).toHaveLength(8 + 13 * 3);
    for (let i = 1; i < all.length; i++) expect(compareOids(all[i - 1]!.oid, all[i]!.oid)).toBe(-1);
  });

  it('a walk of ifDescr prints one line per interface, in ifIndex order', () => {
    expect(mibWalk(DEV, '1.3.6.1.2.1.2.2.1.2').map((v) => [v.oid, v.value])).toEqual([
      ['1.3.6.1.2.1.2.2.1.2.1', { type: 'octets', value: 'GigabitEthernet0/0' }],
      ['1.3.6.1.2.1.2.2.1.2.2', { type: 'octets', value: 'GigabitEthernet0/1' }],
      ['1.3.6.1.2.1.2.2.1.2.3', { type: 'octets', value: 'Loopback0' }],
    ]);
    expect(mibWalk(DEV, '1.3.6.1.2.1.1').map((v) => mibOidName(v.oid))).toEqual(['sysDescr.0', 'sysObjectID.0', 'sysUpTime.0', 'sysContact.0', 'sysName.0', 'sysLocation.0']);
  });

  it('GETBULK: non-repeaters first, then repetitions row by row, capped at SNMP_MAX_BULK', () => {
    const r = mibGetBulk(DEV, ['1.3.6.1.2.1.1.4.0', '1.3.6.1.2.1.2.2.1.2', '1.3.6.1.2.1.2.2.1.8'], 1, 2);
    expect(r.map((v) => mibOidName(v.oid))).toEqual(['sysName.0', 'ifDescr.1', 'ifOperStatus.1', 'ifDescr.2', 'ifOperStatus.2']);
    expect(SNMP_MAX_BULK).toBe(32);
    expect(mibGetBulk(DEV, ['1.3.6.1'], 0, 100)).toHaveLength(32);
    const tail = mibGetBulk(DEV, ['1.3.6.1.2.1.31.1.1.1.1.2'], 0, 3);
    expect(tail.map((v) => v.value.type)).toEqual(['octets', 'endOfMibView', 'endOfMibView']);
  });
});

describe('SET planning', () => {
  it('sysName, sysContact, sysLocation and ifAdminStatus become configuration lines', () => {
    expect(planMibSet(DEV, '1.3.6.1.2.1.1.5.0', { type: 'octets', value: 'CORE1' })).toEqual({ ok: true, lines: ['hostname CORE1'] });
    expect(planMibSet(DEV, '1.3.6.1.2.1.1.4.0', { type: 'octets', value: 'NOC x123' })).toEqual({ ok: true, lines: ['snmp-server contact NOC x123'] });
    expect(planMibSet(DEV, '1.3.6.1.2.1.1.6.0', { type: 'octets', value: 'Room 4' })).toEqual({ ok: true, lines: ['snmp-server location Room 4'] });
    expect(planMibSet(DEV, '1.3.6.1.2.1.1.6.0', { type: 'octets', value: '' })).toEqual({ ok: true, lines: ['no snmp-server location'] });
    expect(planMibSet(DEV, '1.3.6.1.2.1.2.2.1.7.2', { type: 'integer', value: 1 })).toEqual({ ok: true, lines: ['interface GigabitEthernet0/1', ' no shutdown'] });
    expect(planMibSet(DEV, '1.3.6.1.2.1.2.2.1.7.1', { type: 'integer', value: 2 })).toEqual({ ok: true, lines: ['interface GigabitEthernet0/0', ' shutdown'] });
  });

  it('other objects answer notWritable, a wrong type wrongType, a bad value wrongValue', () => {
    expect(planMibSet(DEV, '1.3.6.1.2.1.1.1.0', { type: 'octets', value: 'x' })).toEqual({ ok: false, error: 'notWritable' });
    expect(planMibSet(DEV, '1.3.6.1.2.1.1.9.0', { type: 'octets', value: 'x' })).toEqual({ ok: false, error: 'notWritable' });
    expect(planMibSet(DEV, '1.3.6.1.2.1.2.2.1.7.9', { type: 'integer', value: 1 })).toEqual({ ok: false, error: 'notWritable' });
    expect(planMibSet(DEV, '1.3.6.1.2.1.1.5.0', { type: 'integer', value: 1 })).toEqual({ ok: false, error: 'wrongType' });
    expect(planMibSet(DEV, '1.3.6.1.2.1.2.2.1.7.1', { type: 'octets', value: 'up' })).toEqual({ ok: false, error: 'wrongType' });
    expect(planMibSet(DEV, '1.3.6.1.2.1.2.2.1.7.1', { type: 'integer', value: 3 })).toEqual({ ok: false, error: 'wrongValue' });
    expect(planMibSet(DEV, '1.3.6.1.2.1.1.5.0', { type: 'octets', value: 'two words' })).toEqual({ ok: false, error: 'wrongValue' });
  });
});

describe('traps', () => {
  it('coldStart carries sysUpTime.0 and snmpTrapOID.0; link traps add ifIndex, ifAdminStatus, ifOperStatus', () => {
    expect(mibTrapVarbinds(DEV, 'coldStart')).toEqual([
      { oid: '1.3.6.1.2.1.1.3.0', value: { type: 'timeticks', value: 12345 } },
      { oid: '1.3.6.1.6.3.1.1.4.1.0', value: { type: 'oid', value: '1.3.6.1.6.3.1.1.5.1' } },
    ]);
    expect(mibTrapVarbinds(DEV, 'linkDown', 2)).toEqual([
      { oid: '1.3.6.1.2.1.1.3.0', value: { type: 'timeticks', value: 12345 } },
      { oid: '1.3.6.1.6.3.1.1.4.1.0', value: { type: 'oid', value: '1.3.6.1.6.3.1.1.5.3' } },
      { oid: '1.3.6.1.2.1.2.2.1.1.2', value: { type: 'integer', value: 2 } },
      { oid: '1.3.6.1.2.1.2.2.1.7.2', value: { type: 'integer', value: 2 } },
      { oid: '1.3.6.1.2.1.2.2.1.8.2', value: { type: 'integer', value: 2 } },
    ]);
    expect(() => mibTrapVarbinds(DEV, 'linkUp', 9)).toThrow(RangeError);
  });
});
