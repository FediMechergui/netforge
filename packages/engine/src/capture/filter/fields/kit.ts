/**
 * capture/filter/fields/kit.ts — the shapes and helpers the per-protocol display-field files share
 * (ARCHITECTURE-P3 §0 rule 18, §7 W2 capture). Pure and DOM-free: it is reached from the `pure` entry through the index
 * file `capture/filter/fields.ts`.
 *
 * A per-protocol file (`fields/<proto>.ts`) exports one {@link ProtoDisplayFields}: the protocol's help text, its
 * familiar protocol names, its familiar field names over canonical `PROTO_FIELDS` paths, its derived fields and the
 * suggested values of its enumerated text fields. The index assembles every file into one registry; the canonical
 * `<proto>.<field>` entries themselves always come from `PROTO_FIELDS`, so a protocol without a file still filters.
 */
import type { DisplayFieldDef } from '../../../contracts/capture.js';
import type { FieldType } from '../../../contracts/fields.js';
import type { FieldValue, LayerView } from '../../../contracts/pdu.js';

/** The value type a display field compares as. */
export type DisplayFieldType = DisplayFieldDef['type'];

/** Frame metadata plus decoded layers that a display filter runs over (built by the capture store per record). */
export interface DisplayFilterFrame {
  /** frame.number: 1-based (record index + 1). */
  number: number;
  /** frame.len: original length on the wire. */
  len: number;
  /** Nanoseconds since the first record of the capture (frame.time_relative is shown in seconds). */
  timeRelativeNs: number;
  /** frame.interface: index of the capture interface. */
  iface: number;
  /** frame.interface_name: display name of the capture interface. */
  ifaceName?: string;
  /** frame.direction. */
  dir?: 'tx' | 'rx' | 'unknown';
  /** frame.corrupted. */
  corrupted?: boolean;
  /** Decoded layers, outermost first. */
  layers: readonly LayerView[];
  /** Captured bytes: frame.cap_len and `<protocol> contains "text"` read them. */
  bytes?: Uint8Array;
}

/** One extracted field value. Byte fields stay `Uint8Array`. */
export type DisplayScalar = number | string | boolean | Uint8Array;

/** A resolved field: its definition, a presence test and a value extractor. */
export interface DisplayFieldAccessor {
  readonly def: DisplayFieldDef;
  /** Every value of the field in the frame (empty when absent). Protocol fields return each layer's bytes. */
  values(frame: DisplayFilterFrame): DisplayScalar[];
  /** True when the field (or protocol) occurs in the frame. */
  present(frame: DisplayFilterFrame): boolean;
}

/** A familiar field name over one or more canonical paths; it compares as the first path's type. */
export interface PlainAlias {
  readonly name: string;
  readonly reads: readonly string[];
  readonly help: string;
}

/** A familiar protocol name (`eth` → `ethernet`). */
export interface ProtocolAlias {
  readonly name: string;
  readonly proto: string;
}

/** A field computed from decoded layers (flag letters, list entries, message kinds). */
export interface DerivedField {
  readonly name: string;
  /** The canonical paths it reads (shown by the inspector; not used to evaluate). */
  readonly reads: readonly string[];
  readonly type: DisplayFieldType;
  readonly help: string;
  readonly values: (frame: DisplayFilterFrame) => DisplayScalar[];
}

/** What one protocol file contributes to the display-filter registry. */
export interface ProtoDisplayFields {
  /** Help text of protocol entries, by canonical protocol name (default: "The <proto> protocol."). */
  readonly help?: Readonly<Record<string, string>>;
  readonly protocolAliases?: readonly ProtocolAlias[];
  readonly aliases?: readonly PlainAlias[];
  readonly derived?: readonly DerivedField[];
  /** Suggested values of enumerated text fields (completion after `==`), canonical and familiar spellings. */
  readonly values?: Readonly<Record<string, readonly string[]>>;
}

/** Display type of a canonical field type (uint/int → number, bytes → string). */
export function mapFieldType(t: FieldType): DisplayFieldType {
  switch (t) {
    case 'uint':
    case 'int':
      return 'number';
    case 'bool':
      return 'bool';
    case 'mac':
      return 'mac';
    case 'ipv4':
      return 'ipv4';
    case 'ipv6':
      return 'ipv6';
    case 'string':
    case 'bytes':
      return 'string';
  }
}

/** A frozen field definition. */
export function def(name: string, reads: readonly string[], type: DisplayFieldType, help: string): DisplayFieldDef {
  return Object.freeze({ name, reads: Object.freeze([...reads]), type, help });
}

function scalar(v: FieldValue | undefined): DisplayScalar | undefined {
  if (v === undefined || v === null) return undefined;
  return v;
}

/** Split a canonical path `proto.field` at its first dot. */
export function splitPath(path: string): [string, string] {
  const dot = path.indexOf('.');
  return [path.slice(0, dot), path.slice(dot + 1)];
}

