/**
 * The YANG model and the RESTCONF path parser of `automation/yang` (ARCHITECTURE-P3 D21, §3.8, §5.6, §7 W1 auto):
 * every node's lines parse in `GRAMMAR`; no vendor module name; paths, reads and write plans.
 */
import { describe, expect, it } from 'vitest';
import type { CliMode } from '../src/contracts/cli.js';
import type { PortId } from '../src/contracts/ids.js';
import type { PortView } from '../src/contracts/port.js';
import { parseJson, stringifyJson, type DataValue } from '../src/automation/data/json.js';
import { dataToXml, parseXml, serializeXml, xmlToData } from '../src/automation/data/xml.js';
import { formatApiPath, parseApiPath, parseRestconfTarget, percentEncodeKey, type ApiSegment } from '../src/automation/yang/path.js';
import {
  YANG_MODULES,
  fillYangLine,
  maskToPrefixLength,
  planYangWrite,
  prefixLengthToMask,
  readYang,
  readYangConfig,
  resolveYangOperation,
  resolveYangPath,
  yangExampleValues,
  yangMemberName,
  yangNode,
  yangNodes,
  yangOperationLines,
  yangXmlHints,
  type YangDeviceView,
  type YangStep,
  type YangWriteMethod,
} from '../src/automation/yang/model.js';
import { parseConfigText } from '../src/cli/config-ast.js';
import { GRAMMAR } from '../src/cli/grammar/index.js';
import { matchCommand, type MatchContext } from '../src/cli/parser.js';
import { findBannedWords } from '../src/device/catalog/validate.js';
import { createVirtualPortState, parseVirtualPortName } from '../src/device/ports.js';
import { ROUTER, SWITCH } from '../src/sim/scenarios/kit.js';
import { catalogModel, devicePortViews, matchContextFor } from './cli.p05.fixture.js';

// ── fixtures ──

/** SW2 of §3.8: management SVI, an uplink whose description the lab asks the learner to read. */
const SW2_CONFIG = [
  'hostname SW2',
  'banner motd ^CAuthorised access only^C',
  'vlan 10',
  'vlan 99',
  ' name MGMT',
  'interface GigabitEthernet0/1',
  ' shutdown',
  'interface GigabitEthernet0/2',
  ' description uplink - add vlan 40 NAME FINANCE on SW3',
  'interface Vlan99',
  ' ip address 10.0.99.12 255.255.255.0',
].join('\n');

function sw2(config = SW2_CONFIG): YangDeviceView {
  return {
    hostname: 'SW2',
    config: parseConfigText(config).root,
    interfaces: [
      {
        name: 'GigabitEthernet0/1', ifType: 'ethernetCsmacd', operUp: false, physAddress: '0200.4e46.0101', speedBps: 1_000_000_000,
        counters: { inOctets: 0, inUnicastPkts: 0, inDiscards: 0, inErrors: 0, outOctets: 0, outUnicastPkts: 0, outDiscards: 0, outErrors: 0 },
      },
      {
        name: 'GigabitEthernet0/2', ifType: 'ethernetCsmacd', operUp: true, physAddress: '02:00:4E:46:01:02', speedBps: 1_000_000_000,
        counters: { inOctets: 12_345, inUnicastPkts: 67, inDiscards: 0, inErrors: 1, outOctets: 23_456, outUnicastPkts: 78, outDiscards: 2, outErrors: 0 },
      },
      { name: 'Vlan99', ifType: 'l3ipvlan', operUp: true, physAddress: '02-00-4e-46-01-63' },
    ],
  };
}

function steps(target: string): readonly YangStep[] {
  const t = parseRestconfTarget(target);
  if (!t.ok || t.resource.kind !== 'data') throw new Error(`not a data target: ${target}`);
  const r = resolveYangPath(t.resource.path);
  if (!r.ok) throw new Error(`${target}: ${r.error.message}`);
  return r.steps;
}

