// Vocabulary tables (ARCHITECTURE-P1 §7, §8.1 W1 web-inspector): exhaustive over the engine unions, a unique
// non-colour channel for protocols and media, and original wording with no vendor or product names (D13).
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPWAP_MSG,
  DEVICE_CATEGORIES,
  DISPATCH_TABLE,
  GUI_PANELS,
  LANE_IDS,
  MEDIA,
  NF_OUI,
  PORT_ROLES,
  PROTO_FIELDS,
  TABLE_DESCRIPTORS,
} from '@netforge/engine';
import type { CapwapState, ChannelMemberState, FsmMachine, HsrpRow, PortSecurityRow, StpState } from '@netforge/engine';
import * as media from '../src/vocab/media.js';
import * as drops from '../src/vocab/drops.js';
import * as protocols from '../src/vocab/protocols.js';
import * as traceKinds from '../src/vocab/trace-kinds.js';
import * as fields from '../src/vocab/fields.js';
import * as categories from '../src/vocab/categories.js';
import * as lanes from '../src/vocab/lanes.js';
import * as fsm from '../src/vocab/fsm.js';

const THEME_TOKENS = ['text', 'textDim', 'accent', 'ok', 'warn', 'err', 'purple', 'yellow', 'blueDeep'];

const keys = (o: object): string[] => Object.keys(o).sort();

describe('media vocabulary', () => {
  it('covers every engine media type', () => {
    expect(keys(media.MEDIA_VOCAB)).toEqual(keys(MEDIA));
    for (const [k, v] of Object.entries(media.MEDIA_VOCAB)) {
      expect(v.media).toBe(k);
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.short.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
      expect(THEME_TOKENS).toContain(v.color);
      for (const d of v.dash) expect(d).toBeGreaterThan(0);
      expect(v.dash.length % 2).toBe(0);
    }
  });

  it('gives each media a unique badge and a unique line style', () => {
    const all = Object.keys(media.MEDIA_VOCAB) as (keyof typeof media.MEDIA_VOCAB)[];
    const badges = all.map((m) => media.MEDIA_VOCAB[m].badge);
    expect(new Set(badges).size).toBe(badges.length);
    const styles = all.map((m) => media.mediaLineStyleKey(m));
    expect(new Set(styles).size).toBe(styles.length);
  });

  it('orders the picker with auto first and lists each offered media once', () => {
    expect(media.MEDIA_PICKER_ORDER[0]).toBe('auto');
    expect(new Set(media.MEDIA_PICKER_ORDER).size).toBe(media.MEDIA_PICKER_ORDER.length);
    const offered = Object.values(media.MEDIA_VOCAB).filter((v) => v.picker).map((v) => v.media).sort();
    expect([...media.MEDIA_PICKER_ORDER].sort()).toEqual(offered);
  });

  it('explains which end is DCE for every serial media and only those', () => {
    for (const v of Object.values(media.MEDIA_VOCAB)) {
      expect(v.dceHint !== undefined, v.media).toBe(MEDIA[v.media].class === 'serial');
    }
    expect(media.mediaDceEnd('serial-dce')).toBe('a');
    expect(media.mediaDceEnd('serial-dte')).toBe('b');
  });

  it('words link-down reasons with end names', () => {
    const names = { deviceA: 'PC1', deviceB: 'SW1', endA: 'Gi0 on PC1', endB: 'Fa0/1 on SW1', lengthM: 150 };
    const off = media.linkDownText('admin-down:b', names);
    expect(off).toMatchObject({ code: 'admin-down', side: 'b', known: true, short: 'the port on SW1 is shut down' });
    expect(off.explain.startsWith('Fa0/1 on SW1 is administratively shut down.')).toBe(true);
    expect(media.linkDownText('power-off:a', names).short).toBe('PC1 is powered off or still starting');
    expect(media.linkDownText('too-long', names).explain).toContain('150 m');
    expect(media.linkDownText('keepalive-missed').explain.startsWith('One end stopped')).toBe(true);
    expect(media.linkDownText('mystery')).toMatchObject({ known: false, short: 'mystery', explain: 'The link is down (mystery).' });
    expect(media.linkDownText(undefined).short).toBe('no signal');
    for (const v of Object.values(media.LINK_DOWN_VOCAB)) {
      expect(v.short.length).toBeGreaterThan(0);
      expect(v.explain.length).toBeGreaterThan(0);
    }
  });

  it('words line-protocol reasons', () => {
    expect(media.lineProtocolText('no-clock')).toContain('clock');
    expect(media.lineProtocolText('other')).toBe('other');
    expect(media.lineProtocolText(undefined)).toBe('');
  });
});

