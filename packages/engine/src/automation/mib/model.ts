/**
 * The MIB subset a NetForge device serves over SNMP (ARCHITECTURE-P3C §3.5, §7 W1b auto, [S33]). @since P3c
 *
 * One pure data table lists every object the agent answers for — its standard name, its IETF OID, its syntax and its
 * access — and a few readers serve GET, GETNEXT, GETBULK, SET planning and trap varbinds over a plain device view, so
 * the agent daemon (W2b) only gathers the view and does the I/O. It mirrors `automation/yang/model.ts`.
 *
 * OIDS. Every object uses its IETF-standard OID (MIB-II and the interfaces group, RFC 1213 / RFC 2863 / RFC 3418; the
 * trap identifiers of RFC 3418). No vendor arc is used anywhere. `sysObjectID.0` answers
 * `1.3.6.1.4.1.32473.1.<model index>`: 32473 is the enterprise number RFC 5612 reserves for documentation, kept until
 * NetForge holds its own number (decision Q10 / L1); changing it is the one constant `MIB_ENTERPRISE_NUMBER`.
 *
 * WORDING. The object names are the identifiers the protocol requires. Every description below is NetForge's own
 * wording, written for the learner (decision Q10 / L2); no MIB module text is copied.
 *
 * SIMPLIFICATIONS (CATALOG fidelity rows). `ifType` is 53 (propVirtual) for every virtual interface. Counters are
 * Counter32 and wrap at 2³². `ifPhysAddress` is the six address bytes, one Latin-1 character per byte (the snmp codec's
 * octet-string form), so a manager shows it in hex.
 *
 * Rule 12: the table is plain data; the lookup maps are built lazily on first use. No clock, no rng, no device state:
 * the device view is the caller's.
 */
import type { SnmpValue } from '../../contracts/process.js';

// ── the enterprise arc (L1) ──────────────────────────────────────────────────

/** The enterprise number `sysObjectID` uses: RFC 5612's documentation number, until NetForge has its own (Q10, L1). */
export const MIB_ENTERPRISE_NUMBER = 32473;

/** The enterprise arc (`1.3.6.1.4.1.32473`). */
export const MIB_ENTERPRISE_ARC = `1.3.6.1.4.1.${MIB_ENTERPRISE_NUMBER}`;

/** The arc under which each NetForge model has its identifier (`…32473.1.<model index>`). */
export const MIB_PRODUCTS_ARC = `${MIB_ENTERPRISE_ARC}.1`;

/** The `sysObjectID.0` value of the model with this index (a positive integer). */
export function mibSysObjectId(modelIndex: number): string {
  if (!Number.isInteger(modelIndex) || modelIndex < 1) throw new RangeError(`model index must be a positive integer, got ${modelIndex}`);
  return `${MIB_PRODUCTS_ARC}.${modelIndex}`;
}

/** The `sysDescr.0` text: original wording naming the NF model and its NF-OS version. */
export function mibSysDescr(model: string, osVersion: string): string {
  return `NetForge ${model} running NF-OS version ${osVersion} (simulated device)`;
}

/** The most varbinds one GETBULK answer carries (§3.5). */
export const SNMP_MAX_BULK = 32;

/** The largest Counter32 / Gauge32 / TimeTicks value (2³² − 1). */
export const MIB_UINT32_MAX = 4294967295;

// ── the table ────────────────────────────────────────────────────────────────

export type MibGroup = 'system' | 'interfaces' | 'ifTable' | 'ifXTable' | 'ip' | 'traps';

/** The value types the subset uses (a subset of `SnmpValue['type']`). */
export type MibSyntax = 'integer' | 'octets' | 'oid' | 'timeticks' | 'counter32' | 'gauge32';

/** `ro` read-only, `rw` read-write, `notify` sent in traps only (never served by GET). */
export type MibAccess = 'ro' | 'rw' | 'notify';