function body(json: string): DataValue {
  const r = parseJson(json);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function plan(method: YangWriteMethod, target: string, json?: string, dev = sw2()) {
  return planYangWrite(dev, { method, steps: steps(target), ...(json !== undefined ? { body: body(json) } : {}) });
}

// ── grammar contexts (the models the API runs on: a managed switch and a router) ──

function withVirtual(type: string, name: string | undefined): { model: ReturnType<typeof catalogModel>; ports: Map<PortId, PortView> } {
  const model = catalogModel(type);
  const ports = devicePortViews(model);
  if (name !== undefined && !ports.has(name)) {
    const v = parseVirtualPortName(model, name);
    if (v !== undefined) {
      const state = createVirtualPortState(v.family, v.number, 0);
      ports.set(state.id, state);
    }
  }
  return { model, ports };
}

/** Parser contexts for `mode` on the switch and the router; interface modes select `iface` when the model has it. */
function contextsFor(mode: CliMode, iface?: string): MatchContext[] {
  const out: MatchContext[] = [];
  for (const type of [SWITCH, ROUTER]) {
    const { model, ports } = withVirtual(type, iface);
    if (mode === 'config-if') {
      const view = iface !== undefined ? ports.get(iface) : undefined;
      if (view !== undefined) out.push(matchContextFor(model, mode, { ports, ifaceView: view }));
    } else out.push(matchContextFor(model, mode, { ports }));
  }
  return out;
}

function parses(mode: CliMode, line: string, iface?: string): boolean {
  return contextsFor(mode, iface).some((ctx) => matchCommand(GRAMMAR, ctx, line).ok);
}

/** Checks pasted lines the way the headless CLI enters modes: `interface X` → config-if, `vlan N` → config-vlan. */
function unparsedLines(lines: readonly string[]): string[] {
  const bad: string[] = [];
  let sub: { mode: CliMode; iface?: string } | undefined;
  for (const line of lines) {
    if (line.startsWith(' ')) {
      if (sub === undefined || !parses(sub.mode, line.trim(), sub.iface)) bad.push(line);
      continue;
    }
    if (!parses('config', line)) bad.push(line);
    const m = /^interface (\S+)$/.exec(line);
    const v = /^vlan (\S+)$/.exec(line);
    sub = m !== null ? { mode: 'config-if', iface: m[1] as string } : v !== null ? { mode: 'config-vlan' } : undefined;
  }
  return bad;
}

/** Whether `line` is an instance of some template line of the model. */
function matchesATemplate(line: string): boolean {
  for (const n of yangNodes()) {
    for (const t of n.lines ?? []) {
      for (const l of t.lines) {
        const re = new RegExp(`^${l.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<[a-z-]+>/g, '(.+)')}$`);
        if (re.test(line)) return true;
      }
    }
  }
  return false;
}

// ── the model ──

describe('YANG modules', () => {
  it('names IETF and IANA modules and the original nf-native only — never a vendor module', () => {
    for (const m of YANG_MODULES) {
      expect(/^(?:ietf|iana)-[a-z0-9-]+$/.test(m.name) || m.name === 'nf-native', m.name).toBe(true);
      if (m.name.startsWith('ietf-') || m.name.startsWith('iana-')) expect(m.namespace).toBe(`urn:ietf:params:xml:ns:yang:${m.name}`);
      expect(findBannedWords(`${m.name} ${m.prefix} ${m.namespace} ${m.description}`), m.name).toEqual([]);
    }
    expect(YANG_MODULES.map((m) => m.name)).toEqual(['ietf-interfaces', 'ietf-ip', 'ietf-yang-library', 'iana-if-type', 'nf-native']);
    for (const n of yangNodes()) {
      expect(YANG_MODULES.some((m) => m.name === n.module), n.path).toBe(true);
      const text = [n.path, n.description, n.base ?? '', ...(n.lines ?? []).flatMap((t) => t.lines.map((l) => l.text))].join(' ');
      expect(findBannedWords(text), n.path).toEqual([]);
    }
    // the device-native settings live in the original module only
    expect([...new Set(yangNodes().filter((n) => /native/.test(n.path)).map((n) => n.module))]).toEqual(['nf-native']);
  });

  it('is a consistent tree: unique paths, keyed lists, parents and children agree', () => {
    const paths = yangNodes().map((n) => n.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const n of yangNodes()) {
      for (const c of n.children) expect(yangNode(c)?.parent, c).toBe(n.path);
      if (n.parent !== undefined) expect(yangNode(n.parent)?.children, n.path).toContain(n.path);
      if (n.kind === 'list') {
        expect(n.keys?.length, n.path).toBeGreaterThan(0);
        for (const k of n.keys ?? []) expect(yangNode(`${n.path}/${k}`)?.kind, `${n.path} key ${k}`).toBe('leaf');
      }
      if (n.kind === 'leaf') expect(n.type, n.path).toBeDefined();
      if (!n.config && n.kind !== 'rpc') expect(n.lines, n.path).toBeUndefined();
    }
    expect(yangNode('ietf-interfaces:interfaces/interface/ietf-ip:ipv4/address/prefix-length')).toMatchObject({ module: 'ietf-ip', type: 'uint8', range: [0, 32] });
    expect(yangMemberName(yangNode('ietf-interfaces:interfaces/interface/ietf-ip:ipv4')!)).toBe('ietf-ip:ipv4');
    expect(yangMemberName(yangNode('nf-native:native/vlan/vlan-list')!)).toBe('vlan-list');
  });

  it('gives every writable leaf and entry the lines that store it (keys and the hardware type excepted)', () => {
    for (const n of yangNodes()) {
      if (!n.config || n.kind === 'container') continue;
      const parent = n.parent !== undefined ? yangNode(n.parent) : undefined;
      const isKey = parent?.kind === 'list' && (parent.keys ?? []).includes(n.name);
      if (isKey || n.path.endsWith('/type')) continue;
      expect((n.lines ?? []).some((t) => t.op === 'set'), n.path).toBe(true);
    }
  });

  it('every node\'s lines parse in GRAMMAR, in the mode each line names', () => {
    let checked = 0;
    const wrong: string[] = [];
    for (const n of yangNodes()) {
      const values = { ...yangExampleValues(n) };
      for (const t of n.lines ?? []) {
        let iface: string | undefined;
        for (const l of t.lines) {
          const text = fillYangLine(l.text, values);
          expect(text, `${n.path}: ${l.text} has an unfilled placeholder`).not.toMatch(/<[a-z-]+>/);
          if (l.mode === 'config' && /^interface /.test(text)) iface = text.slice('interface '.length);
          checked += 1;
          if (!parses(l.mode, text.trim(), l.mode === 'config-if' ? iface : undefined)) wrong.push(`${n.path} [${t.op}${t.when !== undefined ? ` ${t.when}` : ''}] ${l.mode}: "${text}"`);
          const inner = /^do (.+)$/.exec(text.trim());
          if (inner !== null && !parses('priv-exec', inner[1] as string)) wrong.push(`${n.path}: "${inner[1] as string}" in priv-exec`);
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it('keeps masks and prefix lengths in step', () => {
    for (let len = 0; len <= 32; len++) expect(maskToPrefixLength(prefixLengthToMask(len))).toBe(len);
    expect(prefixLengthToMask(24)).toBe('255.255.255.0');
    expect(prefixLengthToMask(19)).toBe('255.255.224.0');
    expect(maskToPrefixLength('255.0.255.0')).toBeUndefined();
    expect(maskToPrefixLength('255.255.256.0')).toBeUndefined();
  });
});

// ── the path parser ──

describe('RESTCONF paths', () => {
  it('classifies the resources a device serves', () => {
    expect(parseRestconfTarget('/.well-known/host-meta')).toMatchObject({ ok: true, resource: { kind: 'host-meta' } });
    expect(parseRestconfTarget('/restconf')).toMatchObject({ ok: true, resource: { kind: 'root' } });
    expect(parseRestconfTarget('/restconf/data')).toMatchObject({ ok: true, resource: { kind: 'data', path: [] } });
    expect(parseRestconfTarget('/restconf/data/')).toMatchObject({ ok: true, resource: { kind: 'data', path: [] } });
    expect(parseRestconfTarget('/restconf/operations/nf-native:save-config')).toMatchObject({
      ok: true, resource: { kind: 'operations', path: [{ module: 'nf-native', name: 'save-config' }] },
    });
    expect(parseRestconfTarget('/index.html')).toMatchObject({ ok: true, resource: { kind: 'unknown' } });
    expect(parseRestconfTarget('/restconfx/data')).toMatchObject({ ok: true, resource: { kind: 'unknown' } });
  });

  it('reads module-qualified steps, list keys, %-escapes, the query and whole URLs', () => {
    const t = parseRestconfTarget('https://10.0.99.11/restconf/data/nf-native:native/vlan/vlan-list=30?depth=2&content=config');
    expect(t).toEqual({
      ok: true,
      resource: {
        kind: 'data',
        path: [
          { module: 'nf-native', name: 'native', text: 'nf-native:native' },
          { name: 'vlan', text: 'vlan' },
          { name: 'vlan-list', keys: ['30'], text: 'vlan-list=30' },
        ],
      },
      path: '/restconf/data/nf-native:native/vlan/vlan-list=30',
      query: [{ name: 'depth', value: '2' }, { name: 'content', value: 'config' }],
    });
    const i = parseApiPath('/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1/ietf-ip:ipv4/address=10.0.99.11');
    expect(i.ok && i.path.map((s) => [s.module, s.name, s.keys])).toEqual([
      ['ietf-interfaces', 'interfaces', undefined],
      [undefined, 'interface', ['GigabitEthernet0/1']],
      ['ietf-ip', 'ipv4', undefined],
      [undefined, 'address', ['10.0.99.11']],
    ]);
    expect(parseApiPath('/ietf-yang-library:modules-state/module=ietf-ip,2018-02-22')).toMatchObject({ ok: true, path: [{}, { keys: ['ietf-ip', '2018-02-22'] }] });
    expect(parseApiPath('/m:a/b=x%2Cy,%20z,')).toMatchObject({ ok: true, path: [{}, { keys: ['x,y', ' z', ''] }] });
    expect(parseRestconfTarget('/restconf/data?q=%41%2B+b#frag')).toMatchObject({ ok: true, query: [{ name: 'q', value: 'A++b' }] });
  });

  it('writes paths back with keys %-encoded', () => {
    const p: Pick<ApiSegment, 'module' | 'name' | 'keys'>[] = [
      { module: 'ietf-interfaces', name: 'interfaces' },
      { name: 'interface', keys: ['GigabitEthernet0/1'] },
    ];
    expect(formatApiPath(p)).toBe('/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1');
    expect(percentEncodeKey("a,b/c d'(x)")).toBe('a%2Cb%2Fc%20d%27%28x%29');
    const back = parseApiPath(formatApiPath(p));
    expect(back.ok && back.path[1]?.keys).toEqual(['GigabitEthernet0/1']);
  });

  it('refuses malformed paths with the place and the reason', () => {
    const cases: [string, number, RegExp][] = [
      ['/restconf/data/interfaces', 15, /must name its module/],
      ['/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0/1', 69, /%2F/],
      ['/restconf/data/nf-native:native//vlan', 32, /empty step/],
      ['/restconf/data/nf-native:native/vlan/vlan-list=%G1', 47, /broken %-escape/],
      ['/restconf/data/nf-native:na tive', 15, /not a valid node name/],
      ['/restconf/data/1m:x', 15, /not a valid module name/],
      ['/restconf/operations/nf-native:a/b', 20, /one step/],
      ['/restconf/data?%zz=1', 15, /broken parameter/],
    ];
    for (const [target, at, message] of cases) {
      const r = parseRestconfTarget(target);
      expect(r.ok, target).toBe(false);
      if (!r.ok) {
        expect(r.error.at, target).toBe(at);
        expect(r.error.message, target).toMatch(message);
      }
    }
  });

  it('resolves paths to model nodes, and refuses what the model does not have', () => {
    const s = steps('/restconf/data/ietf-interfaces:interfaces/interface=Vlan99/ietf-ip:ipv4/address=10.0.99.12/prefix-length');
    expect(s.map((x) => [x.node.name, x.keys])).toEqual([['interfaces', undefined], ['interface', ['Vlan99']], ['ipv4', undefined], ['address', ['10.0.99.12']], ['prefix-length', undefined]]);
    const fails: [string, number, RegExp][] = [
      ['/restconf/data/ietf-interfaces:interfaces/interface=Vlan99/ipv4', 404, /write it as "ietf-ip:ipv4"/],
      ['/restconf/data/ietf-interfaces:interfaces/interface=Vlan99/speed', 404, /There is no "speed"/],
      ['/restconf/data/nf-vendor:native', 404, /at the top of the data/],
      ['/restconf/data/nf-native:native/vlan/vlan-list=30,31', 400, /keyed by id/],
      ['/restconf/data/nf-native:native=1', 400, /not a list/],
      ['/restconf/data/nf-native:native/vlan/vlan-list/name', 400, /with its key/],
      ['/restconf/data/nf-native:native/hostname/x', 404, /is a leaf/],
    ];
    for (const [target, status, message] of fails) {
      const t = parseRestconfTarget(target);
      if (!t.ok || t.resource.kind !== 'data') throw new Error(target);
      const r = resolveYangPath(t.resource.path);
      expect(r.ok, target).toBe(false);
      if (!r.ok) {
        expect(r.error.status, target).toBe(status);
        expect(r.error.message, target).toMatch(message);
      }
    }
    const op = parseRestconfTarget('/restconf/operations/nf-native:save-config');
    if (!op.ok || op.resource.kind !== 'operations') throw new Error('operations');
    const rpc = resolveYangOperation(op.resource.path);
    expect(rpc.ok && yangOperationLines(rpc.node)).toEqual(['do copy running-config startup-config']);
    expect(resolveYangOperation([{ module: 'nf-native', name: 'reload', text: 'nf-native:reload' }])).toMatchObject({ ok: false, error: { status: 404 } });
  });
});

// ── reading ──

describe('reading (GET)', () => {
  it('renders the interfaces as RFC 7951 JSON from the running configuration', () => {
    const r = readYang(sw2(), steps('/restconf/data/ietf-interfaces:interfaces'));
    if (!r.ok) throw new Error(r.error.message);
    expect(stringifyJson(r.value)).toBe(`{
  "ietf-interfaces:interfaces": {
    "interface": [
      {
        "name": "GigabitEthernet0/1",
        "type": "iana-if-type:ethernetCsmacd",
        "enabled": false
      },
      {
        "name": "GigabitEthernet0/2",
        "description": "uplink - add vlan 40 NAME FINANCE on SW3",
        "type": "iana-if-type:ethernetCsmacd",
        "enabled": true
      },
      {
        "name": "Vlan99",
        "type": "iana-if-type:l3ipvlan",
        "enabled": true,
        "ietf-ip:ipv4": {
          "address": [
            {
              "ip": "10.0.99.12",
              "prefix-length": 24
            }
          ]
        }
      }
    ]
  }
}`);
  });

  it('renders the state, with 64-bit counters as strings', () => {
    const r = readYang(sw2(), steps('/restconf/data/ietf-interfaces:interfaces-state/interface=GigabitEthernet0%2F2'));
    expect(r).toEqual({
      ok: true,
      value: {
        'ietf-interfaces:interface': [{
          name: 'GigabitEthernet0/2', type: 'iana-if-type:ethernetCsmacd', 'admin-status': 'up', 'oper-status': 'up',
          'phys-address': '02:00:4e:46:01:02', speed: '1000000000',
          statistics: {
            'in-octets': '12345', 'in-unicast-pkts': '67', 'in-discards': '0', 'in-errors': '1',
            'out-octets': '23456', 'out-unicast-pkts': '78', 'out-discards': '2', 'out-errors': '0',
          },
        }],
      },
    });
    const g1 = readYang(sw2(), steps('/restconf/data/ietf-interfaces:interfaces-state/interface=GigabitEthernet0%2F1/oper-status'));
    expect(g1).toEqual({ ok: true, value: { 'ietf-interfaces:oper-status': 'down' } });
    const v = readYang(sw2(), steps('/restconf/data/ietf-interfaces:interfaces-state/interface=Vlan99/ietf-ip:ipv4'));
    expect(v).toEqual({ ok: true, value: { 'ietf-ip:ipv4': { address: [{ ip: '10.0.99.12', 'prefix-length': 24, origin: 'static' }] } } });
  });

  it('reads nf-native: hostname, banner, VLANs; a leaf; a list entry; the module list; the whole datastore', () => {
    const dev = sw2();
    expect(readYang(dev, steps('/restconf/data/nf-native:native'))).toEqual({
      ok: true,
      value: { 'nf-native:native': { hostname: 'SW2', banner: { motd: 'Authorised access only' }, vlan: { 'vlan-list': [{ id: 10 }, { id: 99, name: 'MGMT' }] } } },
    });
    expect(readYang(dev, steps('/restconf/data/nf-native:native/hostname'))).toEqual({ ok: true, value: { 'nf-native:hostname': 'SW2' } });
    expect(readYang(dev, steps('/restconf/data/nf-native:native/vlan/vlan-list=99'))).toEqual({ ok: true, value: { 'nf-native:vlan-list': [{ id: 99, name: 'MGMT' }] } });
    expect(readYang(dev, steps('/restconf/data/nf-native:native/vlan/vlan-list'))).toEqual({ ok: true, value: { 'nf-native:vlan-list': [{ id: 10 }, { id: 99, name: 'MGMT' }] } });
    expect(readYang(dev, steps('/restconf/data/nf-native:native/vlan/vlan-list=40'))).toMatchObject({ ok: false, error: { status: 404, errorTag: 'invalid-value' } });
    const lib = readYang(dev, steps('/restconf/data/ietf-yang-library:modules-state/module=ietf-ip,2018-02-22'));
    expect(lib).toEqual({ ok: true, value: { 'ietf-yang-library:module': [{ name: 'ietf-ip', revision: '2018-02-22', namespace: 'urn:ietf:params:xml:ns:yang:ietf-ip', 'conformance-type': 'implement' }] } });
    const all = readYang(dev, []);
    expect(all.ok && Object.keys(all.value['ietf-restconf:data'] as object)).toEqual([
      'ietf-interfaces:interfaces', 'ietf-interfaces:interfaces-state', 'ietf-yang-library:modules-state', 'nf-native:native',
    ]);
  });

  it('converts the RESTCONF JSON to XML and back exactly, with the model\'s hints', () => {
    const hints = yangXmlHints();
    for (const target of ['/restconf/data/ietf-interfaces:interfaces', '/restconf/data/ietf-interfaces:interfaces-state', '/restconf/data/nf-native:native', '/restconf/data/ietf-yang-library:modules-state']) {
      const r = readYang(sw2(), steps(target));
      if (!r.ok) throw new Error(r.error.message);
      const x = dataToXml(r.value, { namespaceOf: hints.namespaceOf });
      if (!x.ok) throw new Error(x.message);
      const text = serializeXml(x.element);
      const doc = parseXml(text);
      if (!doc.ok) throw new Error(doc.error.message);
      expect(stringifyJson(xmlToData(doc.document.root, hints)), target).toBe(stringifyJson(r.value));
    }
    // a one-entry list stays a list
    const one = sw2('hostname SW2\nvlan 30\n name VOICE');
    const r = readYang(one, steps('/restconf/data/nf-native:native'));
    if (!r.ok) throw new Error(r.error.message);
    const x = dataToXml(r.value, { namespaceOf: hints.namespaceOf });
    if (!x.ok) throw new Error(x.message);
    expect(serializeXml(x.element)).toBe([
      '<native xmlns="urn:netforge:yang:nf-native">',
      '  <hostname>SW2</hostname>',
      '  <vlan>',
      '    <vlan-list>',
      '      <id>30</id>',
      '      <name>VOICE</name>',
      '    </vlan-list>',
      '  </vlan>',
      '</native>',
    ].join('\n'));
    const doc = parseXml(serializeXml(x.element));
    expect(doc.ok && xmlToData(doc.document.root, hints)).toEqual(r.value);
  });
});

// ── writing ──

describe('writing (PUT, POST, PATCH, DELETE)', () => {
  it('§3.8: PUT of a new VLAN gives "vlan 30", " name VOICE" and 201; the same PUT again changes nothing (204)', () => {
    const put = '{"nf-native:vlan-list":[{"id":30,"name":"VOICE"}]}';
    expect(plan('PUT', '/restconf/data/nf-native:native/vlan/vlan-list=30', put)).toEqual({ ok: true, lines: ['vlan 30', ' name VOICE'], status: 201 });
    const after = sw2(`${SW2_CONFIG}\nvlan 30\n name VOICE`);
    expect(plan('PUT', '/restconf/data/nf-native:native/vlan/vlan-list=30', put, after)).toEqual({ ok: true, lines: [], status: 204 });
    const renamed = sw2(`${SW2_CONFIG}\nvlan 30\n name OLD`);
    expect(plan('PUT', '/restconf/data/nf-native:native/vlan/vlan-list=30', put, renamed)).toEqual({ ok: true, lines: ['vlan 30', ' name VOICE'], status: 204 });
    expect(plan('PUT', '/restconf/data/nf-native:native/vlan/vlan-list=99', '{"nf-native:vlan-list":[{"id":99}]}')).toEqual({ ok: true, lines: ['vlan 99', ' no name'], status: 204 });
    // the range is the CLI's to refuse, with its own text
    expect(plan('PUT', '/restconf/data/nf-native:native/vlan/vlan-list=5000', '{"nf-native:vlan-list":[{"id":5000,"name":"X"}]}')).toEqual({ ok: true, lines: ['vlan 5000', ' name X'], status: 201 });
  });

  it('checks the body key against the URL key and the JSON types against the model', () => {
    const cases: [string, string, number, RegExp][] = [
      ['/restconf/data/nf-native:native/vlan/vlan-list=30', '{"nf-native:vlan-list":[{"id":31,"name":"X"}]}', 400, /must equal the id in the URL \(30\)/],
      ['/restconf/data/nf-native:native/vlan/vlan-list=30', '{"nf-native:vlan-list":[{"id":"30"}]}', 400, /must be a number/],
      ['/restconf/data/nf-native:native/vlan/vlan-list=30', '{"nf-native:vlan-list":[{"name":"X"}]}', 400, /needs its key "id"/],
      ['/restconf/data/nf-native:native/vlan/vlan-list=30', '{"vlan-list":[{"id":30}]}', 400, /expects "nf-native:vlan-list"/],
      ['/restconf/data/nf-native:native/vlan/vlan-list=30', '{"nf-native:vlan-list":[{"id":30,"color":"red"}]}', 400, /"color" is not part of/],
      ['/restconf/data/nf-native:native/vlan/vlan-list=30', '{"nf-native:vlan-list":[{"id":30},{"id":30}]}', 400, /exactly one entry/],
      ['/restconf/data/nf-native:native/vlan/vlan-list=30', '[1]', 400, /JSON object/],
      ['/restconf/data/ietf-interfaces:interfaces/interface=Vlan99', '{"ietf-interfaces:interface":[{"name":"Vlan99","enabled":"yes"}]}', 400, /true or false/],
      ['/restconf/data/ietf-interfaces:interfaces/interface=Vlan99', '{"ietf-interfaces:interface":[{"name":"Vlan99","ipv4":{}}]}', 400, /write it as "ietf-ip:ipv4"/],
      ['/restconf/data/ietf-interfaces:interfaces/interface=Vlan99', '{"ietf-interfaces:interface":[{"name":"Vlan99","ietf-ip:ipv4":{"address":[{"ip":"10.0.99.300","prefix-length":24}]}}]}', 400, /IPv4 address/],
      ['/restconf/data/ietf-interfaces:interfaces/interface=Vlan99', '{"ietf-interfaces:interface":[{"name":"Vlan99","ietf-ip:ipv4":{"address":[{"ip":"10.0.99.1","prefix-length":33}]}}]}', 400, /from 0 to 32/],
      ['/restconf/data/ietf-interfaces:interfaces/interface=Vlan99', '{"ietf-interfaces:interface":[{"name":"Vlan99","type":"iana-if-type:ethernetCsmacd"}]}', 400, /type cannot change/],
      ['/restconf/data/ietf-interfaces:interfaces/interface=Vlan99', '{"ietf-interfaces:interface":[{"name":"Vlan99","description":"two\\nlines"}]}', 400, /one line/],
      ['/restconf/data/nf-native:native/banner/motd', '{"nf-native:motd":"a ^C b"}', 400, /\^C/],
      ['/restconf/data/nf-native:native/vlan/vlan-list=30', '{"nf-native:vlan-list":[{"id":30}], "x": 1}', 400, /exactly one member/],
    ];
    for (const [target, json, status, message] of cases) {
      const r = plan('PUT', target, json);
      expect(r.ok, json).toBe(false);
      if (!r.ok) {
        expect(r.error.status, json).toBe(status);
        expect(r.error.message, json).toMatch(message);
      }
    }
    expect(planYangWrite(sw2(), { method: 'PUT', steps: steps('/restconf/data/nf-native:native/hostname') })).toMatchObject({ ok: false, error: { status: 400, errorTag: 'malformed-message' } });
  });

  it('writes leaves, interfaces and addresses with §5\'s lines', () => {
    expect(plan('PUT', '/restconf/data/nf-native:native/hostname', '{"nf-native:hostname":"SW9"}')).toEqual({ ok: true, lines: ['hostname SW9'], status: 204 });
    expect(plan('DELETE', '/restconf/data/nf-native:native/hostname')).toEqual({ ok: true, lines: ['no hostname'], status: 204 });
    expect(plan('PUT', '/restconf/data/nf-native:native/banner/motd', '{"nf-native:motd":"Keep out"}')).toEqual({ ok: true, lines: ['banner motd ^CKeep out^C'], status: 204 });
    expect(plan('DELETE', '/restconf/data/nf-native:native/banner')).toEqual({ ok: true, lines: ['no banner motd'], status: 204 });
    expect(plan('PATCH', '/restconf/data/ietf-interfaces:interfaces/interface=Vlan99', '{"ietf-interfaces:interface":[{"name":"Vlan99","description":"management"}]}'))
      .toEqual({ ok: true, lines: ['interface Vlan99', ' description management'], status: 204 });
    expect(plan('PUT', '/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1',
      '{"ietf-interfaces:interface":[{"name":"GigabitEthernet0/1","description":"to R1","type":"iana-if-type:ethernetCsmacd","enabled":true}]}'))
      .toEqual({ ok: true, lines: ['interface GigabitEthernet0/1', ' description to R1', ' no shutdown'], status: 204 });
    expect(plan('PUT', '/restconf/data/ietf-interfaces:interfaces/interface=Vlan99/enabled', '{"ietf-interfaces:enabled":false}'))
      .toEqual({ ok: true, lines: ['interface Vlan99', ' shutdown'], status: 204 });
    expect(plan('PUT', '/restconf/data/ietf-interfaces:interfaces/interface=Vlan99/ietf-ip:ipv4/address=10.0.99.13',
      '{"ietf-ip:address":[{"ip":"10.0.99.13","prefix-length":24}]}'))
      .toMatchObject({ ok: false, error: { status: 400, message: expect.stringMatching(/one IPv4 address/) as unknown } });
    expect(plan('PUT', '/restconf/data/ietf-interfaces:interfaces/interface=Vlan99/ietf-ip:ipv4', '{"ietf-ip:ipv4":{"address":[{"ip":"10.0.99.13","prefix-length":25}]}}'))
      .toEqual({ ok: true, lines: ['interface Vlan99', ' ip address 10.0.99.13 255.255.255.128'], status: 204 });
    expect(plan('DELETE', '/restconf/data/ietf-interfaces:interfaces/interface=Vlan99/ietf-ip:ipv4')).toEqual({ ok: true, lines: ['interface Vlan99', ' no ip address'], status: 204 });
    expect(plan('PUT', '/restconf/data/ietf-interfaces:interfaces/interface=Loopback0', '{"ietf-interfaces:interface":[{"name":"Loopback0","ietf-ip:ipv4":{"address":[{"ip":"1.1.1.1","prefix-length":32}]}}]}'))
      .toEqual({ ok: true, lines: ['interface Loopback0', ' ip address 1.1.1.1 255.255.255.255', ' no shutdown'], status: 201 });
  });

  it('POST creates (409 when it exists), PATCH and DELETE need what they name (404), state and deletions of interfaces are refused (405)', () => {
    expect(plan('POST', '/restconf/data/nf-native:native/vlan', '{"nf-native:vlan-list":[{"id":40,"name":"FINANCE"}]}')).toEqual({ ok: true, lines: ['vlan 40', ' name FINANCE'], status: 201 });
    expect(plan('POST', '/restconf/data/nf-native:native/vlan', '{"nf-native:vlan-list":{"id":99}}')).toMatchObject({ ok: false, error: { status: 409, errorTag: 'data-exists' } });
    expect(plan('POST', '/restconf/data/nf-native:native/vlan/vlan-list=10', '{"nf-native:name":"DATA"}')).toEqual({ ok: true, lines: ['vlan 10', ' name DATA'], status: 201 });
    expect(plan('POST', '/restconf/data/nf-native:native/vlan/vlan-list=99', '{"nf-native:name":"X"}')).toMatchObject({ ok: false, error: { status: 409 } });
    expect(plan('POST', '/restconf/data/nf-native:native/hostname', '{"nf-native:hostname":"X"}')).toMatchObject({ ok: false, error: { status: 405 } });
    expect(plan('POST', '/restconf/data/nf-native:native/vlan', '{"nf-native:banner":{}}')).toMatchObject({ ok: false, error: { status: 400, errorTag: 'unknown-element' } });
    expect(plan('DELETE', '/restconf/data/nf-native:native/vlan/vlan-list=99')).toEqual({ ok: true, lines: ['no vlan 99'], status: 204 });
    expect(plan('DELETE', '/restconf/data/nf-native:native/vlan')).toEqual({ ok: true, lines: ['no vlan 10', 'no vlan 99'], status: 204 });
    expect(plan('DELETE', '/restconf/data/nf-native:native/vlan/vlan-list=40')).toMatchObject({ ok: false, error: { status: 404 } });
    expect(plan('DELETE', '/restconf/data/nf-native:native/vlan/vlan-list=99/id')).toMatchObject({ ok: false, error: { status: 400 } });
    expect(plan('PATCH', '/restconf/data/nf-native:native/vlan/vlan-list=40', '{"nf-native:vlan-list":[{"id":40}]}')).toMatchObject({ ok: false, error: { status: 404 } });
    expect(plan('PATCH', '/restconf/data/nf-native:native', '{"nf-native:native":{"vlan":{"vlan-list":[{"id":10,"name":"DATA"},{"id":20}]}}}'))
      .toEqual({ ok: true, lines: ['vlan 10', ' name DATA', 'vlan 20'], status: 204 });
    expect(plan('PUT', '/restconf/data/nf-native:native', '{"nf-native:native":{"hostname":"SW2"}}'))
      .toEqual({ ok: true, lines: ['no banner motd', 'no vlan 10', 'no vlan 99'], status: 204 });
    expect(plan('DELETE', '/restconf/data/ietf-interfaces:interfaces/interface=Vlan99')).toMatchObject({ ok: false, error: { status: 405, message: expect.stringMatching(/cannot be deleted/) as unknown } });
    expect(plan('PUT', '/restconf/data/ietf-interfaces:interfaces-state/interface=Vlan99', '{"ietf-interfaces:interface":[{"name":"Vlan99"}]}')).toMatchObject({ ok: false, error: { status: 405 } });
    expect(plan('PUT', '/restconf/data/ietf-yang-library:modules-state', '{"ietf-yang-library:modules-state":{}}')).toMatchObject({ ok: false, error: { status: 405 } });
    expect(planYangWrite(sw2(), { method: 'PATCH', steps: [], body: {} })).toMatchObject({ ok: false, error: { status: 405 } });
    expect(plan('PUT', '/restconf/data/nf-native:native/vlan/vlan-list', '{"nf-native:vlan-list":[]}')).toMatchObject({ ok: false, error: { status: 400 } });
    // a plain PATCH merges list entries by key, so a second address is added — and refused
    expect(plan('PATCH', '/restconf/data/ietf-interfaces:interfaces/interface=Vlan99', '{"ietf-interfaces:interface":[{"name":"Vlan99","ietf-ip:ipv4":{"address":[{"ip":"10.0.99.20","prefix-length":24}]}}]}'))
      .toMatchObject({ ok: false, error: { status: 400, message: expect.stringMatching(/one IPv4 address/) as unknown } });
  });

  it('plans only lines that parse in GRAMMAR and that are the model\'s own templates', () => {
    const requests: [YangWriteMethod, string, string?][] = [
      ['PUT', '/restconf/data/nf-native:native/vlan/vlan-list=30', '{"nf-native:vlan-list":[{"id":30,"name":"VOICE"}]}'],
      ['PUT', '/restconf/data/nf-native:native/vlan/vlan-list=99', '{"nf-native:vlan-list":[{"id":99}]}'],
      ['DELETE', '/restconf/data/nf-native:native/vlan'],
      ['PUT', '/restconf/data/nf-native:native', '{"nf-native:native":{"hostname":"CORE1","banner":{"motd":"Hello"},"vlan":{"vlan-list":[{"id":20,"name":"DATA"}]}}}'],
      ['DELETE', '/restconf/data/nf-native:native/hostname'],
      ['DELETE', '/restconf/data/nf-native:native/banner/motd'],
      ['PATCH', '/restconf/data/ietf-interfaces:interfaces', '{"ietf-interfaces:interfaces":{"interface":[{"name":"GigabitEthernet0/2"},{"name":"Vlan99","description":"mgmt","enabled":false}]}}'],
      ['PUT', '/restconf/data/ietf-interfaces:interfaces/interface=Vlan99/ietf-ip:ipv4', '{"ietf-ip:ipv4":{"address":[{"ip":"10.0.99.20","prefix-length":24}]}}'],
      ['PUT', '/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F2/description', '{"ietf-interfaces:description":"core uplink"}'],
      ['DELETE', '/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F2/description'],
      ['PUT', '/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1/enabled', '{"ietf-interfaces:enabled":true}'],
      ['DELETE', '/restconf/data/ietf-interfaces:interfaces/interface=Vlan99/ietf-ip:ipv4/address=10.0.99.12'],
    ];
    const all: string[] = [];
    for (const [method, target, json] of requests) {
      const r = plan(method, target, json);
      if (!r.ok) throw new Error(`${method} ${target}: ${r.error.message}`);
      expect(r.lines.length, `${method} ${target}`).toBeGreaterThan(0);
      expect(unparsedLines(r.lines), `${method} ${target}`).toEqual([]);
      all.push(...r.lines);
    }
    expect(all.filter((l) => !matchesATemplate(l))).toEqual([]);
  });

  it('is pure: planning never changes the device view', () => {
    const dev = sw2();
    const before = JSON.stringify(readYangConfig(dev));
    plan('PUT', '/restconf/data/nf-native:native', '{"nf-native:native":{"hostname":"X"}}', dev);
    plan('DELETE', '/restconf/data/nf-native:native/vlan', undefined, dev);
    expect(JSON.stringify(readYangConfig(dev))).toBe(before);
    expect(JSON.stringify(dev.config)).toBe(JSON.stringify(parseConfigText(SW2_CONFIG).root));
  });
});
