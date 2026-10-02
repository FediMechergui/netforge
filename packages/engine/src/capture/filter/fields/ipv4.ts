/** capture/filter/fields/ipv4.ts — IPv4 display fields (`ip` names, the DSCP of the differentiated services field). */
import { protoDisplayFields } from './kit.js';

export const IPV4_DISPLAY_FIELDS = protoDisplayFields({
  help: { ipv4: 'Internet Protocol version 4.' },
  protocolAliases: [{ name: 'ip', proto: 'ipv4' }],
  aliases: [
    { name: 'ip.src', reads: ['ipv4.src'], help: 'IPv4 source address (ipv4.src).' },
    { name: 'ip.dst', reads: ['ipv4.dst'], help: 'IPv4 destination address (ipv4.dst).' },
    { name: 'ip.addr', reads: ['ipv4.src', 'ipv4.dst'], help: 'Either IPv4 address of the packet.' },
    { name: 'ip.ttl', reads: ['ipv4.ttl'], help: 'IPv4 time to live (ipv4.ttl).' },
    { name: 'ip.proto', reads: ['ipv4.protocol'], help: 'IPv4 upper-layer protocol number (ipv4.protocol).' },
    { name: 'ip.len', reads: ['ipv4.totalLength'], help: 'IPv4 total length (ipv4.totalLength).' },
    { name: 'ip.id', reads: ['ipv4.id'], help: 'IPv4 identification (ipv4.id).' },
    { name: 'ip.dsfield.dscp', reads: ['ipv4.dscp'], help: 'IPv4 DSCP value (ipv4.dscp).' },
  ],
});
