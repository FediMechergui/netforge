/** capture/filter/fields/ipv6-ext.ts — the four IPv6 extension headers (help text only). */
import { protoDisplayFields } from './kit.js';

export const IPV6_EXT_DISPLAY_FIELDS = protoDisplayFields({
  help: {
    'ipv6-hopopts': 'IPv6 hop-by-hop options header.',
    'ipv6-route': 'IPv6 routing header.',
    'ipv6-frag': 'IPv6 fragment header.',
    'ipv6-dstopts': 'IPv6 destination options header.',
  },
});
