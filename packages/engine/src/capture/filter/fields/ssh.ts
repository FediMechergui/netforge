/** capture/filter/fields/ssh.ts — Secure Shell display fields ([S13]; ARCHITECTURE-P3 §2.3, §3.14; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const SSH_DISPLAY_FIELDS = protoDisplayFields({
  help: { ssh: 'Secure Shell (TCP 22): after a clear version exchange, the whole session is protected (simulated encryption).' },
  aliases: [
    { name: 'ssh.protocol', reads: ['ssh.version'], help: 'Version string of the clear exchange, e.g. "SSH-2.0-…" (ssh.version).' },
    { name: 'ssh.packet_length', reads: ['ssh.length'], help: 'Length of a protected packet (ssh.length).' },
  ],
  values: { 'ssh.phase': ['version', 'protected'] },
});
