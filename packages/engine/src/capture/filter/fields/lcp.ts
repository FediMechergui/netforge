/** capture/filter/fields/lcp.ts — PPP Link Control Protocol display fields ([S19]; ARCHITECTURE-P3 §3.9; W2 capture). */
import { protoDisplayFields } from './kit.js';

const AUTH_PROTOCOLS = ['chap-md5', 'pap'];

export const LCP_DISPLAY_FIELDS = protoDisplayFields({
  help: { lcp: 'PPP Link Control Protocol: the two ends agree on the link options (MRU, authentication, magic number), keep it alive with echoes and close it.' },
  aliases: [
    { name: 'lcp.opt.mru', reads: ['lcp.mru'], help: 'Maximum receive unit option (lcp.mru).' },
    { name: 'lcp.opt.magic_number', reads: ['lcp.magic'], help: 'Magic number option; equal numbers at both ends reveal a looped link (lcp.magic).' },
    { name: 'lcp.opt.auth_protocol', reads: ['lcp.authProto'], help: 'Authentication protocol option: "chap-md5" or "pap" (lcp.authProto).' },
  ],
  values: { 'lcp.authProto': AUTH_PROTOCOLS, 'lcp.opt.auth_protocol': AUTH_PROTOCOLS },
});