export interface MibObject {
  /** The standard object name (`sysDescr`, `ifInOctets`). */
  readonly name: string;
  /** The object's OID, without the instance part (`1.3.6.1.2.1.1.1`). */
  readonly oid: string;
  readonly group: MibGroup;
  readonly syntax: MibSyntax;
  readonly access: MibAccess;
  /** `scalar`: the one instance is `.0`; `ifIndex`: one instance per interface, `.<ifIndex>`. */
  readonly instance: 'scalar' | 'ifIndex';
  /** The meaning of the integer values of an enumerated object. */
  readonly enums?: Readonly<Record<number, string>>;
  /** What the value tells the learner (original wording). */
  readonly description: string;
}

const SYSTEM = '1.3.6.1.2.1.1';
const IF_ENTRY = '1.3.6.1.2.1.2.2.1';
const IFX_ENTRY = '1.3.6.1.2.1.31.1.1.1';

/** The `ifType` numbers NetForge uses (6 Ethernet, 22 serial, 24 loopback, 53 every virtual interface). */
export const MIB_IF_TYPE = Object.freeze({ ethernet: 6, serial: 22, loopback: 24, virtual: 53 } as const);
export type MibIfKind = keyof typeof MIB_IF_TYPE;

const UP_DOWN = Object.freeze({ 1: 'up', 2: 'down' });

