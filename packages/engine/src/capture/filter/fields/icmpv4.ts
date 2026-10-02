/** capture/filter/fields/icmpv4.ts — ICMP for IPv4 display fields (`icmp` names). */
import { protoDisplayFields } from './kit.js';

export const ICMPV4_DISPLAY_FIELDS = protoDisplayFields({
  help: { icmpv4: 'ICMP for IPv4 (echo, unreachable, time exceeded).' },
  protocolAliases: [{ name: 'icmp', proto: 'icmpv4' }],
  aliases: [
    { name: 'icmp.type', reads: ['icmpv4.type'], help: 'ICMP type (icmpv4.type).' },
    { name: 'icmp.code', reads: ['icmpv4.code'], help: 'ICMP code (icmpv4.code).' },
    { name: 'icmp.ident', reads: ['icmpv4.id'], help: 'ICMP echo identifier (icmpv4.id).' },
    { name: 'icmp.seq', reads: ['icmpv4.seq'], help: 'ICMP echo sequence number (icmpv4.seq).' },
  ],
});
