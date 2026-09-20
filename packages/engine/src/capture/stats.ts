/**
 * capture/stats.ts — NetScope statistics: protocol hierarchy, conversations, endpoints and frame lengths
 * (ARCHITECTURE-P1 §4.12; contracts/capture.ts `CaptureStatistics`).
 *
 * Input: the frames that passed the display filter, in capture order, each with its original length, time and
 * decoded layers.
 *  • total / bytes: frame count and the sum of original lengths; durationNs: last time − first time (0 for fewer
 *    than two frames; frames out of time order use the minimum and maximum).
 *  • hierarchy: every prefix of each frame's protocol path counts the frame once ('ethernet', 'ethernet/ipv4',
 *    'ethernet/ipv4/tcp', 'ethernet/ipv4/tcp/http'). Rows are ordered as a tree: path segments compared one by one
 *    in first-seen order of the segment under its parent, so a parent always precedes its children.
 *  • conversations: per frame, the outermost ethernet layer (src/dst), the frame's own IP layer (the last
 *    ipv4/ipv6 before any ICMP quote) and its unquoted tcp/udp layer (`addr:port`). `a` is the lower end
 *    (capture/stream.ts `compareAddresses` / `compareStreamEndpoints`). Order: ethernet, ipv4, ipv6, tcp, udp, then
 *    first appearance.
 *  • endpoints: ethernet, ipv4 and ipv6 addresses; a frame counts once for its source and once for its destination
 *    (once in total when they are equal). Order: ethernet, ipv4, ipv6, then address order.
 *  • lengths: fixed buckets 0-19, 20-39, 40-79, 80-159, 160-319, 320-639, 640-1279, 1280-2559, 2560-5119 and
 *    '5120 and greater', all listed, by original length.
 */
import type { CaptureStatistics } from '../contracts/capture.js';
import type { FieldValue, LayerView } from '../contracts/pdu.js';
import type { SimTime } from '../contracts/time.js';
import { compareAddresses, compareStreamEndpoints, networkLayerIndex, transportView } from './stream.js';

/** One frame handed to the statistics. */
export interface StatsFrame {
  t: SimTime;
  /** Original length on the wire. */
  len: number;
  layers: readonly LayerView[];
}

/** Length buckets: [label, inclusive lower bound]. */
export const CAPTURE_LENGTH_BUCKETS: readonly (readonly [string, number])[] = Object.freeze([
  ['0-19', 0],
  ['20-39', 20],
  ['40-79', 40],
  ['80-159', 80],
  ['160-319', 160],
  ['320-639', 320],
  ['640-1279', 640],
  ['1280-2559', 1280],
  ['2560-5119', 2560],
  ['5120 and greater', 5120],
] as const);

type ConvProto = CaptureStatistics['conversations'][number]['proto'];
type EndProto = CaptureStatistics['endpoints'][number]['proto'];

const CONV_ORDER: readonly ConvProto[] = ['ethernet', 'ipv4', 'ipv6', 'tcp', 'udp'];
const END_ORDER: readonly EndProto[] = ['ethernet', 'ipv4', 'ipv6'];