/** The MIB subset, as plain data, in OID order (§3.5). */
export const MIB_OBJECTS: readonly MibObject[] = Object.freeze([
  { name: 'sysDescr', oid: `${SYSTEM}.1`, group: 'system', syntax: 'octets', access: 'ro', instance: 'scalar',
    description: 'A line of text saying which NetForge model this is and which NF-OS version it runs.' },
  { name: 'sysObjectID', oid: `${SYSTEM}.2`, group: 'system', syntax: 'oid', access: 'ro', instance: 'scalar',
    description: 'An identifier for the kind of device; each NetForge model has its own number under one enterprise arc.' },
  { name: 'sysUpTime', oid: `${SYSTEM}.3`, group: 'system', syntax: 'timeticks', access: 'ro', instance: 'scalar',
    description: 'How long the device has been up since it finished booting, in hundredths of a second.' },
  { name: 'sysContact', oid: `${SYSTEM}.4`, group: 'system', syntax: 'octets', access: 'rw', instance: 'scalar',
    description: 'Who to call about this device; set by snmp-server contact.' },
  { name: 'sysName', oid: `${SYSTEM}.5`, group: 'system', syntax: 'octets', access: 'rw', instance: 'scalar',
    description: 'The device name, the same as its hostname; writing it renames the device.' },
  { name: 'sysLocation', oid: `${SYSTEM}.6`, group: 'system', syntax: 'octets', access: 'rw', instance: 'scalar',
    description: 'Where the device is installed; set by snmp-server location.' },
  { name: 'ifNumber', oid: '1.3.6.1.2.1.2.1', group: 'interfaces', syntax: 'integer', access: 'ro', instance: 'scalar',
    description: 'How many interfaces the interface table lists right now.' },
  { name: 'ifIndex', oid: `${IF_ENTRY}.1`, group: 'ifTable', syntax: 'integer', access: 'ro', instance: 'ifIndex',
    description: 'The number that identifies an interface in every table row: ports first, then virtual interfaces.' },
  { name: 'ifDescr', oid: `${IF_ENTRY}.2`, group: 'ifTable', syntax: 'octets', access: 'ro', instance: 'ifIndex',
    description: 'The full interface name, for example GigabitEthernet0/1.' },
  { name: 'ifType', oid: `${IF_ENTRY}.3`, group: 'ifTable', syntax: 'integer', access: 'ro', instance: 'ifIndex',
    enums: Object.freeze({ 6: 'ethernet', 22: 'serial', 24: 'loopback', 53: 'virtual' }),
    description: 'The kind of interface as a number: 6 Ethernet, 22 serial, 24 loopback, 53 any virtual interface.' },
  { name: 'ifMtu', oid: `${IF_ENTRY}.4`, group: 'ifTable', syntax: 'integer', access: 'ro', instance: 'ifIndex',
    description: 'The largest packet, in bytes, the interface sends without fragmenting.' },
  { name: 'ifSpeed', oid: `${IF_ENTRY}.5`, group: 'ifTable', syntax: 'gauge32', access: 'ro', instance: 'ifIndex',
    description: 'The bandwidth in bits per second; a speed too large for 32 bits reads as the largest value.' },
  { name: 'ifPhysAddress', oid: `${IF_ENTRY}.6`, group: 'ifTable', syntax: 'octets', access: 'ro', instance: 'ifIndex',
    description: 'The MAC address of the interface, empty for an interface that has none.' },
  { name: 'ifAdminStatus', oid: `${IF_ENTRY}.7`, group: 'ifTable', syntax: 'integer', access: 'rw', instance: 'ifIndex', enums: UP_DOWN,
    description: 'What the configuration asks for: 1 up, 2 down (shut down). Writing it shuts the interface or opens it.' },
  { name: 'ifOperStatus', oid: `${IF_ENTRY}.8`, group: 'ifTable', syntax: 'integer', access: 'ro', instance: 'ifIndex', enums: UP_DOWN,
    description: 'Whether the interface passes traffic now: 1 up, 2 down.' },
  { name: 'ifInOctets', oid: `${IF_ENTRY}.10`, group: 'ifTable', syntax: 'counter32', access: 'ro', instance: 'ifIndex',
    description: 'Bytes received since boot; the count starts again at zero after 2^32.' },
  { name: 'ifInErrors', oid: `${IF_ENTRY}.14`, group: 'ifTable', syntax: 'counter32', access: 'ro', instance: 'ifIndex',
    description: 'Received frames thrown away because they were damaged.' },
  { name: 'ifOutOctets', oid: `${IF_ENTRY}.16`, group: 'ifTable', syntax: 'counter32', access: 'ro', instance: 'ifIndex',
    description: 'Bytes sent since boot; the count starts again at zero after 2^32.' },
  { name: 'ifOutErrors', oid: `${IF_ENTRY}.20`, group: 'ifTable', syntax: 'counter32', access: 'ro', instance: 'ifIndex',
    description: 'Frames the interface could not send because of an error.' },
  { name: 'ipForwarding', oid: '1.3.6.1.2.1.4.1', group: 'ip', syntax: 'integer', access: 'ro', instance: 'scalar',
    enums: Object.freeze({ 1: 'forwarding', 2: 'not-forwarding' }),
    description: '1 when the device routes packets between its networks, 2 when it only receives them.' },
  { name: 'ifName', oid: `${IFX_ENTRY}.1`, group: 'ifXTable', syntax: 'octets', access: 'ro', instance: 'ifIndex',
    description: 'The short interface name, for example Gi0/1.' },
  { name: 'snmpTrapOID', oid: '1.3.6.1.6.3.1.1.4.1', group: 'traps', syntax: 'oid', access: 'notify', instance: 'scalar',
    description: 'In a trap, says which event the trap reports.' },
] as MibObject[]);

/** The traps the agent sends (§3.5). */
export type MibTrapName = 'coldStart' | 'linkDown' | 'linkUp' | 'authenticationFailure';

/** The identifier each trap carries in `snmpTrapOID.0`. */
export const MIB_TRAP_OIDS: Readonly<Record<MibTrapName, string>> = Object.freeze({
  coldStart: '1.3.6.1.6.3.1.1.5.1',
  linkDown: '1.3.6.1.6.3.1.1.5.3',
  linkUp: '1.3.6.1.6.3.1.1.5.4',
  authenticationFailure: '1.3.6.1.6.3.1.1.5.5',
});

