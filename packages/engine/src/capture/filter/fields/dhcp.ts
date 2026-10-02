/** capture/filter/fields/dhcp.ts — DHCP (IPv4) display fields. */
import { protoDisplayFields } from './kit.js';

const MESSAGE_TYPES = ['DISCOVER', 'OFFER', 'REQUEST', 'DECLINE', 'ACK', 'NAK', 'RELEASE', 'INFORM'];

export const DHCP_DISPLAY_FIELDS = protoDisplayFields({
  help: { dhcp: 'Dynamic Host Configuration Protocol (IPv4).' },
  aliases: [
    { name: 'dhcp.type', reads: ['dhcp.messageType'], help: 'DHCP message type, e.g. "DISCOVER" (dhcp.messageType).' },
    { name: 'dhcp.ip.your', reads: ['dhcp.yiaddr'], help: 'Address offered to the client (dhcp.yiaddr).' },
    { name: 'dhcp.ip.client', reads: ['dhcp.ciaddr'], help: 'Client address (dhcp.ciaddr).' },
    { name: 'dhcp.ip.relay', reads: ['dhcp.giaddr'], help: 'Relay agent address (dhcp.giaddr).' },
    { name: 'dhcp.hw.mac_addr', reads: ['dhcp.chaddr'], help: 'Client hardware address (dhcp.chaddr).' },
  ],
  values: { 'dhcp.messageType': MESSAGE_TYPES, 'dhcp.type': MESSAGE_TYPES },
});
