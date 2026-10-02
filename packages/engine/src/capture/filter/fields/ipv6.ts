/** capture/filter/fields/ipv6.ts — IPv6 display fields. */
import { protoDisplayFields } from './kit.js';

export const IPV6_DISPLAY_FIELDS = protoDisplayFields({
  help: { ipv6: 'Internet Protocol version 6.' },
  aliases: [
    { name: 'ipv6.addr', reads: ['ipv6.src', 'ipv6.dst'], help: 'Either IPv6 address of the packet.' },
    { name: 'ipv6.hlim', reads: ['ipv6.hopLimit'], help: 'IPv6 hop limit (ipv6.hopLimit).' },
    { name: 'ipv6.nxt', reads: ['ipv6.nextHeader'], help: 'IPv6 next header (ipv6.nextHeader).' },
    { name: 'ipv6.plen', reads: ['ipv6.payloadLength'], help: 'IPv6 payload length (ipv6.payloadLength).' },
  ],
});