function str(v: FieldValue | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Index of a length bucket for an original frame length. */
export function lengthBucketIndex(len: number): number {
  let idx = 0;
  for (let i = 0; i < CAPTURE_LENGTH_BUCKETS.length; i++) if (len >= CAPTURE_LENGTH_BUCKETS[i]![1]) idx = i;
  return idx;
}

interface HierNode {
  frames: number;
  bytes: number;
  children: Map<string, HierNode>;
}

function newNode(): HierNode {
  return { frames: 0, bytes: 0, children: new Map() };
}

/** Compute the statistics of `frames` (see the file header). */
export function computeCaptureStatistics(frames: readonly StatsFrame[]): CaptureStatistics {
  let bytes = 0;
  let tMin = 0;
  let tMax = 0;
  const root = newNode();
  const conv = new Map<string, CaptureStatistics['conversations'][number]>();
  const ends = new Map<string, CaptureStatistics['endpoints'][number]>();
  const lengths = CAPTURE_LENGTH_BUCKETS.map(([bucket]) => ({ bucket, frames: 0 }));

  const addConv = (proto: ConvProto, x: string, y: string, cmp: (a: string, b: string) => number, t: SimTime, len: number): void => {
    const [a, b] = cmp(x, y) <= 0 ? [x, y] : [y, x];
    const key = `${proto}|${a}|${b}`;
    const c = conv.get(key);
    if (c === undefined) {
      conv.set(key, { proto, a, b, frames: 1, bytes: len, firstNs: t, lastNs: t });
      return;
    }
    c.frames++;
    c.bytes += len;
    if (t < c.firstNs) c.firstNs = t;
    if (t > c.lastNs) c.lastNs = t;
  };
  const addEnd = (proto: EndProto, address: string, len: number): void => {
    const key = `${proto}|${address}`;
    const e = ends.get(key);
    if (e === undefined) ends.set(key, { proto, address, frames: 1, bytes: len });
    else {
      e.frames++;
      e.bytes += len;
    }
  };
  const addPair = (proto: EndProto, src: string | undefined, dst: string | undefined, t: SimTime, len: number): void => {
    if (src !== undefined) addEnd(proto, src, len);
    if (dst !== undefined && dst !== src) addEnd(proto, dst, len);
    if (src !== undefined && dst !== undefined) addConv(proto, src, dst, compareAddresses, t, len);
  };

  frames.forEach((f, i) => {
    bytes += f.len;
    if (i === 0 || f.t < tMin) tMin = f.t;
    if (i === 0 || f.t > tMax) tMax = f.t;
    lengths[lengthBucketIndex(f.len)]!.frames++;

    let node = root;
    for (const l of f.layers) {
      let child = node.children.get(l.proto);
      if (child === undefined) {
        child = newNode();
        node.children.set(l.proto, child);
      }
      child.frames++;
      child.bytes += f.len;
      node = child;
    }

    const eth = f.layers.find((l) => l.proto === 'ethernet');
    if (eth !== undefined) addPair('ethernet', str(eth.fields.src), str(eth.fields.dst), f.t, f.len);
    const ni = networkLayerIndex(f.layers);
    if (ni >= 0) {
      const ip = f.layers[ni]!;
      addPair(ip.proto as 'ipv4' | 'ipv6', str(ip.fields.src), str(ip.fields.dst), f.t, f.len);
    }
    const tv = transportView(f.layers);
    if (tv !== undefined) addConv(tv.proto, tv.srcEndpoint, tv.dstEndpoint, compareStreamEndpoints, f.t, f.len);
  });

  const hierarchy: CaptureStatistics['hierarchy'] = [];
  const walk = (n: HierNode, prefix: string): void => {
    for (const [proto, child] of n.children) {
      const path = prefix === '' ? proto : `${prefix}/${proto}`;
      hierarchy.push({ path, frames: child.frames, bytes: child.bytes });
      walk(child, path);
    }
  };
  walk(root, '');

  const conversations = [...conv.values()]
    .map((c, order) => ({ c, order }))
    .sort((x, y) => CONV_ORDER.indexOf(x.c.proto) - CONV_ORDER.indexOf(y.c.proto) || x.c.firstNs - y.c.firstNs || x.order - y.order)
    .map((x) => x.c);
  const endpoints = [...ends.values()].sort((x, y) => END_ORDER.indexOf(x.proto) - END_ORDER.indexOf(y.proto) || compareAddresses(x.address, y.address));

  return {
    total: frames.length,
    bytes,
    durationNs: frames.length < 2 ? 0 : tMax - tMin,
    hierarchy,
    conversations,
    endpoints,
    lengths,
  };
}
