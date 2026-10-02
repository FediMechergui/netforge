/**
 * capture/filter/fields/ospf.ts — OSPFv2 packet display fields (ARCHITECTURE-P3 §2.3, §3.1; W2 capture).
 *
 * The canonical `ospf.<field>` entries come from PROTO_FIELDS (`ospf.type == 1` selects the hellos). Familiar names:
 * `ospf.msg` (the packet type), `ospf.srcrouter`, `ospf.area_id`, the `ospf.hello.*` parameters and the database
 * description's MTU and sequence; derived: every neighbour a hello lists (`ospf.hello.active_neighbor`, one value per
 * router id) and the database description's I, M and MS bits as booleans.
 */
import type { LayerView } from '../../../contracts/pdu.js';
import { derived, derivedField, flagBit, isDottedIpv4, listEntries, numberField, protoDisplayFields } from './kit.js';

/** OSPF packet type of a database description (RFC 2328 A.3.3). */
const OSPF_TYPE_DBD = 2;

const isDbd = (layer: LayerView): boolean => numberField(layer, 'type') === OSPF_TYPE_DBD;

export const OSPF_DISPLAY_FIELDS = protoDisplayFields({
  help: { ospf: 'Open Shortest Path First version 2 (IP protocol 89): hellos, database descriptions, link-state requests, updates and acknowledgements.' },
  aliases: [
    { name: 'ospf.msg', reads: ['ospf.type'], help: 'OSPF packet type: 1 hello, 2 database description, 3 link-state request, 4 link-state update, 5 link-state acknowledgement (ospf.type).' },
    { name: 'ospf.srcrouter', reads: ['ospf.routerId'], help: 'Router id of the sending router (ospf.routerId).' },
    { name: 'ospf.area_id', reads: ['ospf.area'], help: 'Area the packet belongs to, written as an address, e.g. 0.0.0.0 (ospf.area).' },
    { name: 'ospf.hello.network_mask', reads: ['ospf.mask'], help: 'Hello: network mask of the sending interface (ospf.mask).' },
    { name: 'ospf.hello.hello_interval', reads: ['ospf.helloInterval'], help: 'Hello: seconds between hellos; neighbours must agree (ospf.helloInterval).' },
    { name: 'ospf.hello.router_priority', reads: ['ospf.priority'], help: 'Hello: priority in the DR election, 0 = never DR or BDR (ospf.priority).' },
    { name: 'ospf.hello.router_dead_interval', reads: ['ospf.deadInterval'], help: 'Hello: seconds of silence before a neighbour is declared down; neighbours must agree (ospf.deadInterval).' },
    { name: 'ospf.hello.designated_router', reads: ['ospf.dr'], help: 'Hello: the designated router as the sender sees it, 0.0.0.0 = none (ospf.dr).' },
    { name: 'ospf.hello.backup_designated_router', reads: ['ospf.bdr'], help: 'Hello: the backup designated router as the sender sees it, 0.0.0.0 = none (ospf.bdr).' },
    { name: 'ospf.db.interface_mtu', reads: ['ospf.mtu'], help: 'Database description: the interface MTU; a mismatch stalls the exchange (ospf.mtu).' },
    { name: 'ospf.db.dd_sequence', reads: ['ospf.ddSeq'], help: 'Database description: sequence number (ospf.ddSeq).' },
  ],
  derived: [
    derivedField(
      'ospf.hello.active_neighbor',
      ['ospf.neighbors'],
      'ipv4',
      'Hello: a router id the sender has heard on this link (one value per neighbour listed).',
      derived('ospf', (layer) => listEntries(layer, 'neighbors', ',').filter(isDottedIpv4)),
    ),
    derivedField('ospf.dbd.i', ['ospf.flags'], 'bool', 'Database description: I bit, the first packet of the exchange. Compare with 1 or 0.', derived('ospf', flagBit('flags', 4, isDbd))),
    derivedField('ospf.dbd.m', ['ospf.flags'], 'bool', 'Database description: M bit, more packets follow. Compare with 1 or 0.', derived('ospf', flagBit('flags', 2, isDbd))),
    derivedField('ospf.dbd.ms', ['ospf.flags'], 'bool', 'Database description: MS bit, the sender is the master of the exchange. Compare with 1 or 0.', derived('ospf', flagBit('flags', 1, isDbd))),
  ],
});
