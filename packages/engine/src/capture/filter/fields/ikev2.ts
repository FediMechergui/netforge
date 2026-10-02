/**
 * capture/filter/fields/ikev2.ts — IKEv2 display fields ([C13]; ARCHITECTURE-P3 §2.17, §3.13; W2 capture). The familiar
 * `isakmp` names (the protocol family IKE belongs to) read the RFC 7296 header.
 */
import { protoDisplayFields } from './kit.js';

const NOTIFICATIONS = ['AUTHENTICATION_FAILED', 'NO_PROPOSAL_CHOSEN'];

export const IKEV2_DISPLAY_FIELDS = protoDisplayFields({
  help: { ikev2: 'Internet Key Exchange version 2 (UDP 500): the two ends authenticate each other and agree on the IPsec security associations.' },
  protocolAliases: [{ name: 'isakmp', proto: 'ikev2' }],
  aliases: [
    { name: 'isakmp.ispi', reads: ['ikev2.spiI'], help: 'Initiator SPI, 16 hex digits (ikev2.spiI).' },
    { name: 'isakmp.rspi', reads: ['ikev2.spiR'], help: 'Responder SPI, 16 hex digits, zeros in the first request (ikev2.spiR).' },
    { name: 'isakmp.exchtype', reads: ['ikev2.exchange'], help: 'Exchange type: 34 IKE_SA_INIT, 35 IKE_AUTH (ikev2.exchange).' },
    { name: 'isakmp.messageid', reads: ['ikev2.messageId'], help: 'Message id pairing a response with its request (ikev2.messageId).' },
  ],
  values: { 'ikev2.notify': NOTIFICATIONS },
});