/** What each trap means (original wording). */
export const MIB_TRAP_DESCRIPTIONS: Readonly<Record<MibTrapName, string>> = Object.freeze({
  coldStart: 'The device has just finished booting.',
  linkDown: 'An interface stopped passing traffic.',
  linkUp: 'An interface started passing traffic.',
  authenticationFailure: 'A request arrived with a community the device does not accept.',
});

// ── OIDs ─────────────────────────────────────────────────────────────────────

/** True for a dotted OID of at least two non-negative integer arcs (an optional leading dot is allowed). */
export function isOid(text: string): boolean {
  return /^\.?(0|[1-9]\d*)(\.(0|[1-9]\d*))+$/.test(text) && oidArcs(text).every((n) => n <= MIB_UINT32_MAX);
}

/** The arcs of a dotted OID (`'.1.3.6'` → `[1, 3, 6]`). */
export function oidArcs(oid: string): number[] {
  return oid.replace(/^\./, '').split('.').map(Number);
}

/** The canonical text of an OID (no leading dot). */
export function normalizeOid(oid: string): string {
  return oid.replace(/^\./, '');
}

/** Orders two OIDs arc by arc (the order GETNEXT walks); a prefix sorts first. */
export function compareOids(a: string, b: string): number {
  const x = oidArcs(a);
  const y = oidArcs(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/** True when `oid` equals `prefix` or lies under it. */
export function oidStartsWith(oid: string, prefix: string): boolean {
  const o = normalizeOid(oid);
  const p = normalizeOid(prefix);
  return o === p || o.startsWith(`${p}.`);
}

// ── readers over the table ───────────────────────────────────────────────────

let index: { byName: Map<string, MibObject>; byOid: Map<string, MibObject> } | undefined;
function lookup(): { byName: Map<string, MibObject>; byOid: Map<string, MibObject> } {
  index ??= { byName: new Map(MIB_OBJECTS.map((o) => [o.name, o])), byOid: new Map(MIB_OBJECTS.map((o) => [o.oid, o])) };
  return index;
}

/** Every object of the subset, in OID order. */
export function mibObjects(): readonly MibObject[] {
  return MIB_OBJECTS;
}

/** The object with this name, or undefined. */
export function mibObject(name: string): MibObject | undefined {
  return lookup().byName.get(name);
}

/** The objects of one group, in OID order. */
export function mibGroupObjects(group: MibGroup): MibObject[] {
  return MIB_OBJECTS.filter((o) => o.group === group);
}

/** The OID of one instance of an object (`sysName` → `….5.0`; `ifDescr`, 3 → `….2.3`). */
export function mibInstanceOid(object: MibObject, ifIndex?: number): string {
  if (object.instance === 'scalar') return `${object.oid}.0`;
  if (ifIndex === undefined || !Number.isInteger(ifIndex) || ifIndex < 1) throw new RangeError(`${object.name} needs an ifIndex`);
  return `${object.oid}.${ifIndex}`;
}

/**
 * The object an OID belongs to, and its instance part (`0`, an ifIndex, or `''` for the object's own OID); undefined
 * when no object of the subset holds it.
 */
export function mibObjectOfOid(oid: string): { object: MibObject; instance: string } | undefined {
  const arcs = oidArcs(oid);
  for (let n = arcs.length; n >= 2; n--) {
    const object = lookup().byOid.get(arcs.slice(0, n).join('.'));
    if (object !== undefined) return { object, instance: arcs.slice(n).join('.') };
  }
  return undefined;
}

/** The name of an OID for display (`sysName.0`, `ifDescr.3`, `linkDown`), or the OID itself. */
export function mibOidName(oid: string): string {
  const o = normalizeOid(oid);
  for (const [name, trapOid] of Object.entries(MIB_TRAP_OIDS)) if (trapOid === o) return name;
  const hit = mibObjectOfOid(o);
  return hit === undefined ? o : hit.instance === '' ? hit.object.name : `${hit.object.name}.${hit.instance}`;
}

// ── the device view ──────────────────────────────────────────────────────────

/** One interface as the agent sees it (from its port views and counters). */
export interface MibInterfaceView {
  /** From `ifIndexOf` (device/if-index.ts). */
  readonly ifIndex: number;
  /** The canonical long name (`GigabitEthernet0/1`). */
  readonly descr: string;
  /** The short name (`Gi0/1`). */
  readonly name: string;
  readonly kind: MibIfKind;
  readonly mtu: number;
  readonly speedBps: number;
  /** Any 12-hex-digit MAC notation; absent for an interface with no MAC (a loopback, a serial line). */
  readonly physAddress?: string;
  readonly adminUp: boolean;
  readonly operUp: boolean;
  readonly inOctets: number;
  readonly inErrors: number;
  readonly outOctets: number;
  readonly outErrors: number;
}

/** What the readers need from a device. */
export interface MibDeviceView {
  /** `mibSysDescr(model, version)`. */
  readonly sysDescr: string;
  /** `mibSysObjectId(model index)`. */
  readonly sysObjectId: string;
  /** Centiseconds since boot completion. */
  readonly upTime: number;
  readonly contact: string;
  readonly name: string;
  readonly location: string;
  /** The device routes (ipForwarding 1). */
  readonly routes: boolean;
  /** Every interface, in any order (the readers sort by ifIndex). */
  readonly interfaces: readonly MibInterfaceView[];
}

const u32 = (n: number): number => ((Math.floor(n) % 4294967296) + 4294967296) % 4294967296;
const counter = (n: number): SnmpValue => ({ type: 'counter32', value: u32(n) });
const integer = (n: number): SnmpValue => ({ type: 'integer', value: n });
const octets = (s: string): SnmpValue => ({ type: 'octets', value: s });

/** A MAC in any 12-hex-digit notation as its six bytes, one Latin-1 character per byte; empty when it is not one. */
export function mibPhysAddressOctets(mac: string | undefined): string {
  const hex = (mac ?? '').replace(/[^0-9a-fA-F]/g, '');
  return hex.length === 12 ? String.fromCharCode(...(hex.match(/../g) as string[]).map((h) => parseInt(h, 16))) : '';
}

function columnValue(object: MibObject, i: MibInterfaceView): SnmpValue {
  switch (object.name) {
    case 'ifIndex': return integer(i.ifIndex);
    case 'ifDescr': return octets(i.descr);
    case 'ifType': return integer(MIB_IF_TYPE[i.kind]);
    case 'ifMtu': return integer(i.mtu);
    case 'ifSpeed': return { type: 'gauge32', value: Math.min(Math.max(0, Math.floor(i.speedBps)), MIB_UINT32_MAX) };
    case 'ifPhysAddress': return octets(mibPhysAddressOctets(i.physAddress));
    case 'ifAdminStatus': return integer(i.adminUp ? 1 : 2);
    case 'ifOperStatus': return integer(i.operUp ? 1 : 2);
    case 'ifInOctets': return counter(i.inOctets);
    case 'ifInErrors': return counter(i.inErrors);
    case 'ifOutOctets': return counter(i.outOctets);
    case 'ifOutErrors': return counter(i.outErrors);
    case 'ifName': return octets(i.name);
    default: throw new Error(`no column reader for ${object.name}`);
  }
}

function scalarValue(object: MibObject, dev: MibDeviceView): SnmpValue {
  switch (object.name) {
    case 'sysDescr': return octets(dev.sysDescr);
    case 'sysObjectID': return { type: 'oid', value: dev.sysObjectId };
    case 'sysUpTime': return { type: 'timeticks', value: u32(dev.upTime) };
    case 'sysContact': return octets(dev.contact);
    case 'sysName': return octets(dev.name);
    case 'sysLocation': return octets(dev.location);
    case 'ifNumber': return integer(dev.interfaces.length);
    case 'ipForwarding': return integer(dev.routes ? 1 : 2);
    default: throw new Error(`no scalar reader for ${object.name}`);
  }
}

/** One served value. */
export interface MibVarbind {
  readonly oid: string;
  readonly value: SnmpValue;
}

/** Every instance the device serves (access `ro`/`rw`), in OID order: the walk of the whole subset. */
export function mibInstances(dev: MibDeviceView): MibVarbind[] {
  const ifs = [...dev.interfaces].sort((a, b) => a.ifIndex - b.ifIndex);
  const out: MibVarbind[] = [];
  for (const object of MIB_OBJECTS) {
    if (object.access === 'notify') continue;
    if (object.instance === 'scalar') out.push({ oid: mibInstanceOid(object), value: scalarValue(object, dev) });
    else for (const i of ifs) out.push({ oid: mibInstanceOid(object, i.ifIndex), value: columnValue(object, i) });
  }
  return out.sort((a, b) => compareOids(a.oid, b.oid));
}

/** GET: the value of one instance; `noSuchObject` when no served object holds the OID, `noSuchInstance` when the object exists but not this instance. */
export function mibGet(dev: MibDeviceView, oid: string): SnmpValue {
  const o = normalizeOid(oid);
  const hit = mibObjectOfOid(o);
  if (hit === undefined || hit.object.access === 'notify') return { type: 'noSuchObject' };
  if (hit.object.instance === 'scalar') return hit.instance === '0' ? scalarValue(hit.object, dev) : { type: 'noSuchInstance' };
  if (!/^[1-9]\d*$/.test(hit.instance)) return { type: 'noSuchInstance' };
  const i = dev.interfaces.find((x) => x.ifIndex === Number(hit.instance));
  return i === undefined ? { type: 'noSuchInstance' } : columnValue(hit.object, i);
}

/** GETNEXT: the first served instance after `oid`, or `endOfMibView` (which ends a walk). */
export function mibGetNext(dev: MibDeviceView, oid: string): MibVarbind {
  const next = mibInstances(dev).find((v) => compareOids(v.oid, oid) > 0);
  return next ?? { oid: normalizeOid(oid), value: { type: 'endOfMibView' } };
}

/**
 * GETBULK (RFC 3416 §4.2.3): one GETNEXT for each of the first `nonRepeaters` OIDs, then up to `maxRepetitions`
 * successive GETNEXTs for each remaining OID, row by row; the answer stops at `SNMP_MAX_BULK` varbinds.
 */
export function mibGetBulk(dev: MibDeviceView, oids: readonly string[], nonRepeaters: number, maxRepetitions: number): MibVarbind[] {
  const all = mibInstances(dev);
  const after = (oid: string): MibVarbind => all.find((v) => compareOids(v.oid, oid) > 0) ?? { oid: normalizeOid(oid), value: { type: 'endOfMibView' } };
  const n = Math.min(Math.max(0, nonRepeaters), oids.length);
  const out: MibVarbind[] = [];
  for (let k = 0; k < n && out.length < SNMP_MAX_BULK; k++) out.push(after(oids[k] as string));
  const cursors = oids.slice(n).map(normalizeOid);
  for (let r = 0; r < Math.max(0, maxRepetitions) && cursors.length > 0; r++) {
    for (let c = 0; c < cursors.length; c++) {
      if (out.length >= SNMP_MAX_BULK) return out;
      const vb = after(cursors[c] as string);
      out.push(vb);
      cursors[c] = vb.oid;
    }
  }
  return out;
}

/** WALK (client side): every instance under `root`, by repeated GETNEXT, until the answer leaves the subtree. */
export function mibWalk(dev: MibDeviceView, root: string): MibVarbind[] {
  const out: MibVarbind[] = [];
  for (let cur = normalizeOid(root); ;) {
    const vb = mibGetNext(dev, cur);
    if (vb.value.type === 'endOfMibView' || !oidStartsWith(vb.oid, root)) return out;
    out.push(vb);
    cur = vb.oid;
  }
}

// ── SET ──────────────────────────────────────────────────────────────────────

/** The error-status words a SET answers with (RFC 3416). */
export type MibSetError = 'notWritable' | 'wrongType' | 'wrongValue' | 'noAccess';

/**
 * The configuration a SET makes: the lines (indented, a section line first) for one `configure` action with origin
 * `{via: 'snmp'}`, or the error the agent answers. `noAccess` is for a read-only community, decided by the caller.
 */
export type MibSetPlan = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly error: MibSetError };

/** Plans a SET of one instance (sysName, sysContact, sysLocation, ifAdminStatus; anything else is notWritable). */
export function planMibSet(dev: MibDeviceView, oid: string, value: SnmpValue): MibSetPlan {
  const hit = mibObjectOfOid(normalizeOid(oid));
  if (hit === undefined || hit.object.access !== 'rw') return { ok: false, error: 'notWritable' };
  const { object } = hit;
  if (object.instance === 'scalar') {
    if (hit.instance !== '0') return { ok: false, error: 'notWritable' };
    if (value.type !== 'octets') return { ok: false, error: 'wrongType' };
    const text = value.value.trim();
    if (object.name === 'sysName') return /^\S{1,63}$/.test(text) ? { ok: true, lines: [`hostname ${text}`] } : { ok: false, error: 'wrongValue' };
    if (text === '') return { ok: true, lines: [object.name === 'sysContact' ? 'no snmp-server contact' : 'no snmp-server location'] };
    return { ok: true, lines: [`${object.name === 'sysContact' ? 'snmp-server contact' : 'snmp-server location'} ${text}`] };
  }
  const i = /^[1-9]\d*$/.test(hit.instance) ? dev.interfaces.find((x) => x.ifIndex === Number(hit.instance)) : undefined;
  if (i === undefined) return { ok: false, error: 'notWritable' };
  if (value.type !== 'integer') return { ok: false, error: 'wrongType' };
  if (value.value !== 1 && value.value !== 2) return { ok: false, error: 'wrongValue' };
  return { ok: true, lines: [`interface ${i.descr}`, value.value === 1 ? ' no shutdown' : ' shutdown'] };
}

// ── traps ────────────────────────────────────────────────────────────────────

/** The varbinds of a trap: sysUpTime.0, snmpTrapOID.0, then for a link trap ifIndex, ifAdminStatus and ifOperStatus. */
export function mibTrapVarbinds(dev: MibDeviceView, trap: MibTrapName, ifIndex?: number): MibVarbind[] {
  const sysUpTime = mibObject('sysUpTime') as MibObject;
  const trapOid = mibObject('snmpTrapOID') as MibObject;
  const out: MibVarbind[] = [
    { oid: mibInstanceOid(sysUpTime), value: scalarValue(sysUpTime, dev) },
    { oid: mibInstanceOid(trapOid), value: { type: 'oid', value: MIB_TRAP_OIDS[trap] } },
  ];
  if (trap === 'linkDown' || trap === 'linkUp') {
    const i = dev.interfaces.find((x) => x.ifIndex === ifIndex);
    if (i === undefined) throw new RangeError(`${trap} needs the ifIndex of an interface, got ${ifIndex}`);
    for (const name of ['ifIndex', 'ifAdminStatus', 'ifOperStatus']) {
      const object = mibObject(name) as MibObject;
      out.push({ oid: mibInstanceOid(object, i.ifIndex), value: columnValue(object, i) });
    }
  }
  return out;
}

/** The trap an `snmpTrapOID.0` value names, or undefined. */
export function mibTrapOfOid(oid: string): MibTrapName | undefined {
  const o = normalizeOid(oid);
  return (Object.keys(MIB_TRAP_OIDS) as MibTrapName[]).find((t) => MIB_TRAP_OIDS[t] === o);
}
