/**
 * The YANG model of NetForge devices (ARCHITECTURE-P3 D21 "Models", §3.8, §5.6, §7 W1 auto).
 *
 * One pure data file maps every node to the canonical configuration lines of §5 (and P1/P2) that store it and to a
 * reader over the running configuration, and drives RESTCONF GET and writes, so no view shows a node the device
 * refuses. Exported through `@netforge/engine/pure`.
 *
 * MODULES. IETF modules keep their standard names — `ietf-interfaces` (with `interfaces-state`, RFC 8343), `ietf-ip`
 * (RFC 8344, its `ipv4` augmentation), `ietf-yang-library` (`modules-state`, RFC 7895) and `iana-if-type` (identities
 * only) — and the device-native settings live in the original `nf-native` module (hostname, the VLAN list, the
 * login banner, and the `save-config` operation). No vendor module is modelled or named. Each module is a subset: the
 * nodes below are all a NetForge device serves.
 *
 * ENCODING. JSON per RFC 7951: member names are `module:name` at the top level and wherever the module changes
 * (`ietf-ip:ipv4` inside an interface); uint8/16/32 are numbers, counter64/gauge64 strings; identities are
 * `module:identity`.
 *
 * WRITES. `planYangWrite` turns a PUT, POST, PATCH or DELETE into the configuration lines (indented, for the
 * `configure` action with `indentation: true`) that make the running configuration match: the request is applied to
 * the configuration tree read from the device, and the old and new trees are compared node by node. The model checks
 * the shape and JSON types of a body (400), that the target exists (404), that it may be written (405) and that a new
 * entry is new (409); value ranges and names are left to the CLI, so a refused line (VLAN 5000) comes back with the
 * CLI's own error text (D21).
 *
 * Rule 12: the node table is plain data; the lookup maps are built lazily on first use.
 */
import type { CliMode } from '../../contracts/cli.js';
import type { ConfigNode } from '../../contracts/config.js';
import { isDataObject, setDataMember, type DataObject, type DataValue } from '../data/json.js';
import type { XmlToDataOptions } from '../data/xml.js';
import type { ApiSegment } from './path.js';

// ── modules ──────────────────────────────────────────────────────────────────

export type YangModuleName = 'ietf-interfaces' | 'ietf-ip' | 'ietf-yang-library' | 'iana-if-type' | 'nf-native';

export interface YangModule {
  readonly name: YangModuleName;
  readonly prefix: string;
  readonly namespace: string;
  readonly revision: string;
  /** `implement`: the device serves its data nodes; `import`: only its definitions are used (identities). */
  readonly conformance: 'implement' | 'import';
  readonly description: string;
}

/** The modules a NetForge device implements or imports, in `modules-state` order. */
export const YANG_MODULES: readonly YangModule[] = Object.freeze([
  {
    name: 'ietf-interfaces', prefix: 'if', namespace: 'urn:ietf:params:xml:ns:yang:ietf-interfaces', revision: '2018-02-20',
    conformance: 'implement', description: 'Interfaces: their configuration, and their state in interfaces-state.',
  },
  {
    name: 'ietf-ip', prefix: 'ip', namespace: 'urn:ietf:params:xml:ns:yang:ietf-ip', revision: '2018-02-22',
    conformance: 'implement', description: 'The IPv4 address of an interface, added to ietf-interfaces.',
  },
  {
    name: 'ietf-yang-library', prefix: 'yanglib', namespace: 'urn:ietf:params:xml:ns:yang:ietf-yang-library', revision: '2016-06-21',
    conformance: 'implement', description: 'The list of modules this device serves.',
  },
  {
    name: 'iana-if-type', prefix: 'ianaift', namespace: 'urn:ietf:params:xml:ns:yang:iana-if-type', revision: '2014-05-08',
    conformance: 'import', description: 'The names of interface kinds (identities).',
  },
  {
    name: 'nf-native', prefix: 'nf', namespace: 'urn:netforge:yang:nf-native', revision: '2026-09-30',
    conformance: 'implement', description: 'NetForge device settings: hostname, login banner, VLANs, and saving the configuration.',
  },
] as YangModule[]);

/** The `module-set-id` of `modules-state` (changes only when the module list does). */
export const YANG_MODULE_SET_ID = 'netforge-p3a-1';

/** The module of a namespace URI, or undefined. */
export function yangModuleOfNamespace(namespace: string): YangModuleName | undefined {
  return YANG_MODULES.find((m) => m.namespace === namespace)?.name;
}

/** The namespace URI of a module, or undefined. */
export function yangNamespaceOf(module: string): string | undefined {
  return YANG_MODULES.find((m) => m.name === module)?.namespace;
}

// ── nodes ────────────────────────────────────────────────────────────────────

export type YangNodeKind = 'container' | 'list' | 'leaf' | 'rpc';

export type YangTypeName =
  | 'string'
  | 'boolean'
  | 'uint8'
  | 'uint16'
  | 'counter64'
  | 'gauge64'
  | 'enumeration'
  | 'identityref'
  | 'inet:ipv4-address-no-zone'
  | 'yang:phys-address'
  | 'inet:uri'
  | 'revision-identifier'
  | 'yang:yang-identifier';

/** One CLI line of a template: the mode it is typed in and its text with `<placeholders>` (indented as pasted). */
export interface YangLine {
  readonly mode: CliMode;
  readonly text: string;
}

/** The lines that store (`set`), remove (`unset`) or run (`exec`, operations) a node's value. */
export interface YangLineTemplate {
  readonly op: 'set' | 'unset' | 'exec';
  /** Boolean leaves: the value these lines write. */
  readonly when?: 'true' | 'false';
  readonly lines: readonly YangLine[];
}

export interface YangNode {
  /** Schema path with RFC 7951 names: `nf-native:native/vlan/vlan-list/name`, `…/interface/ietf-ip:ipv4`. */
  readonly path: string;
  readonly module: YangModuleName;
  readonly name: string;
  readonly kind: YangNodeKind;
  /** Path of the parent node; undefined for a top-level node or an operation. */
  readonly parent?: string;
  /** Paths of the child nodes, in schema order. */
  readonly children: readonly string[];
  /** List keys, in order. */
  readonly keys?: readonly string[];
  readonly type?: YangTypeName;
  /** The YANG range of an integer leaf (shown; a value outside it is refused by the CLI, not the model). */
  readonly range?: readonly [number, number];
  /** The values of an enumeration leaf. */
  readonly enums?: readonly string[];
  /** The identity base of an identityref leaf. */
  readonly base?: string;
  readonly default?: string;
  readonly units?: string;
  /** config true (read-write) or false (state data). */
  readonly config: boolean;
  readonly description: string;
  /** The CLI lines this node maps to (placeholders: the list keys on its path, the leaf's own name, `<mask>`). */
  readonly lines?: readonly YangLineTemplate[];
  /** Example values for the placeholders (the YANG browser's sample and the grammar test). */
  readonly example?: Readonly<Record<string, string>>;
}

interface NodeSpec {
  readonly name: string;
  readonly kind: YangNodeKind;
  readonly module?: YangModuleName;
  readonly config?: boolean;
  readonly keys?: readonly string[];
  readonly type?: YangTypeName;
  readonly range?: readonly [number, number];
  readonly enums?: readonly string[];
  readonly base?: string;
  readonly default?: string;
  readonly units?: string;
  readonly description: string;
  readonly lines?: readonly YangLineTemplate[];
  readonly example?: Readonly<Record<string, string>>;
  readonly children?: readonly NodeSpec[];
}