describe('drop vocabulary', () => {
  it('has a tag, sentence and hint for every reason', () => {
    expect(drops.DROP_REASONS.length).toBe(Object.keys(drops.DROP_VOCAB).length);
    for (const [k, v] of Object.entries(drops.DROP_VOCAB)) {
      expect(v.reason).toBe(k);
      expect(v.tag.length).toBeGreaterThan(0);
      expect(v.tag.length).toBeLessThanOrEqual(32);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.hint.length).toBeGreaterThan(0);
      expect(Object.keys(drops.DROP_CATEGORY_LABELS)).toContain(v.category);
    }
  });

  it('builds marker text like the P0 markers', () => {
    expect(drops.dropTag('no-route')).toEqual({ title: 'no route', detail: '' });
    expect(drops.dropTag('other', 'virtual-transmit')).toEqual({ title: 'virtual-transmit', detail: '' });
    expect(drops.dropTag('unknown-code', 'x')).toEqual({ title: 'unknown-code', detail: 'x' });
    const long = 'a'.repeat(60);
    expect(drops.dropTag('no-route', long).detail.length).toBe(drops.DROP_DETAIL_MAX);
    expect(drops.dropLabel('collision')).toContain('collision');
    expect(drops.dropLabel('zzz')).toBe('zzz');
  });

  it('words every frame-abort reason', () => {
    for (const v of Object.values(drops.FRAME_ABORT_TEXT)) expect(v.length).toBeGreaterThan(0);
  });
});

