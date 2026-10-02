/** capture/filter/fields/icmpv6.ts — ICMP for IPv6 display fields. */
import { protoDisplayFields } from './kit.js';

export const ICMPV6_DISPLAY_FIELDS = protoDisplayFields({
  help: { icmpv6: 'ICMP for IPv6 (echo, neighbor discovery, router discovery, errors).' },
  aliases: [
    { name: 'icmpv6.nd.ns.target_address', reads: ['icmpv6.target'], help: 'Neighbor solicitation/advertisement target (icmpv6.target).' },
  ],
});
