/** capture/filter/fields/gre.ts — GRE display fields ([S18]; ARCHITECTURE-P3 §2.3, §3.10; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const GRE_DISPLAY_FIELDS = protoDisplayFields({
  help: { gre: 'Generic Routing Encapsulation (IP protocol 47): a tunnel header in front of the carried packet.' },
  aliases: [
    { name: 'gre.proto', reads: ['gre.protocolType'], help: 'Protocol of the carried packet, e.g. 0x0800 for IPv4 (gre.protocolType).' },
    { name: 'gre.flags.checksum', reads: ['gre.checksumPresent'], help: 'A checksum follows the header (gre.checksumPresent).' },
    { name: 'gre.flags.key', reads: ['gre.keyPresent'], help: 'A key follows the header (gre.keyPresent).' },
    { name: 'gre.flags.sequence_number', reads: ['gre.seqPresent'], help: 'A sequence number follows the header (gre.seqPresent).' },
    { name: 'gre.flags.version', reads: ['gre.version'], help: 'GRE version, 0 (gre.version).' },
  ],
});