describe('protocol vocabulary', () => {
  it('covers every protocol with a field table and every non-reserved dispatch target', () => {
    const known = new Set<string>(protocols.KNOWN_PROTOS);
    for (const p of Object.keys(PROTO_FIELDS)) expect(known.has(p), p).toBe(true);
    for (const e of DISPATCH_TABLE) {
      if (e.reserved) expect(protocols.RESERVED_PROTOCOL_VOCAB[e.proto], e.proto).toBeDefined();
      else expect(known.has(e.proto), e.proto).toBe(true);
    }
  });

  it('gives every protocol a unique shape and letter pair, and unique letters', () => {
    const entries = Object.values(protocols.PROTOCOL_VOCAB);
    const pairs = entries.map((v) => `${v.shape}|${v.letter}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    const letters = entries.map((v) => v.letter);
    expect(new Set(letters).size).toBe(letters.length);
    for (const v of entries) {
      expect(protocols.PACKET_SHAPES).toContain(v.shape);
      expect(THEME_TOKENS).toContain(v.color);
      expect(v.letter.length).toBeGreaterThan(0);
      expect(v.letter.length).toBeLessThanOrEqual(2);
      expect(v.className).toBe(`p-${v.proto}`);
    }
  });

  it('keeps the P0 packet shapes', () => {
    expect(protocols.packetShapeFor('arp')).toBe('diamond');
    expect(protocols.packetShapeFor('icmpv4')).toBe('capsule');
    expect(protocols.packetShapeFor('ipv4')).toBe('hexagon');
    expect(protocols.packetShapeFor('something-else')).toBe('hexagon');
  });

  it('falls back for unknown and reserved names', () => {
    expect(protocols.protocolVocab('quic')).toBe(protocols.GENERIC_PROTOCOL);
    expect(protocols.protocolLabel('ssh')).toBe('SSH');
    expect(protocols.protocolLabel('quic')).toBe('quic');
    expect(protocols.protocolClassName('quic')).toBe('p-other');
    expect(protocols.isKnownProto('llc')).toBe(true);
    expect(protocols.PROTOCOL_VOCAB.llc.transparent).toBe(true);
  });
});

describe('trace-kind vocabulary', () => {
  it('lists every kind once with a label, help and group', () => {
    expect(new Set(traceKinds.TRACE_KINDS).size).toBe(traceKinds.TRACE_KINDS.length);
    for (const k of traceKinds.TRACE_KINDS) {
      const v = traceKinds.TRACE_KIND_VOCAB[k];
      expect(v.kind).toBe(k);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.help.length).toBeGreaterThan(0);
      expect(Object.keys(traceKinds.TRACE_KIND_GROUP_LABELS)).toContain(v.group);
    }
    const labels = traceKinds.TRACE_KINDS.map((k) => traceKinds.TRACE_KIND_VOCAB[k].label);
    expect(new Set(labels).size).toBe(labels.length);
    const grouped = Object.keys(traceKinds.TRACE_KIND_GROUP_LABELS).flatMap((g) => traceKinds.traceKindsInGroup(g as traceKinds.TraceKindGroup));
    expect([...grouped].sort()).toEqual([...traceKinds.TRACE_KINDS].sort());
  });

  it('keeps the P0 defaults and the simulation-mode list', () => {
    expect(traceKinds.DEFAULT_HIDDEN_TRACE_KINDS).toEqual(['cliPrompt']);
    expect(traceKinds.SIM_MODE_LIST_KINDS).toEqual(['frameTx', 'drop', 'tableWrite']);
    expect(traceKinds.traceKindLabel('drop')).toBe('Dropped');
    expect(traceKinds.traceKindLabel('nope')).toBe('nope');
  });

  it('gives association phases unique badges per technology', () => {
    for (const table of [traceKinds.WIFI_ASSOC_STATE_VOCAB, traceKinds.CELL_ATTACH_STATE_VOCAB]) {
      const badges = Object.values(table).map((v) => v.badge);
      expect(new Set(badges).size).toBe(badges.length);
    }
    expect(traceKinds.assocStateVocab('wifi', 'handshake')?.badge).toBe('4W');
    expect(traceKinds.assocStateVocab('cellular', 'handshake')).toBeUndefined();
    expect(traceKinds.portStateReasonText('role-change').length).toBeGreaterThan(0);
    expect(traceKinds.portStateReasonText('admin')).toBe('admin');
  });
});

describe('field formatters', () => {
  it('renders every field of every protocol table without throwing', () => {
    const samples: (string | number | boolean | Uint8Array | null)[] = [0, 1, 3, 17, 0x0800, 65535, true, false, '', 'SA', new Uint8Array([1, 2]), null];
    for (const table of Object.values(PROTO_FIELDS)) {
      for (const f of table.fields) {
        for (const s of samples) {
          const out = fields.formatField(table.proto, f.name, s, { type: 3 });
          expect(typeof out).toBe('string');
          expect(out.length, `${table.proto}.${f.name}`).toBeGreaterThan(0);
        }
        expect(fields.fieldHelp(table.proto, f.name).length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the P0 renderings and names new numbers', () => {
    expect(fields.formatField('ethernet', 'type', 0x0800)).toBe('0x0800 (IPv4)');
    expect(fields.formatField('ethernet', 'type', 0x888e)).toBe('0x888e (EAPOL key)');
    expect(fields.formatField('ethernet', 'fcs', 0xdeadbeef)).toBe('0xdeadbeef');
    expect(fields.formatField('ipv4', 'protocol', 1)).toBe('1 (ICMP)');
    expect(fields.formatField('ipv4', 'checksum', 0xab)).toBe('0x00ab');
    expect(fields.formatField('ipv4', 'id', 16)).toBe('16 (0x0010)');
    expect(fields.formatField('ipv4', 'checksumValid', true)).toBe('✓ valid');
    expect(fields.formatField('ipv4', 'checksumValid', false)).toBe('✗ invalid');
    expect(fields.formatField('arp', 'op', 2)).toBe('2 (reply)');
    expect(fields.formatField('icmpv4', 'type', 8)).toBe('8 (echo request)');
    expect(fields.formatField('icmpv4', 'code', 3, { type: 3 })).toBe('3 (port unreachable)');
    expect(fields.formatField('icmpv4', 'code', 3)).toBe('3');
    expect(fields.formatField('hdlc', 'protocol', 0x8035)).toBe('0x8035 (serial keepalive)');
    expect(fields.formatField('hdlc', 'fcs', 0x1234)).toBe('0x1234');
    expect(fields.formatField('udp', 'dstPort', 67)).toBe('67 (DHCP)');
    expect(fields.formatField('tcp', 'dstPort', 22)).toBe('22 (SSH)');
    expect(fields.formatField('tcp', 'flags', 'SA')).toBe('SA (SYN, ACK)');
    expect(fields.formatField('ipv4', 'flags', 2)).toBe("2 (don't fragment)");
    expect(fields.formatField('payload', 'data', new Uint8Array([0xab]))).toBe('1 bytes: ab');
    expect(fields.formatField('ipv4', 'ttl', undefined)).toBe('—');
    expect(fields.formatMutationValue('ipv4.protocol', 1)).toBe('1');
    expect(fields.formatMutationValue('ipv4.ttl', 127)).toBe('127');
    expect(fields.formatMutationValue('raw.bytes', 0x10)).toBe('0x10');
  });

  it('formats durations, rates and signal with units', () => {
    expect(fields.formatDurationNs(512)).toBe('512 ns');
    expect(fields.formatDurationNs(1_500_000)).toBe('1.5 ms');
    expect(fields.formatDurationNs(250_000_000)).toBe('250 ms');
    expect(fields.formatDurationNs(299 * 1_000_000_000)).toBe('4 min 59 s');
    expect(fields.formatDurationNs(4 * 3_600 * 1_000_000_000)).toBe('4 h 0 min');
    expect(fields.formatSeconds(86_400)).toBe('86400 s (1 d 0 h)');
    expect(fields.formatBps(100_000_000)).toBe('100 Mb/s');
    expect(fields.formatBps(64_000)).toBe('64 kb/s');
    expect(fields.formatBps(undefined)).toBe('—');
    expect(fields.formatSignal(-67, 3)).toBe('▮▮▮▯ -67 dBm');
  });

  it('formats every table column of every descriptor', () => {
    for (const d of Object.values(TABLE_DESCRIPTORS)) {
      for (const c of d.columns) {
        expect(fields.formatTableCell(c.format, undefined)).toBe('—');
        expect(typeof fields.formatTableCell(c.format, 42, 10)).toBe('string');
      }
    }
    expect(fields.formatTableCell('time', 5_000_000_000, 2_000_000_000)).toBe('in 3 s');
    expect(fields.formatTableCell('time', 1, 2)).toBe('expired');
    expect(fields.formatTableCell('bool', true)).toBe('yes');
    expect(fields.formatTableCell('state', 'associated')).toBe('connected');
    expect(fields.formatTableCell('state', 'SYN_SENT')).toBe('SYN SENT');
  });

  it('describes every mutation reason and marks derived ones', () => {
    for (const [k, v] of Object.entries(fields.MUTATION_VOCAB)) {
      expect(v.reason).toBe(k);
      expect(v.icon.length).toBeGreaterThan(0);
      expect(v.label.length).toBeGreaterThan(0);
    }
    expect(fields.MUTATION_VOCAB.FcsRecompute.derived).toBe(true);
    expect(fields.MUTATION_VOCAB.TtlDecrement.derived).toBe(false);
    expect(fields.mutationVocab('Nope')).toBe(fields.MUTATION_VOCAB.Other);
  });
});

describe('category vocabulary', () => {
  it('follows the engine palette categories in order', () => {
    expect(categories.CATEGORY_ORDER).toEqual(DEVICE_CATEGORIES.map((c) => c.id));
    DEVICE_CATEGORIES.forEach((c, i) => {
      const v = categories.CATEGORY_VOCAB[c.id];
      expect(v).toMatchObject({ id: c.id, label: c.label, group: c.group, order: i });
      expect(v.hint.length).toBeGreaterThan(0);
    });
    const grouped = [...categories.categoriesInGroup('network'), ...categories.categoriesInGroup('end-devices')];
    expect(grouped.sort()).toEqual([...categories.CATEGORY_ORDER].sort());
    expect(categories.categoryLabel('home-soho')).toBe('Home & SOHO');
    expect(categories.categoryLabel(undefined)).toBe(categories.UNCATEGORISED_LABEL);
  });

  it('covers every capability, GUI panel, role and port kind', () => {
    expect(keys(categories.CAPABILITY_VOCAB)).toEqual([...CAPABILITIES].sort());
    for (const v of Object.values(categories.CAPABILITY_VOCAB)) {
      expect(v.words.length).toBeGreaterThan(0);
      for (const w of v.words) expect(w).toBe(w.toLowerCase());
    }
    expect(keys(categories.GUI_PANEL_VOCAB)).toEqual([...GUI_PANELS].sort());
    for (const r of PORT_ROLES) expect(categories.portRoleLabel(r, []).length).toBeGreaterThan(0);
    expect(categories.portRoleLabel('routed', ['host'])).toBe('Network adapter');
    expect(categories.portRoleLabel('routed', ['host', 'routing'])).toBe('Routed interface');
    expect(categories.portKindLabel('wlan')).toBe('Wi-Fi radio');
    expect(categories.portKindLabel('mystery')).toBe('mystery');
    expect(categories.capabilityWords(['wifi-ap', 'wifi-client'])).toEqual(['wireless', 'wi-fi', 'wifi', 'access point', 'ssid', 'wireless adapter']);
  });
});

describe('original wording (D13)', () => {
  const BANNED: readonly RegExp[] = [
    /cisco/i,
    /\bios\b/i,
    /\bnx-?os\b/i,
    /junos/i,
    /juniper/i,
    /arista/i,
    /huawei/i,
    /netgear/i,
    /linksys/i,
    /tp-?link/i,
    /ubiquiti/i,
    /meraki/i,
    /\baruba\b/i,
    /mikrotik/i,
    /catalyst/i,
    /packet\s*tracer/i,
    /wireshark/i,
    /tcpdump/i,
    /\bwindows\b/i,
    /\bmac\s?os\b/i,
    /\blinux\b/i,
    /\bandroid\b/i,
    /\biphone\b/i,
  ];

  function collect(value: unknown, out: string[], seen: Set<unknown>): void {
    if (typeof value === 'string') {
      out.push(value);
      return;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      for (const v of value.values()) collect(v, out, seen);
      return;
    }
    for (const v of Object.values(value)) collect(v, out, seen);
  }

  it('contains no vendor, operating-system or analyser product names', () => {
    const strings: string[] = [];
    const seen = new Set<unknown>();
    for (const mod of [media, drops, protocols, traceKinds, fields, categories]) collect(mod, strings, seen);
    expect(strings.length).toBeGreaterThan(300);
    for (const s of strings) for (const re of BANNED) expect(s, s).not.toMatch(re);
  });
});

// ── P2 vocabulary (ARCHITECTURE-P2 §6, §7 W1 web-inspector): real entries for the P2 unions, lanes [S1] and machines
// [S14]. Added cases only; the P0/P1 cases above are unchanged.
describe('P2 vocabulary', () => {
  it('words the P2 protocols, with control frames as hexagons and the tag as framing glue', () => {
    const p2 = ['dot1q', 'stp', 'lacp', 'dtp', 'dhcpv6', 'capwap', 'hsrp', 'pagp'] as const;
    for (const p of p2) {
      const v = protocols.PROTOCOL_VOCAB[p];
      expect(v.since, p).toBe('P2');
      expect(v.hint.length, p).toBeGreaterThan(0);
    }
    for (const p of ['stp', 'lacp', 'dtp', 'hsrp', 'pagp'] as const) expect(protocols.packetShapeFor(p), p).toBe('hexagon');
    expect(protocols.PROTOCOL_VOCAB.dot1q.transparent).toBe(true);
    expect(protocols.PROTOCOL_VOCAB.dot1q.layer).toBe('framing');
    expect(protocols.protocolLabel('dot1q')).toBe('802.1Q VLAN tag');
  });

  it('words the P2 drop reasons, capabilities, panel and roles', () => {
    for (const r of ['vlan-filtered', 'stp-discarding', 'port-security', 'nat-exhausted'] as const) {
      const v = drops.DROP_VOCAB[r];
      expect(v.tag.length, r).toBeLessThanOrEqual(32);
      expect(v.hint.length, r).toBeGreaterThan(20);
    }
    expect(drops.dropTag('vlan-filtered', 'VLAN 10 does not exist')).toEqual({ title: 'VLAN not carried here', detail: 'VLAN 10 does not exist' });
    expect(categories.CAPABILITY_VOCAB['managed-switch'].words).toContain('vlan');
    expect(categories.CAPABILITY_VOCAB['wireless-controller'].label).toBe('Wireless controller');
    expect(categories.GUI_PANEL_VOCAB['wlc.controller'].placement).toBe('inspector-tab');
    expect(categories.portRoleLabel('channel', ['switching'])).toBe('Port channel');
    expect(categories.portRoleLabel('subif', ['routing'])).toBe('Subinterface');
    expect(categories.portRoleLabel('wlan-tunnel', ['switching'])).toBe('Controller tunnel');
  });

  it('words the P2 port-state reasons', () => {
    const reasons = ['err-disabled', 'err-recovered', 'parent-down', 'no-encapsulation', 'vlan-missing', 'no-bundled-member', 'bundle-up', 'no-bridged-port-up'];
    for (const r of reasons) {
      const text = traceKinds.portStateReasonText(r);
      expect(text, r).not.toBe(r);
      expect(text.length, r).toBeGreaterThan(0);
    }
  });

  it('names the numbers of the P2 fields', () => {
    expect(fields.formatField('ethernet', 'type', 0x8100)).toBe('0x8100 (802.1Q VLAN tag)');
    expect(fields.formatField('ethernet', 'type', 0x0800)).toBe('0x0800 (IPv4)');
    expect(fields.formatField('ethernet', 'type', 39)).toBe('39 (802.3 length)');
    expect(fields.formatField('ethernet', 'type', 0x05dc)).toBe('1500 (802.3 length)');
    expect(fields.formatField('dot1q', 'type', 0x0806)).toBe('0x0806 (ARP)');
    expect(fields.formatField('dot1q', 'type', 39)).toBe('39 (802.3 length)');
    expect(fields.formatField('dot1q', 'pcp', 5)).toBe('5 (voice)');
    expect(fields.formatField('dot1q', 'vid', 10)).toBe('10');
    expect(fields.formatMutationValue('dot1q.vid', 10)).toBe('10');
    expect(fields.formatField('llc', 'dsap', 0x42)).toBe('0x42 (Spanning tree)');
    expect(fields.formatField('llc', 'dsap', 0xaa)).toBe('0xaa (SNAP)');
    expect(fields.formatField('llc', 'type', 0x0800, { oui: 0 })).toBe('0x0800 (IPv4)');
    expect(fields.formatField('llc', 'type', 1, { oui: NF_OUI })).toBe('0x0001 (Trunk negotiation)');
    expect(fields.formatField('llc', 'type', 3, { oui: NF_OUI })).toBe('0x0003 (Port aggregation)');
    expect(fields.formatField('llc', 'oui', NF_OUI)).toBe('0x024e46 (NetForge control protocols)');
    expect(fields.formatField('stp', 'version', 2)).toBe('2 (rapid spanning tree)');
    expect(fields.formatField('stp', 'bpduType', 0x80)).toBe('0x80 (topology change notice)');
    expect(fields.formatField('stp', 'flags', 0x3c)).toBe('0x3c (role designated, learning, forwarding)');
    expect(fields.formatField('stp', 'flags', 0x43)).toBe('0x43 (topology change, proposal, agreement)');
    expect(fields.formatField('stp', 'flags', 0)).toBe('0x00');
    expect(fields.formatField('stp', 'bridgePriority', 32778)).toBe('32778 (32768 + VLAN 10)');
    expect(fields.formatField('stp', 'rootPriority', 4096)).toBe('4096');
    expect(fields.formatField('stp', 'portId', 0x8001)).toBe('0x8001 (128.1)');
    expect(fields.formatField('stp', 'portId', 0x8401)).toBe('0x8401 (128.1025)');
    expect(fields.formatField('stp', 'forwardDelay', 3840)).toBe('3840 (15 s)');
    expect(fields.formatField('stp', 'maxAge', 20 * 256)).toBe('5120 (20 s)');
    expect(fields.formatField('lacp', 'actorState', 0x3d)).toBe('0x3d (active, long timeout, aggregatable, in sync, collecting, distributing)');
    expect(fields.formatField('lacp', 'partnerState', 0x00)).toBe('0x00 (passive, long timeout, individual)');
    expect(fields.formatField('dtp', 'adminMode', 3)).toBe('3 (dynamic desirable)');
    expect(fields.formatField('dhcpv6', 'msgType', 11)).toBe('11 (information request)');
    expect(fields.formatField('dhcpv6', 'elapsedTimeCs', 250)).toBe('250 (2.5 s)');
    expect(fields.formatField('hsrp', 'state', 16)).toBe('16 (active)');
    expect(fields.formatField('pagp', 'mode', 1)).toBe('1 (desirable)');
    expect(fields.formatField('udp', 'dstPort', 547)).toBe('547 (DHCPv6)');
    expect(fields.formatField('udp', 'dstPort', 5246)).toBe('5246 (CAPWAP)');
    expect(fields.formatField('udp', 'dstPort', 1985)).toBe('1985 (HSRP)');
    for (const [name, code] of Object.entries(CAPWAP_MSG)) {
      expect(fields.formatField('capwap', 'messageType', code), name).toMatch(/^\d+ \(.+\)$/);
    }
    expect(fields.formatField('capwap', 'messageType', CAPWAP_MSG.wlanConfigReq)).toBe('3398913 (IEEE 802.11 WLAN Configuration Request)');
  });
});

describe('timeline lane vocabulary [S1]', () => {
  it('covers every engine lane, in the engine canonical order', () => {
    expect(lanes.LANE_ORDER).toEqual([...LANE_IDS]);
    for (const id of LANE_IDS) {
      const v = lanes.LANE_VOCAB[id];
      expect(v.lane).toBe(id);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.hint.length).toBeGreaterThan(0);
      expect(THEME_TOKENS).toContain(v.color);
    }
  });

  it('gives every lane a unique glyph and a unique label (the non-colour channel)', () => {
    const glyphs = lanes.LANE_ORDER.map((l) => lanes.LANE_VOCAB[l].glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    for (const g of glyphs) expect(g.length).toBeLessThanOrEqual(2);
    const labels = lanes.LANE_ORDER.map((l) => lanes.LANE_VOCAB[l].label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(lanes.laneLabel('stp')).toBe('Spanning tree');
    expect(lanes.laneLabel('ospf')).toBe('ospf');
    expect(lanes.laneVocab('toString')).toBeUndefined();
  });
});

describe('state-machine vocabulary [S14]', () => {
  it('covers every machine with at least two unique states', () => {
    const machines: readonly FsmMachine[] = [
      'stp-port',
      'stp-bridge',
      'dtp',
      'lacp',
      'channel',
      'port-security',
      'err-disable',
      'nat',
      'dhcpv6',
      'capwap-wtp',
      'capwap-ac',
      'hsrp',
      'pagp',
    ];
    expect([...fsm.FSM_MACHINES].sort()).toEqual([...machines].sort());
    for (const m of fsm.FSM_MACHINES) {
      const v = fsm.FSM_VOCAB[m];
      expect(v.machine).toBe(m);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.states.length, m).toBeGreaterThanOrEqual(2);
      expect(new Set(v.states).size, m).toBe(v.states.length);
    }
  });

  it('uses the contract state words the rows carry', () => {
    const stpStates: readonly StpState[] = ['blocking', 'listening', 'learning', 'forwarding', 'discarding', 'disabled'];
    expect([...fsm.FSM_VOCAB['stp-port'].states].sort()).toEqual([...stpStates].sort());
    const member: readonly ChannelMemberState[] = ['bundled', 'waiting', 'suspended', 'individual', 'down'];
    for (const m of ['lacp', 'channel', 'pagp'] as const) expect([...fsm.FSM_VOCAB[m].states].sort()).toEqual([...member].sort());
    const capwap: readonly CapwapState[] = ['discovery', 'dtls', 'join', 'configure', 'data-check', 'run', 'idle'];
    expect([...fsm.FSM_VOCAB['capwap-wtp'].states].sort()).toEqual([...capwap].sort());
    expect(fsm.FSM_VOCAB.dtp.states).toEqual(['access', 'trunk']);
    const psec: readonly PortSecurityRow['status'][] = ['secure-up', 'secure-down', 'secure-shutdown'];
    expect([...fsm.FSM_VOCAB['port-security'].states].sort()).toEqual([...psec].sort());
    const hsrp: readonly HsrpRow['state'][] = ['initial', 'learn', 'listen', 'speak', 'standby', 'active'];
    expect(fsm.FSM_VOCAB.hsrp.states).toEqual(hsrp);
    expect(fsm.fsmStateIndex('stp-port', 'forwarding')).toBe(5);
    expect(fsm.fsmStateIndex('stp-port', 'mystery')).toBe(-1);
    expect(fsm.fsmStateIndex('ospf', 'full')).toBe(-1);
    expect(fsm.fsmLabel('dtp')).toBe('Trunk negotiation');
    expect(fsm.fsmLabel('ospf')).toBe('ospf');
  });
});

describe('original wording of the P2 tables (D22)', () => {
  const BANNED =
    /cisco|\bios\b|\bnx-?os\b|junos|juniper|arista|huawei|netgear|linksys|tp-?link|ubiquiti|meraki|\baruba\b|mikrotik|catalyst|packet\s*tracer|wireshark|tcpdump|\bwindows\b|\bmac\s?os\b|\blinux\b|\bandroid\b|\biphone\b/i;

  it('names no vendor, operating system or analyser in the lane and machine tables', () => {
    const strings: string[] = [];
    for (const v of Object.values(lanes.LANE_VOCAB)) strings.push(v.label, v.hint, v.glyph);
    for (const v of Object.values(fsm.FSM_VOCAB)) strings.push(v.label, ...v.states);
    expect(strings.length).toBeGreaterThan(60);
    for (const s of strings) expect(s, s).not.toMatch(BANNED);
  });
});
