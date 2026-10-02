/**
 * capture/filter/fields/eigrp.ts — EIGRP display fields ([C1]; ARCHITECTURE-P3 §2.16, §3.12; W2 capture).
 *
 * `eigrp.opcode == 5` selects the hellos, acknowledgements included (an acknowledgement is a hello carrying `ack`).
 * Derived: the destination network of each internal-route entry (`prefix/len,…` in `eigrp.routes`).
 */
import type { LayerView } from '../../../contracts/pdu.js';
import { derived, derivedField, isDottedIpv4, listEntries, protoDisplayFields } from './kit.js';

/** The network address of every route entry, in order. */
function destinations(layer: LayerView): string[] {
  const out: string[] = [];
  for (const entry of listEntries(layer, 'routes', ';')) {
    const prefix = (entry.split(',')[0] ?? '').split('/')[0]?.trim() ?? '';
    if (isDottedIpv4(prefix)) out.push(prefix);
  }
  return out;
}

export const EIGRP_DISPLAY_FIELDS = protoDisplayFields({
  help: { eigrp: 'Enhanced Interior Gateway Routing Protocol (IP protocol 88, RFC 7868): hellos and acknowledgements, updates, queries and replies.' },
  aliases: [
    { name: 'eigrp.par.holdtime', reads: ['eigrp.holdS'], help: 'Hold time a hello advertises, in seconds (eigrp.holdS).' },
  ],
  derived: [
    derivedField('eigrp.ipv4.destination', ['eigrp.routes'], 'ipv4', 'Destination network of a route the packet carries, e.g. 10.4.0.0 (one value per route).', derived('eigrp', destinations)),
  ],
});