/** Values of canonical path `proto.field` over every layer of `proto`, outermost first. */
function canonicalValues(frame: DisplayFilterFrame, proto: string, field: string): DisplayScalar[] {
  const out: DisplayScalar[] = [];
  for (const layer of frame.layers) {
    if (layer.proto !== proto) continue;
    const v = scalar(layer.fields[field]);
    if (v !== undefined) out.push(v);
  }
  return out;
}

function layerPresent(frame: DisplayFilterFrame, proto: string): boolean {
  for (const layer of frame.layers) if (layer.proto === proto) return true;
  return false;
}

function layerBytes(frame: DisplayFilterFrame, proto: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const bytes = frame.bytes;
  if (bytes === undefined) return out;
  for (const layer of frame.layers) {
    if (layer.proto !== proto) continue;
    const start = Math.min(Math.max(layer.offset, 0), bytes.length);
    const end = Math.min(start + Math.max(layer.length, 0), bytes.length);
    out.push(bytes.subarray(start, end));
  }
  return out;
}

/** An accessor whose presence test is "has at least one value". */
export function valuesAccessor(d: DisplayFieldDef, values: (frame: DisplayFilterFrame) => DisplayScalar[]): DisplayFieldAccessor {
  return Object.freeze({ def: d, values, present: (frame: DisplayFilterFrame) => values(frame).length > 0 });
}

/** An accessor reading the canonical paths of `d.reads` (any-of, outermost layer first per path). */
export function canonicalAccessor(d: DisplayFieldDef): DisplayFieldAccessor {
  const paths = d.reads.map(splitPath);
  return valuesAccessor(d, (frame) => {
    if (paths.length === 1) {
      const [p, f] = paths[0] as [string, string];
      return canonicalValues(frame, p, f);
    }
    const out: DisplayScalar[] = [];
    for (const [p, f] of paths) out.push(...canonicalValues(frame, p, f));
    return out;
  });
}

/** A protocol accessor: present when a layer of `proto` occurs; its values are those layers' bytes. */
export function protocolAccessor(d: DisplayFieldDef, proto: string): DisplayFieldAccessor {
  return Object.freeze({
    def: d,
    values: (frame: DisplayFilterFrame) => layerBytes(frame, proto),
    present: (frame: DisplayFilterFrame) => layerPresent(frame, proto),
  });
}

/** Map every layer of `proto` through `pick` (undefined results are skipped; arrays are spread). */
export function derived(proto: string, pick: (layer: LayerView) => DisplayScalar | DisplayScalar[] | undefined): (frame: DisplayFilterFrame) => DisplayScalar[] {
  return (frame) => {
    const out: DisplayScalar[] = [];
    for (const layer of frame.layers) {
      if (layer.proto !== proto) continue;
      const v = pick(layer);
      if (v === undefined) continue;
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    }
    return out;
  };
}

/** A derived field definition (the index turns it into an accessor). */
export function derivedField(name: string, reads: readonly string[], type: DisplayFieldType, help: string, values: (frame: DisplayFilterFrame) => DisplayScalar[]): DerivedField {
  return Object.freeze({ name, reads: Object.freeze([...reads]), type, help, values });
}

/** A string field of a layer, or undefined. */
export function textField(layer: LayerView, field: string): string | undefined {
  const v = layer.fields[field];
  return typeof v === 'string' ? v : undefined;
}

/** A number field of a layer, or undefined. */
export function numberField(layer: LayerView, field: string): number | undefined {
  const v = layer.fields[field];
  return typeof v === 'number' ? v : undefined;
}

/** The non-empty trimmed entries of a list-valued text field (`sep`-joined), in order. */
export function listEntries(layer: LayerView, field: string, sep: string): string[] {
  const text = textField(layer, field);
  if (text === undefined || text.length === 0) return [];
  const out: string[] = [];
  for (const part of text.split(sep)) {
    const t = part.trim();
    if (t.length > 0) out.push(t);
  }
  return out;
}

/** A flag bit of a number field as a boolean, only on layers where `when` holds (default: every layer). */
export function flagBit(field: string, mask: number, when?: (layer: LayerView) => boolean): (layer: LayerView) => DisplayScalar | undefined {
  return (layer) => {
    if (when !== undefined && !when(layer)) return undefined;
    const v = numberField(layer, field);
    if (v === undefined) return undefined;
    return (v & mask) !== 0;
  };
}

/** Text looks like a dotted IPv4 address (four decimal octets). */
export function isDottedIpv4(text: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  return m !== null && [m[1], m[2], m[3], m[4]].every((x) => Number(x) <= 255);
}

/** A frozen protocol file. */
export function protoDisplayFields(spec: ProtoDisplayFields): ProtoDisplayFields {
  return Object.freeze(spec);
}
