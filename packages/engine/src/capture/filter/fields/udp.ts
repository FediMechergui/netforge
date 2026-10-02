/** capture/filter/fields/udp.ts — UDP display fields: ports and the payload length. */
import { derived, derivedField, protoDisplayFields } from './kit.js';

export const UDP_DISPLAY_FIELDS = protoDisplayFields({
  help: { udp: 'User Datagram Protocol.' },
  aliases: [
    { name: 'udp.port', reads: ['udp.srcPort', 'udp.dstPort'], help: 'Either UDP port.' },
    { name: 'udp.srcport', reads: ['udp.srcPort'], help: 'UDP source port (udp.srcPort).' },
    { name: 'udp.dstport', reads: ['udp.dstPort'], help: 'UDP destination port (udp.dstPort).' },
  ],
  derived: [
    derivedField('udp.len', ['udp'], 'number', 'UDP payload length, in bytes.', derived('udp', (layer) => Math.max(0, layer.length - layer.headerLength - (layer.trailerLength ?? 0)))),
  ],
});