const IF_LINE: YangLine = { mode: 'config', text: 'interface <name>' };
const VLAN_LINE: YangLine = { mode: 'config', text: 'vlan <id>' };
const COUNTER = (name: string, description: string): NodeSpec => ({ name, kind: 'leaf', type: 'counter64', description });

/** The schema, as plain data (the `lines` of every config node are §5's canonical lines). */
const SCHEMA: readonly NodeSpec[] = [
  {
    name: 'interfaces', kind: 'container', module: 'ietf-interfaces', config: true,
    description: 'The interfaces of the device and their settings.',
    children: [
      {
        name: 'interface', kind: 'list', keys: ['name'],
        description: 'One interface, named as the device names it (GigabitEthernet0/1, Vlan99). Interfaces cannot be deleted through the API.',
        lines: [{ op: 'set', lines: [IF_LINE] }],
        example: { name: 'Vlan99' },
        children: [
          { name: 'name', kind: 'leaf', type: 'string', description: 'The interface name, the key of the list.' },
          {
            name: 'description', kind: 'leaf', type: 'string', description: 'Free text that says what the interface is for.',
            lines: [
              { op: 'set', lines: [IF_LINE, { mode: 'config-if', text: ' description <description>' }] },
              { op: 'unset', lines: [IF_LINE, { mode: 'config-if', text: ' no description' }] },
            ],
            example: { description: 'management VLAN' },
          },
          {
            name: 'type', kind: 'leaf', type: 'identityref', base: 'iana-if-type:iana-interface-type',
            description: 'The kind of interface. The hardware decides it: a write may repeat it but not change it.',
          },
          {
            name: 'enabled', kind: 'leaf', type: 'boolean', default: 'true',
            description: 'Whether the interface is administratively up (the opposite of "shutdown").',
            lines: [
              { op: 'set', when: 'true', lines: [IF_LINE, { mode: 'config-if', text: ' no shutdown' }] },
              { op: 'set', when: 'false', lines: [IF_LINE, { mode: 'config-if', text: ' shutdown' }] },
              { op: 'unset', lines: [IF_LINE, { mode: 'config-if', text: ' no shutdown' }] },
            ],
          },
          {
            name: 'ipv4', kind: 'container', module: 'ietf-ip',
            description: 'The IPv4 settings of the interface (added to ietf-interfaces by ietf-ip).',
            lines: [{ op: 'unset', lines: [IF_LINE, { mode: 'config-if', text: ' no ip address' }] }],
            children: [
              {
                name: 'address', kind: 'list', keys: ['ip'],
                description: 'The IPv4 address of the interface: one per interface on NetForge devices.',
                lines: [
                  { op: 'set', lines: [IF_LINE, { mode: 'config-if', text: ' ip address <ip> <mask>' }] },
                  { op: 'unset', lines: [IF_LINE, { mode: 'config-if', text: ' no ip address' }] },
                ],
                example: { ip: '10.0.99.11', 'prefix-length': '24', mask: '255.255.255.0' },
                children: [
                  { name: 'ip', kind: 'leaf', type: 'inet:ipv4-address-no-zone', description: 'The address, the key of the list.' },
                  {
                    name: 'prefix-length', kind: 'leaf', type: 'uint8', range: [0, 32],
                    description: 'The length of the network prefix (24 for the mask 255.255.255.0).',
                    lines: [{ op: 'set', lines: [IF_LINE, { mode: 'config-if', text: ' ip address <ip> <mask>' }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'interfaces-state', kind: 'container', module: 'ietf-interfaces', config: false,
    description: 'What each interface is doing now: its status, address and counters.',
    children: [
      {
        name: 'interface', kind: 'list', keys: ['name'], description: 'The state of one interface.',
        children: [
          { name: 'name', kind: 'leaf', type: 'string', description: 'The interface name, the key of the list.' },
          { name: 'type', kind: 'leaf', type: 'identityref', base: 'iana-if-type:iana-interface-type', description: 'The kind of interface.' },
          { name: 'admin-status', kind: 'leaf', type: 'enumeration', enums: ['up', 'down', 'testing'], description: 'The status the configuration asks for.' },
          {
            name: 'oper-status', kind: 'leaf', type: 'enumeration',
            enums: ['up', 'down', 'testing', 'unknown', 'dormant', 'not-present', 'lower-layer-down'],
            description: 'Whether the interface can pass traffic now.',
          },
          { name: 'phys-address', kind: 'leaf', type: 'yang:phys-address', description: 'The MAC address, as xx:xx:xx:xx:xx:xx.' },
          { name: 'speed', kind: 'leaf', type: 'gauge64', units: 'bits/second', description: 'The bandwidth of the interface.' },
          {
            name: 'statistics', kind: 'container', description: 'Counters since the device started.',
            children: [
              COUNTER('in-octets', 'Bytes received.'),
              COUNTER('in-unicast-pkts', 'Unicast packets received.'),
              COUNTER('in-discards', 'Received packets dropped without an error.'),
              COUNTER('in-errors', 'Received packets dropped because of an error.'),
              COUNTER('out-octets', 'Bytes sent.'),
              COUNTER('out-unicast-pkts', 'Unicast packets sent.'),
              COUNTER('out-discards', 'Packets dropped before sending without an error.'),
              COUNTER('out-errors', 'Packets that could not be sent because of an error.'),
            ],
          },
          {
            name: 'ipv4', kind: 'container', module: 'ietf-ip', description: 'The IPv4 address the interface uses now.',
            children: [
              {
                name: 'address', kind: 'list', keys: ['ip'], description: 'An address in use.',
                children: [
                  { name: 'ip', kind: 'leaf', type: 'inet:ipv4-address-no-zone', description: 'The address, the key of the list.' },
                  { name: 'prefix-length', kind: 'leaf', type: 'uint8', range: [0, 32], description: 'The length of the network prefix.' },
                  { name: 'origin', kind: 'leaf', type: 'enumeration', enums: ['other', 'static', 'dhcp', 'link-layer', 'random'], description: 'Where the address came from.' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'modules-state', kind: 'container', module: 'ietf-yang-library', config: false,
    description: 'The YANG modules this device serves.',
    children: [
      { name: 'module-set-id', kind: 'leaf', type: 'string', description: 'Changes whenever the list of modules changes.' },
      {
        name: 'module', kind: 'list', keys: ['name', 'revision'], description: 'One module.',
        children: [
          { name: 'name', kind: 'leaf', type: 'yang:yang-identifier', description: 'The module name.' },
          { name: 'revision', kind: 'leaf', type: 'revision-identifier', description: 'The revision date of the module.' },
          { name: 'namespace', kind: 'leaf', type: 'inet:uri', description: 'The XML namespace of the module.' },
          { name: 'conformance-type', kind: 'leaf', type: 'enumeration', enums: ['implement', 'import'], description: 'Whether the device serves the module\'s data or only uses its definitions.' },
        ],
      },
    ],
  },
  {
    name: 'native', kind: 'container', module: 'nf-native', config: true,
    description: 'NetForge device settings (an original NetForge model).',
    children: [
      {
        name: 'hostname', kind: 'leaf', type: 'string', description: 'The device name shown in the prompt.',
        lines: [
          { op: 'set', lines: [{ mode: 'config', text: 'hostname <hostname>' }] },
          { op: 'unset', lines: [{ mode: 'config', text: 'no hostname' }] },
        ],
        example: { hostname: 'SW1' },
      },
      {
        name: 'banner', kind: 'container', description: 'Messages the device shows.',
        children: [
          {
            name: 'motd', kind: 'leaf', type: 'string', description: 'The message shown before login (one line).',
            lines: [
              { op: 'set', lines: [{ mode: 'config', text: 'banner motd ^C<motd>^C' }] },
              { op: 'unset', lines: [{ mode: 'config', text: 'no banner motd' }] },
            ],
            example: { motd: 'Authorised access only' },
          },
        ],
      },
      {
        name: 'vlan', kind: 'container', description: 'The VLANs configured on a switch.',
        children: [
          {
            name: 'vlan-list', kind: 'list', keys: ['id'], description: 'One VLAN.',
            lines: [
              { op: 'set', lines: [VLAN_LINE] },
              { op: 'unset', lines: [{ mode: 'config', text: 'no vlan <id>' }] },
            ],
            example: { id: '30' },
            children: [
              { name: 'id', kind: 'leaf', type: 'uint16', range: [1, 4094], description: 'The VLAN number, the key of the list.' },
              {
                name: 'name', kind: 'leaf', type: 'string', description: 'The VLAN name (one word, up to 32 characters).',
                lines: [
                  { op: 'set', lines: [VLAN_LINE, { mode: 'config-vlan', text: ' name <name>' }] },
                  { op: 'unset', lines: [VLAN_LINE, { mode: 'config-vlan', text: ' no name' }] },
                ],
                example: { name: 'VOICE' },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'save-config', kind: 'rpc', module: 'nf-native', config: false,
    description: 'Saves the running configuration as the startup configuration (POST /restconf/operations/nf-native:save-config).',
    lines: [{ op: 'exec', lines: [{ mode: 'config', text: 'do copy running-config startup-config' }] }],
  },
];

interface SchemaIndex {
  readonly nodes: readonly YangNode[];
  readonly byPath: ReadonlyMap<string, YangNode>;
}

let schemaIndex: SchemaIndex | undefined;

/** The node table, built on first use (rule 12). */
function schema(): SchemaIndex {
  if (schemaIndex !== undefined) return schemaIndex;
  const nodes: YangNode[] = [];
  const add = (spec: NodeSpec, parent: YangNode | undefined): YangNode => {
    const module = spec.module ?? parent?.module;
    if (module === undefined) throw new Error(`yang: top-level node ${spec.name} names no module`);
    const step = parent === undefined || parent.module !== module ? `${module}:${spec.name}` : spec.name;
    const path = parent === undefined ? step : `${parent.path}/${step}`;
    const config = spec.kind === 'rpc' ? false : spec.config ?? parent?.config ?? true;
    const childPaths: string[] = [];
    const node: YangNode = {
      path, module, name: spec.name, kind: spec.kind,
      ...(parent !== undefined ? { parent: parent.path } : {}),
      children: childPaths,
      ...(spec.keys !== undefined ? { keys: spec.keys } : {}),
      ...(spec.type !== undefined ? { type: spec.type } : {}),
      ...(spec.range !== undefined ? { range: spec.range } : {}),
      ...(spec.enums !== undefined ? { enums: spec.enums } : {}),
      ...(spec.base !== undefined ? { base: spec.base } : {}),
      ...(spec.default !== undefined ? { default: spec.default } : {}),
      ...(spec.units !== undefined ? { units: spec.units } : {}),
      config,
      description: spec.description,
      ...(spec.lines !== undefined ? { lines: spec.lines } : {}),
      ...(spec.example !== undefined ? { example: spec.example } : {}),
    };
    nodes.push(node);
    for (const c of spec.children ?? []) childPaths.push(add(c, node).path);
    return node;
  };
  for (const s of SCHEMA) add(s, undefined);
  schemaIndex = { nodes: Object.freeze(nodes), byPath: new Map(nodes.map((n) => [n.path, n])) };
  return schemaIndex;
}

/** Every node of the model, in schema order (parents before children). */
export function yangNodes(): readonly YangNode[] {
  return schema().nodes;
}

/** The node with this schema path, or undefined. */
export function yangNode(path: string): YangNode | undefined {
  return schema().byPath.get(path);
}

/** The top-level data nodes (not operations), in schema order. */
export function yangTopNodes(): readonly YangNode[] {
  return schema().nodes.filter((n) => n.parent === undefined && n.kind !== 'rpc');
}

/** The operations (`/restconf/operations/<module>:<name>`). */
export function yangOperations(): readonly YangNode[] {
  return schema().nodes.filter((n) => n.kind === 'rpc');
}

/** The children of a node, as nodes. */
export function yangChildren(node: YangNode): YangNode[] {
  return node.children.map((p) => yangNode(p) as YangNode);
}

/** The RFC 7951 member name of a node: qualified at the top level and where the module changes. */
export function yangMemberName(node: YangNode): string {
  const parent = node.parent !== undefined ? yangNode(node.parent) : undefined;
  return parent === undefined || parent.module !== node.module ? `${node.module}:${node.name}` : node.name;
}

/** Every placeholder value an example of `node` needs: the examples of the node and of its ancestors. */
export function yangExampleValues(node: YangNode): Record<string, string> {
  const chain: YangNode[] = [];
  for (let n: YangNode | undefined = node; n !== undefined; n = n.parent !== undefined ? yangNode(n.parent) : undefined) chain.unshift(n);
  const out: Record<string, string> = {};
  for (const n of chain) Object.assign(out, n.example ?? {});
  return out;
}

/** Fills `<placeholder>`s of a template line; unknown placeholders are left as written. */
export function fillYangLine(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/<([a-z][a-z0-9-]*)>/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(values, k) ? (values[k] as string) : m));
}

// ── path resolution ──────────────────────────────────────────────────────────

/** One resolved step of a RESTCONF path. `keys` holds the key values of a list step, in `node.keys` order. */
export interface YangStep {
  readonly node: YangNode;
  readonly keys?: readonly string[];
}

export type YangErrorTag =
  | 'invalid-value'
  | 'malformed-message'
  | 'unknown-element'
  | 'missing-element'
  | 'data-exists'
  | 'operation-not-supported';

/** A refusal with its RESTCONF status and error-tag (RFC 8040 §7), and an original message. */
export interface YangError {
  readonly status: 400 | 404 | 405 | 409;
  readonly errorTag: YangErrorTag;
  readonly message: string;
}

export type YangResolveResult = { readonly ok: true; readonly steps: readonly YangStep[] } | { readonly ok: false; readonly error: YangError };

const fail = (status: YangError['status'], errorTag: YangErrorTag, message: string): { ok: false; error: YangError } => ({ ok: false, error: { status, errorTag, message } });

/** Resolves a data path (from `parseRestconfTarget`) to model nodes. The empty path is the whole datastore. */
export function resolveYangPath(path: readonly ApiSegment[]): YangResolveResult {
  const steps: YangStep[] = [];
  let parent: YangNode | undefined;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i] as ApiSegment;
    const module = seg.module ?? parent?.module;
    const candidates = parent === undefined ? yangTopNodes() : yangChildren(parent);
    const node = candidates.find((n) => n.name === seg.name && n.module === module);
    if (node === undefined) {
      const other = candidates.find((n) => n.name === seg.name);
      if (other !== undefined && seg.module === undefined) {
        return fail(404, 'invalid-value', `"${seg.name}" belongs to the module ${other.module}; write it as "${other.module}:${seg.name}".`);
      }
      const where = parent === undefined ? 'at the top of the data' : `inside ${parent.path}`;
      return fail(404, 'invalid-value', `There is no "${seg.module !== undefined ? `${seg.module}:` : ''}${seg.name}" ${where}.`);
    }
    if (parent !== undefined && steps.length > 0) {
      const prev = steps[steps.length - 1] as YangStep;
      if (prev.node.kind === 'list' && prev.keys === undefined) {
        return fail(400, 'malformed-message', `Name the entry of ${prev.node.name} with its key (${prev.node.name}=<${(prev.node.keys ?? []).join('>,<')}>) before going inside it.`);
      }
    }
    if (node.kind === 'list') {
      if (seg.keys !== undefined && seg.keys.length !== (node.keys ?? []).length) {
        return fail(400, 'malformed-message', `${node.name} is keyed by ${(node.keys ?? []).join(', ')}: give ${(node.keys ?? []).length} key value(s).`);
      }
    } else if (seg.keys !== undefined) {
      return fail(400, 'malformed-message', `"${seg.name}" is not a list, so it takes no "=" key.`);
    }
    steps.push(seg.keys !== undefined ? { node, keys: seg.keys } : { node });
    if (node.kind === 'leaf' && i < path.length - 1) return fail(404, 'invalid-value', `"${node.name}" is a leaf: nothing is inside it.`);
    parent = node;
  }
  return { ok: true, steps };
}

/** Resolves an operation path (`/restconf/operations/nf-native:save-config`). */
export function resolveYangOperation(path: readonly ApiSegment[]): { ok: true; node: YangNode } | { ok: false; error: YangError } {
  const seg = path[0];
  if (path.length !== 1 || seg === undefined) return fail(404, 'invalid-value', 'Name one operation, as "<module>:<operation>".');
  const node = yangOperations().find((n) => n.name === seg.name && n.module === seg.module);
  if (node === undefined) return fail(404, 'invalid-value', `There is no operation "${seg.module ?? ''}:${seg.name}".`);
  return { ok: true, node };
}

// ── the device view ──────────────────────────────────────────────────────────

/** The iana-if-type identities NetForge interfaces use. */
export type YangIfType =
  | 'ethernetCsmacd'
  | 'softwareLoopback'
  | 'l3ipvlan'
  | 'propPointToPointSerial'
  | 'tunnel'
  | 'ieee80211'
  | 'ieee8023adLag'
  | 'l2vlan'
  | 'other';

export interface YangInterfaceCounters {
  readonly inOctets: number;
  readonly inUnicastPkts: number;
  readonly inDiscards: number;
  readonly inErrors: number;
  readonly outOctets: number;
  readonly outUnicastPkts: number;
  readonly outDiscards: number;
  readonly outErrors: number;
}

/** One interface as the RESTCONF daemon sees it (from its port views). */
export interface YangInterfaceView {
  /** The canonical long name (`GigabitEthernet0/1`, `Vlan99`). */
  readonly name: string;
  readonly ifType: YangIfType;
  /** Administratively up; absent: from the configuration (a `shutdown` line means down). */
  readonly enabled?: boolean;
  /** Passing traffic now; absent: `oper-status` "unknown". */
  readonly operUp?: boolean;
  /** Any 12-hex-digit MAC notation; written as xx:xx:xx:xx:xx:xx. */
  readonly physAddress?: string;
  readonly speedBps?: number;
  readonly counters?: YangInterfaceCounters;
  /** The address in use now, when it did not come from `ip address A M` (a DHCP lease). */
  readonly dynamicAddress?: { readonly ip: string; readonly prefixLength: number; readonly origin: 'dhcp' | 'other' };
}

/** What the reader and the write planner need from a device. */
export interface YangDeviceView {
  readonly hostname: string;
  /** The running configuration's root (`ConfigAst.root`). */
  readonly config: ConfigNode;
  /** Every interface, in the device's port order. */
  readonly interfaces: readonly YangInterfaceView[];
}

// ── reading ──────────────────────────────────────────────────────────────────

const childNodes = (n: ConfigNode, key: string): ConfigNode[] => n.children.filter((c) => c.key === key);
const childNode = (n: ConfigNode, key: string): ConfigNode | undefined => n.children.find((c) => c.key === key);

/** The prefix length of a dotted mask, or undefined when it is not contiguous. */
export function maskToPrefixLength(mask: string): number | undefined {
  const parts = mask.split('.');
  if (parts.length !== 4) return undefined;
  let bits = 0;
  let ended = false;
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    for (let b = 7; b >= 0; b--) {
      const on = ((v >> b) & 1) === 1;
      if (on && ended) return undefined;
      if (on) bits++;
      else ended = true;
    }
  }
  return bits;
}

/** The dotted mask of a prefix length 0-32. */
export function prefixLengthToMask(len: number): string {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, len - i * 8));
    out.push(take === 0 ? 0 : (0xff << (8 - take)) & 0xff);
  }
  return out.join('.');
}

function macText(raw: string): string | undefined {
  const hex = raw.replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
  if (hex.length !== 12) return undefined;
  return (hex.match(/../g) as string[]).join(':');
}

interface IfConfig {
  readonly description?: string;
  readonly shutdown: boolean;
  readonly address?: { readonly ip: string; readonly prefixLength: number };
}

function interfaceConfig(root: ConfigNode, name: string): IfConfig {
  const section = root.children.find((c) => c.key === 'interface' && c.args[0] === name);
  if (section === undefined) return { shutdown: false };
  const description = childNode(section, 'description')?.args.join(' ');
  const shutdown = childNode(section, 'shutdown') !== undefined;
  let address: IfConfig['address'];
  for (const ip of childNodes(section, 'ip')) {
    const a = childNode(ip, 'address');
    if (a !== undefined && a.args.length === 2) {
      const len = maskToPrefixLength(a.args[1] as string);
      if (len !== undefined) address = { ip: a.args[0] as string, prefixLength: len };
    }
  }
  return { ...(description !== undefined ? { description } : {}), shutdown, ...(address !== undefined ? { address } : {}) };
}

function interfacesConfigTree(dev: YangDeviceView): DataObject | undefined {
  const list: DataObject[] = [];
  for (const itf of dev.interfaces) {
    const cfg = interfaceConfig(dev.config, itf.name);
    const entry: DataObject = { name: itf.name };
    if (cfg.description !== undefined) entry['description'] = cfg.description;
    entry['type'] = `iana-if-type:${itf.ifType}`;
    entry['enabled'] = itf.enabled ?? !cfg.shutdown;
    if (cfg.address !== undefined) entry['ietf-ip:ipv4'] = { address: [{ ip: cfg.address.ip, 'prefix-length': cfg.address.prefixLength }] };
    list.push(entry);
  }
  return list.length > 0 ? { interface: list } : undefined;
}

function interfacesStateTree(dev: YangDeviceView): DataObject | undefined {
  const list: DataObject[] = [];
  for (const itf of dev.interfaces) {
    const cfg = interfaceConfig(dev.config, itf.name);
    const enabled = itf.enabled ?? !cfg.shutdown;
    const entry: DataObject = { name: itf.name, type: `iana-if-type:${itf.ifType}` };
    entry['admin-status'] = enabled ? 'up' : 'down';
    entry['oper-status'] = itf.operUp === undefined ? 'unknown' : itf.operUp && enabled ? 'up' : 'down';
    const mac = itf.physAddress !== undefined ? macText(itf.physAddress) : undefined;
    if (mac !== undefined) entry['phys-address'] = mac;
    if (itf.speedBps !== undefined) entry['speed'] = String(itf.speedBps);
    const c = itf.counters;
    if (c !== undefined) {
      entry['statistics'] = {
        'in-octets': String(c.inOctets), 'in-unicast-pkts': String(c.inUnicastPkts), 'in-discards': String(c.inDiscards), 'in-errors': String(c.inErrors),
        'out-octets': String(c.outOctets), 'out-unicast-pkts': String(c.outUnicastPkts), 'out-discards': String(c.outDiscards), 'out-errors': String(c.outErrors),
      };
    }
    const addr = cfg.address !== undefined ? { ip: cfg.address.ip, prefixLength: cfg.address.prefixLength, origin: 'static' } : itf.dynamicAddress;
    if (addr !== undefined) entry['ietf-ip:ipv4'] = { address: [{ ip: addr.ip, 'prefix-length': addr.prefixLength, origin: addr.origin }] };
    list.push(entry);
  }
  return list.length > 0 ? { interface: list } : undefined;
}

function modulesStateTree(): DataObject {
  return {
    'module-set-id': YANG_MODULE_SET_ID,
    module: YANG_MODULES.map((m) => ({ name: m.name, revision: m.revision, namespace: m.namespace, 'conformance-type': m.conformance })),
  };
}

function nativeTree(dev: YangDeviceView): DataObject {
  const out: DataObject = { hostname: dev.hostname };
  const banner = dev.config.children.find((c) => c.key === 'banner' && c.args[0] === 'motd');
  if (banner !== undefined && banner.args.length > 1) out['banner'] = { motd: banner.args.slice(1).join(' ') };
  const vlans: DataObject[] = [];
  for (const v of childNodes(dev.config, 'vlan')) {
    const id = Number(v.args[0]);
    if (v.args.length !== 1 || !/^[0-9]+$/.test(v.args[0] as string)) continue;
    const entry: DataObject = { id };
    const name = childNode(v, 'name')?.args[0];
    if (name !== undefined) entry['name'] = name;
    vlans.push(entry);
  }
  vlans.sort((a, b) => (a['id'] as number) - (b['id'] as number));
  if (vlans.length > 0) out['vlan'] = { 'vlan-list': vlans };
  return out;
}

/** The configuration data (config true) of a device, as an RFC 7951 datastore object. */
export function readYangConfig(dev: YangDeviceView): DataObject {
  const out: DataObject = {};
  const ifs = interfacesConfigTree(dev);
  if (ifs !== undefined) out['ietf-interfaces:interfaces'] = ifs;
  out['nf-native:native'] = nativeTree(dev);
  return out;
}

/** Everything the device serves, configuration and state, as an RFC 7951 datastore object (top-level nodes in schema order). */
export function readYangDatastore(dev: YangDeviceView): DataObject {
  const out: DataObject = {};
  const ifs = interfacesConfigTree(dev);
  if (ifs !== undefined) out['ietf-interfaces:interfaces'] = ifs;
  const state = interfacesStateTree(dev);
  if (state !== undefined) out['ietf-interfaces:interfaces-state'] = state;
  out['ietf-yang-library:modules-state'] = modulesStateTree();
  out['nf-native:native'] = nativeTree(dev);
  return out;
}

/** Whether a list entry matches the key values of a step (compared as their URL text). */
function entryMatches(entry: DataValue, node: YangNode, keys: readonly string[]): boolean {
  if (!isDataObject(entry)) return false;
  return (node.keys ?? []).every((k, i) => {
    const v = entry[k];
    return v !== undefined && v !== null && typeof v !== 'object' && String(v) === keys[i];
  });
}

/** Follows resolved steps inside a datastore object; undefined when an instance on the way does not exist. */
function valueAt(tree: DataObject, steps: readonly YangStep[]): DataValue | undefined {
  let cur: DataValue | undefined = tree;
  for (const step of steps) {
    if (!isDataObject(cur)) return undefined;
    const member = yangMemberName(step.node);
    const v: DataValue | undefined = Object.prototype.hasOwnProperty.call(cur, member) ? cur[member] : undefined;
    if (v === undefined) return undefined;
    if (step.node.kind === 'list' && step.keys !== undefined) {
      if (!Array.isArray(v)) return undefined;
      const keys = step.keys;
      cur = v.find((e) => entryMatches(e, step.node, keys));
    } else cur = v;
  }
  return cur;
}

export type YangReadResult = { readonly ok: true; readonly value: DataObject } | { readonly ok: false; readonly error: YangError };

/**
 * The body of a RESTCONF GET: the target wrapped in its qualified member name (a list entry as a one-element array;
 * the whole datastore as `ietf-restconf:data`). 404 when the target holds no data.
 */
export function readYang(dev: YangDeviceView, steps: readonly YangStep[]): YangReadResult {
  const tree = readYangDatastore(dev);
  if (steps.length === 0) return { ok: true, value: { 'ietf-restconf:data': tree } };
  const v = valueAt(tree, steps);
  const last = steps[steps.length - 1] as YangStep;
  if (v === undefined) return fail(404, 'invalid-value', `${describeTarget(steps)} holds no data on this device.`);
  const out: DataObject = {};
  const member = `${last.node.module}:${last.node.name}`;
  setDataMember(out, member, last.node.kind === 'list' && last.keys !== undefined ? [v] : v);
  return { ok: true, value: out };
}

function describeTarget(steps: readonly YangStep[]): string {
  return steps.map((s) => (s.keys !== undefined ? `${s.node.name}=${s.keys.join(',')}` : s.node.name)).join('/');
}

// ── XML hints ────────────────────────────────────────────────────────────────

/** The node a member path (RFC 7951 names, from the top-level member down) names, or undefined. */
export function yangNodeOfMembers(members: readonly string[]): YangNode | undefined {
  let node: YangNode | undefined;
  for (const m of members) {
    const colon = m.indexOf(':');
    const module = colon > 0 ? m.slice(0, colon) : node?.module;
    const name = colon > 0 ? m.slice(colon + 1) : m;
    const candidates = node === undefined ? [...yangTopNodes(), ...yangOperations()] : yangChildren(node);
    node = candidates.find((n) => n.name === name && n.module === module);
    if (node === undefined) return undefined;
  }
  return node;
}

/** The JSON value of a leaf's text per its type (RFC 7951); unknown or unparsable text stays a string. */
function leafFromText(node: YangNode | undefined, text: string): DataValue {
  switch (node?.type) {
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : text;
    case 'uint8':
    case 'uint16':
      return /^[0-9]+$/.test(text) ? Number(text) : text;
    default:
      return text;
  }
}

/** Schema hints for converting RESTCONF XML to JSON (`xmlToData`) and namespaces for `dataToXml`. */
export function yangXmlHints(): Required<Pick<XmlToDataOptions, 'isArray' | 'scalar' | 'moduleOf'>> & { namespaceOf(module: string): string | undefined } {
  return {
    isArray: (path) => yangNodeOfMembers(path)?.kind === 'list',
    scalar: (path, text, selfClosing) => {
      const node = yangNodeOfMembers(path);
      if (node !== undefined && node.kind === 'container') return {};
      if (node === undefined && text === '' && selfClosing) return null;
      return leafFromText(node, text);
    },
    moduleOf: (ns) => yangModuleOfNamespace(ns),
    namespaceOf: (module) => yangNamespaceOf(module),
  };
}

// ── writing ──────────────────────────────────────────────────────────────────

export type YangWriteMethod = 'PUT' | 'POST' | 'PATCH' | 'DELETE';

export interface YangWriteRequest {
  readonly method: YangWriteMethod;
  /** The resolved data path (`resolveYangPath`); empty for the datastore itself. */
  readonly steps: readonly YangStep[];
  /** The parsed JSON body (PUT, POST, PATCH). */
  readonly body?: DataValue;
}

/**
 * A planned write: the indented configuration lines (possibly none, for a write that changes nothing) and the status
 * to answer when the CLI accepts them — 201 when the request created the target, else 204.
 */
export type YangWritePlan =
  | { readonly ok: true; readonly lines: readonly string[]; readonly status: 201 | 204 }
  | { readonly ok: false; readonly error: YangError };

class Refusal extends Error {
  constructor(readonly error: YangError) {
    super(error.message);
  }
}

const refuse = (status: YangError['status'], errorTag: YangErrorTag, message: string): never => {
  throw new Refusal({ status, errorTag, message });
};

const IPV4 = /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const UINT_MAX: Readonly<Record<string, number>> = { uint8: 255, uint16: 65535 };

/** Checks a body value against a node and returns it with canonical member names (RFC 7951). */
function normalize(node: YangNode, value: DataValue, where: string): DataValue {
  if (!node.config) refuse(400, 'invalid-value', `${where} is state data and cannot be written.`);
  switch (node.kind) {
    case 'leaf':
      return normalizeLeaf(node, value, where);
    case 'container': {
      if (!isDataObject(value)) return refuse(400, 'invalid-value', `${where} must be a JSON object.`);
      const out: DataObject = {};
      for (const member of Object.keys(value)) {
        const child = childOfMember(node, member, where);
        setDataMember(out, yangMemberName(child), normalizeMember(child, value[member] as DataValue, `${where}/${member}`));
      }
      return out;
    }
    case 'list':
      return normalizeEntry(node, value, where);
    case 'rpc':
      return refuse(405, 'operation-not-supported', `${where} is an operation; POST it under /restconf/operations.`);
  }
}

/** A member value inside a container or entry: a list member is an array of entries. */
function normalizeMember(node: YangNode, value: DataValue, where: string): DataValue {
  if (node.kind !== 'list') return normalize(node, value, where);
  if (!Array.isArray(value)) return refuse(400, 'invalid-value', `${where} is a list: its value must be a JSON array of entries.`);
  const seen = new Set<string>();
  return value.map((e) => {
    const entry = normalizeEntry(node, e, where);
    const k = (node.keys ?? []).map((key) => String(entry[key])).join(',');
    if (seen.has(k)) refuse(400, 'invalid-value', `${where} holds the entry ${k} twice.`);
    seen.add(k);
    return entry;
  });
}

function normalizeEntry(node: YangNode, value: DataValue, where: string): DataObject {
  if (!isDataObject(value)) return refuse(400, 'invalid-value', `An entry of ${where} must be a JSON object.`);
  const out: DataObject = {};
  for (const key of node.keys ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) refuse(400, 'missing-element', `An entry of ${where} needs its key "${key}".`);
  }
  for (const member of Object.keys(value)) {
    const child = childOfMember(node, member, where);
    setDataMember(out, yangMemberName(child), normalizeMember(child, value[member] as DataValue, `${where}/${member}`));
  }
  return out;
}

function childOfMember(node: YangNode, member: string, where: string): YangNode {
  const colon = member.indexOf(':');
  const module = colon > 0 ? member.slice(0, colon) : node.module;
  const name = colon > 0 ? member.slice(colon + 1) : member;
  const child = yangChildren(node).find((c) => c.name === name && c.module === module);
  if (child === undefined) {
    const other = yangChildren(node).find((c) => c.name === name);
    if (other !== undefined && colon < 0) refuse(400, 'unknown-element', `"${member}" belongs to the module ${other.module}; write it as "${other.module}:${name}".`);
    refuse(400, 'unknown-element', `"${member}" is not part of ${where}.`);
  }
  return child as YangNode;
}

function normalizeLeaf(node: YangNode, value: DataValue, where: string): DataValue {
  switch (node.type) {
    case 'string':
      if (typeof value !== 'string') return refuse(400, 'invalid-value', `${where} must be a string (in double quotes).`);
      if (/[\r\n]/.test(value)) return refuse(400, 'invalid-value', `${where} must fit on one line.`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') return refuse(400, 'invalid-value', `${where} must be true or false (without quotes).`);
      return value;
    case 'uint8':
    case 'uint16': {
      const max = UINT_MAX[node.type] as number;
      if (typeof value !== 'number') return refuse(400, 'invalid-value', `${where} must be a number (without quotes).`);
      if (!Number.isInteger(value) || value < 0 || value > max) return refuse(400, 'invalid-value', `${where} must be a whole number from 0 to ${max}.`);
      if (node.name === 'prefix-length' && value > 32) return refuse(400, 'invalid-value', `${where} must be from 0 to 32.`);
      return value;
    }
    case 'identityref':
      if (typeof value !== 'string') return refuse(400, 'invalid-value', `${where} must be a string such as "iana-if-type:ethernetCsmacd".`);
      return value.includes(':') ? value : `iana-if-type:${value}`;
    case 'inet:ipv4-address-no-zone':
      if (typeof value !== 'string' || !IPV4.test(value)) return refuse(400, 'invalid-value', `${where} must be an IPv4 address in quotes, such as "10.0.99.11".`);
      return value;
    default:
      return refuse(400, 'invalid-value', `${where} cannot be written.`);
  }
}

/** The one member of a PUT/PATCH/POST body, which must name `node` (qualified, RFC 7951 top level). */
function bodyMember(body: DataValue | undefined, accepts: (member: string) => YangNode | undefined, expected: string): { node: YangNode; value: DataValue; member: string } {
  if (body === undefined) return refuse(400, 'malformed-message', 'This request needs a JSON body.');
  if (!isDataObject(body)) return refuse(400, 'malformed-message', 'The body must be a JSON object.');
  const members = Object.keys(body);
  if (members.length !== 1) return refuse(400, 'malformed-message', `The body must hold exactly one member, ${expected}.`);
  const member = members[0] as string;
  const node = accepts(member);
  if (node === undefined) return refuse(400, 'unknown-element', `The body names "${member}"; this request expects ${expected}.`);
  return { node, value: body[member] as DataValue, member };
}

/** A list entry given as `[entry]` (RFC 8040) or as a bare object. */
function singleEntry(node: YangNode, value: DataValue, where: string): DataObject {
  const v = Array.isArray(value) ? (value.length === 1 ? (value[0] as DataValue) : refuse(400, 'invalid-value', `${where} must hold exactly one entry.`)) : value;
  return normalizeEntry(node, v, where);
}

function deepClone(v: DataValue): DataValue {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isDataObject(v)) {
    const out: DataObject = {};
    for (const k of Object.keys(v)) setDataMember(out, k, deepClone(v[k] as DataValue));
    return out;
  }
  return v;
}

/** Merges `patch` into `target` (RFC 8040 plain patch): objects member by member, list entries by key. */
function merge(node: YangNode, target: DataObject, patch: DataObject): void {
  for (const member of Object.keys(patch)) {
    const child = yangChildren(node).find((c) => yangMemberName(c) === member) as YangNode;
    const pv = patch[member] as DataValue;
    const cur = Object.prototype.hasOwnProperty.call(target, member) ? target[member] : undefined;
    if (child.kind === 'container' && isDataObject(cur) && isDataObject(pv)) merge(child, cur, pv);
    else if (child.kind === 'list' && Array.isArray(cur) && Array.isArray(pv)) {
      for (const e of pv as DataObject[]) {
        const keys = (child.keys ?? []).map((k) => String(e[k]));
        const existing = cur.find((x) => entryMatches(x, child, keys));
        if (isDataObject(existing)) merge(child, existing, e);
        else cur.push(e);
      }
    } else setDataMember(target, member, pv);
  }
}

interface Slot {
  /** The object that holds the target's member (for a list entry: the object holding the array). */
  readonly holder: DataObject;
  readonly member: string;
  /** A list entry: its index in the array, or -1 when it does not exist. */
  readonly index?: number;
}

/** Finds (creating containers on the way) where the target lives in `tree`; 404 when a list entry on the way is missing. */
function slotOf(tree: DataObject, steps: readonly YangStep[]): Slot {
  let holder = tree;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as YangStep;
    const member = yangMemberName(step.node);
    const last = i === steps.length - 1;
    if (step.node.kind === 'list' && step.keys !== undefined) {
      const arr = Object.prototype.hasOwnProperty.call(holder, member) ? holder[member] : undefined;
      const keys = step.keys;
      const index = Array.isArray(arr) ? arr.findIndex((e) => entryMatches(e, step.node, keys)) : -1;
      if (last) return { holder, member, index };
      if (index < 0) refuse(404, 'invalid-value', `${describeTarget(steps.slice(0, i + 1))} does not exist.`);
      holder = (arr as DataObject[])[index] as DataObject;
      continue;
    }
    if (last) return { holder, member };
    if (step.node.kind === 'list') refuse(400, 'malformed-message', `Name the entry of ${step.node.name} with its key.`);
    const cur = Object.prototype.hasOwnProperty.call(holder, member) ? holder[member] : undefined;
    if (!isDataObject(cur)) {
      const created: DataObject = {};
      setDataMember(holder, member, created);
      holder = created;
    } else holder = cur;
  }
  throw new Error('yang: empty path');
}

function existsAt(slot: Slot): boolean {
  if (slot.index !== undefined) return slot.index >= 0;
  return Object.prototype.hasOwnProperty.call(slot.holder, slot.member);
}

/** Checks that a list entry's keys equal the URL's (RFC 8040 §4.5). */
function checkKeys(step: YangStep, entry: DataObject): void {
  (step.node.keys ?? []).forEach((k, i) => {
    const v = entry[k];
    if (v === undefined || String(v) !== step.keys?.[i]) {
      refuse(400, 'invalid-value', `The body's ${k} (${v === undefined ? 'missing' : JSON.stringify(v)}) must equal the ${k} in the URL (${step.keys?.[i] ?? ''}).`);
    }
  });
}

function removeAt(slot: Slot): void {
  if (slot.index !== undefined) {
    const arr = slot.holder[slot.member] as DataValue[];
    arr.splice(slot.index, 1);
    if (arr.length === 0) delete slot.holder[slot.member];
  } else delete slot.holder[slot.member];
}

/** Applies the request to a copy of the configuration tree; returns the new tree and whether the target was created. */
function applyWrite(old: DataObject, req: YangWriteRequest): { tree: DataObject; created: boolean } {
  const tree = deepClone(old) as DataObject;
  const steps = req.steps;
  if (steps.length === 0) return refuse(405, 'operation-not-supported', 'Write to a resource inside /restconf/data, not to the whole datastore.');
  for (const s of steps) {
    if (s.node.kind === 'rpc') refuse(405, 'operation-not-supported', `${s.node.name} is an operation; POST it under /restconf/operations.`);
    if (!s.node.config) refuse(405, 'operation-not-supported', `${describeTarget(steps)} is state data (config false) and cannot be written.`);
  }
  const last = steps[steps.length - 1] as YangStep;
  const node = last.node;
  const where = describeTarget(steps);
  const qualified = `${node.module}:${node.name}`;
  if (node.kind === 'list' && last.keys === undefined && req.method !== 'POST') {
    refuse(400, 'malformed-message', `Name one entry of ${node.name} with its key (${node.name}=<${(node.keys ?? []).join('>,<')}>).`);
  }
  const parentStep = steps.length > 1 ? (steps[steps.length - 2] as YangStep) : undefined;
  const isKeyLeaf = node.kind === 'leaf' && parentStep?.node.kind === 'list' && (parentStep.node.keys ?? []).includes(node.name);
  const slot = node.kind === 'list' && last.keys === undefined ? undefined : slotOf(tree, steps);

  switch (req.method) {
    case 'DELETE': {
      if (slot === undefined || !existsAt(slot)) return refuse(404, 'invalid-value', `${where} does not exist, so there is nothing to delete.`);
      if (isKeyLeaf) refuse(400, 'invalid-value', `${node.name} is the key of its entry: delete the entry instead.`);
      removeAt(slot);
      return { tree, created: false };
    }
    case 'PUT':
    case 'PATCH': {
      const b = bodyMember(req.body, (m) => (m === qualified ? node : undefined), `"${qualified}"`);
      const s = slot as Slot;
      const existed = existsAt(s);
      if (req.method === 'PATCH' && !existed && node.kind !== 'container') return refuse(404, 'invalid-value', `${where} does not exist; PATCH changes only what exists (use PUT or POST to create it).`);
      if (node.kind === 'list') {
        const entry = singleEntry(node, b.value, where);
        checkKeys(last, entry);
        const arr = (Object.prototype.hasOwnProperty.call(s.holder, s.member) ? s.holder[s.member] : undefined) as DataObject[] | undefined;
        if (req.method === 'PATCH' && arr !== undefined) merge(node, arr[s.index as number] as DataObject, entry);
        else if (arr !== undefined && existed) arr[s.index as number] = entry;
        else if (arr !== undefined) arr.push(entry);
        else setDataMember(s.holder, s.member, [entry]);
        return { tree, created: !existed };
      }
      const value = normalize(node, b.value, where);
      if (isKeyLeaf && String(value) !== String(s.holder[s.member])) refuse(400, 'invalid-value', `${node.name} is the key of its entry and cannot be changed.`);
      if (req.method === 'PATCH' && node.kind === 'container' && isDataObject(value)) {
        const cur = s.holder[s.member];
        if (isDataObject(cur)) merge(node, cur, value);
        else setDataMember(s.holder, s.member, value);
      } else setDataMember(s.holder, s.member, value);
      return { tree, created: !existed };
    }
    case 'POST': {
      if (node.kind === 'leaf') return refuse(405, 'operation-not-supported', `POST creates a child of ${where}, which is a leaf; use PUT to set it.`);
      const parentNode = node.kind === 'list' && last.keys === undefined ? undefined : node;
      if (parentNode === undefined) return refuse(400, 'malformed-message', `POST to the resource that holds ${node.name} (the parent), with the new entry in the body.`);
      const s = slot as Slot;
      if (node.kind === 'list' && !existsAt(s)) return refuse(404, 'invalid-value', `${where} does not exist.`);
      const children = yangChildren(parentNode);
      const b = bodyMember(req.body, (m) => children.find((c) => `${c.module}:${c.name}` === m), 'one child of the target, with its module name');
      const child = b.node;
      if (!child.config) return refuse(400, 'invalid-value', `${b.member} is state data and cannot be written.`);
      let holder: DataObject;
      if (node.kind === 'list') holder = (s.holder[s.member] as DataObject[])[s.index as number] as DataObject;
      else {
        const cur = s.holder[s.member];
        if (isDataObject(cur)) holder = cur;
        else {
          holder = {};
          setDataMember(s.holder, s.member, holder);
        }
      }
      const member = yangMemberName(child);
      if (child.kind === 'list') {
        const entry = singleEntry(child, b.value, `${where}/${child.name}`);
        const keys = (child.keys ?? []).map((k) => String(entry[k]));
        const arr = Object.prototype.hasOwnProperty.call(holder, member) ? holder[member] : undefined;
        if (Array.isArray(arr) && arr.some((e) => entryMatches(e, child, keys))) {
          return refuse(409, 'data-exists', `${where}/${child.name}=${keys.join(',')} already exists (use PUT to replace it).`);
        }
        if (Array.isArray(arr)) arr.push(entry);
        else setDataMember(holder, member, [entry]);
        return { tree, created: true };
      }
      if (Object.prototype.hasOwnProperty.call(holder, member)) return refuse(409, 'data-exists', `${where}/${child.name} already exists (use PUT to replace it).`);
      setDataMember(holder, member, normalize(child, b.value, `${where}/${child.name}`));
      return { tree, created: true };
    }
  }
}

// The configuration state the lines are computed from.

interface IfState {
  readonly name: string;
  readonly type?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly address?: { readonly ip: string; readonly prefixLength: number };
}

interface ConfigState {
  readonly hostname?: string;
  readonly motd?: string;
  readonly vlans: ReadonlyMap<number, { readonly name?: string }>;
  readonly interfaces: ReadonlyMap<string, IfState>;
}

function stateOf(tree: DataObject): ConfigState {
  const native = isDataObject(tree['nf-native:native']) ? tree['nf-native:native'] : {};
  const hostname = typeof native['hostname'] === 'string' ? native['hostname'] : undefined;
  const banner = isDataObject(native['banner']) ? native['banner'] : {};
  const motd = typeof banner['motd'] === 'string' ? banner['motd'] : undefined;
  const vlans = new Map<number, { name?: string }>();
  const vlan = isDataObject(native['vlan']) ? native['vlan'] : {};
  for (const e of Array.isArray(vlan['vlan-list']) ? vlan['vlan-list'] : []) {
    if (!isDataObject(e) || typeof e['id'] !== 'number') continue;
    vlans.set(e['id'], typeof e['name'] === 'string' ? { name: e['name'] } : {});
  }
  const interfaces = new Map<string, IfState>();
  const ifs = isDataObject(tree['ietf-interfaces:interfaces']) ? tree['ietf-interfaces:interfaces'] : {};
  for (const e of Array.isArray(ifs['interface']) ? ifs['interface'] : []) {
    if (!isDataObject(e) || typeof e['name'] !== 'string') continue;
    const ipv4 = isDataObject(e['ietf-ip:ipv4']) ? e['ietf-ip:ipv4'] : {};
    const addrs = Array.isArray(ipv4['address']) ? ipv4['address'] : [];
    if (addrs.length > 1) refuse(400, 'invalid-value', `Interface ${e['name']}: a NetForge interface holds one IPv4 address.`);
    const a = addrs[0];
    let address: IfState['address'];
    if (isDataObject(a) && typeof a['ip'] === 'string') {
      if (typeof a['prefix-length'] !== 'number') refuse(400, 'missing-element', `Interface ${e['name']}: the address ${a['ip']} needs its prefix-length.`);
      address = { ip: a['ip'], prefixLength: a['prefix-length'] as number };
    }
    interfaces.set(e['name'], {
      name: e['name'],
      ...(typeof e['type'] === 'string' ? { type: e['type'] } : {}),
      ...(typeof e['description'] === 'string' ? { description: e['description'] } : {}),
      enabled: e['enabled'] !== false,
      ...(address !== undefined ? { address } : {}),
    });
  }
  return { ...(hostname !== undefined ? { hostname } : {}), ...(motd !== undefined ? { motd } : {}), vlans, interfaces };
}

/** The configuration lines that turn state `a` into state `b` (§5's canonical lines, indented for pasting). */
function linesBetween(a: ConfigState, b: ConfigState): string[] {
  const out: string[] = [];
  if (a.hostname !== b.hostname) out.push(b.hostname !== undefined ? `hostname ${b.hostname}` : 'no hostname');
  if (a.motd !== b.motd) {
    if (b.motd !== undefined && b.motd.includes('^C')) refuse(400, 'invalid-value', 'The banner text cannot contain "^C".');
    out.push(b.motd !== undefined ? `banner motd ^C${b.motd}^C` : 'no banner motd');
  }
  for (const id of [...a.vlans.keys()].sort((x, y) => x - y)) if (!b.vlans.has(id)) out.push(`no vlan ${id}`);
  for (const id of [...b.vlans.keys()].sort((x, y) => x - y)) {
    const nv = b.vlans.get(id) as { name?: string };
    const ov = a.vlans.get(id);
    if (ov === undefined) {
      out.push(`vlan ${id}`);
      if (nv.name !== undefined) out.push(` name ${nv.name}`);
    } else if (ov.name !== nv.name) out.push(`vlan ${id}`, nv.name !== undefined ? ` name ${nv.name}` : ' no name');
  }
  for (const name of a.interfaces.keys()) {
    if (!b.interfaces.has(name)) refuse(405, 'operation-not-supported', `Interface ${name} cannot be deleted through the API; change or remove its settings instead.`);
  }
  for (const [name, n] of b.interfaces) {
    const o = a.interfaces.get(name);
    if (o !== undefined && n.type !== undefined && o.type !== undefined && n.type !== o.type) {
      refuse(400, 'invalid-value', `Interface ${name} is of type ${o.type}; its type cannot change.`);
    }
    const sub: string[] = [];
    if (o?.description !== n.description) sub.push(n.description !== undefined ? ` description ${n.description}` : ' no description');
    const ak = o?.address !== undefined ? `${o.address.ip}/${o.address.prefixLength}` : undefined;
    const bk = n.address !== undefined ? `${n.address.ip}/${n.address.prefixLength}` : undefined;
    if (ak !== bk) sub.push(n.address !== undefined ? ` ip address ${n.address.ip} ${prefixLengthToMask(n.address.prefixLength)}` : ' no ip address');
    if (o === undefined || o.enabled !== n.enabled) sub.push(n.enabled ? ' no shutdown' : ' shutdown');
    if (o === undefined || sub.length > 0) out.push(`interface ${name}`, ...sub);
  }
  return out;
}

/**
 * Plans a RESTCONF write on a device: the configuration lines (for `configure {lines, atomic: true, indentation:
 * true}`) and the status to answer when they are applied, or the refusal. Pure: the device is not changed.
 */
export function planYangWrite(dev: YangDeviceView, req: YangWriteRequest): YangWritePlan {
  try {
    const old = readYangConfig(dev);
    const { tree, created } = applyWrite(old, req);
    const lines = linesBetween(stateOf(old), stateOf(tree));
    return { ok: true, lines, status: created ? 201 : 204 };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, error: e.error };
    throw e;
  }
}

/** The lines an operation runs (`save-config`), for the same `configure` action. */
export function yangOperationLines(node: YangNode): readonly string[] {
  return (node.lines ?? []).filter((t) => t.op === 'exec').flatMap((t) => t.lines.map((l) => l.text));
}
