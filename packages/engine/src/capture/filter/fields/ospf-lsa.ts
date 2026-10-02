/**
 * capture/filter/fields/ospf-lsa.ts — OSPF link-state advertisement display fields (ARCHITECTURE-P3 §2.3; W2 capture).
 *
 * Each LSA (in an update) or LSA header copy (in a database description or an acknowledgement) is its own `ospf-lsa`
 * layer, so `ospf-lsa.lsType == 2` matches any packet carrying a network LSA or its header. Familiar names under
 * `ospf.lsa*` and `ospf.advrouter`; derived: the link ids of a router LSA and the routers attached to a network LSA.
 */
import type { LayerView } from '../../../contracts/pdu.js';
import { derived, derivedField, isDottedIpv4, listEntries, protoDisplayFields } from './kit.js';

/** The `<id>` of every `<kind>,<id>,<data>,<metric>` entry of a router LSA. */
function routerLinkIds(layer: LayerView): string[] {
  const out: string[] = [];
  for (const entry of listEntries(layer, 'links', ';')) {
    const id = (entry.split(',')[1] ?? '').trim();
    if (isDottedIpv4(id)) out.push(id);
  }
  return out;
}

export const OSPF_LSA_DISPLAY_FIELDS = protoDisplayFields({
  help: { 'ospf-lsa': 'An OSPF link-state advertisement in an update, or its 20-byte header in a database description or an acknowledgement.' },
  aliases: [
    { name: 'ospf.lsa', reads: ['ospf-lsa.lsType'], help: 'LSA type: 1 router, 2 network, 5 external (ospf-lsa.lsType).' },
    { name: 'ospf.lsa.age', reads: ['ospf-lsa.age'], help: 'LSA age in seconds; 3600 means the LSA is being flushed (ospf-lsa.age).' },
    { name: 'ospf.lsa.id', reads: ['ospf-lsa.lsid'], help: 'Link-state id (ospf-lsa.lsid).' },
    { name: 'ospf.advrouter', reads: ['ospf-lsa.advRouter'], help: 'Router id of the router that originated the LSA (ospf-lsa.advRouter).' },
    { name: 'ospf.lsa.seqnum', reads: ['ospf-lsa.seq'], help: 'LSA sequence number; the higher one is newer (ospf-lsa.seq).' },
  ],
  derived: [
    derivedField('ospf.lsa.router.linkid', ['ospf-lsa.links'], 'ipv4', 'Router LSA: the id of a link it describes (a neighbour router id, a DR address or a network).', derived('ospf-lsa', routerLinkIds)),
    derivedField('ospf.lsa.network.attachrtr', ['ospf-lsa.attached'], 'ipv4', 'Network LSA: the router id of a router attached to the network.', derived('ospf-lsa', (layer) => listEntries(layer, 'attached', ',').filter(isDottedIpv4))),
  ],
});
