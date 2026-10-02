/** capture/filter/fields/lldp.ts — LLDP display fields (IEEE 802.1AB; ARCHITECTURE-P3 D18; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const LLDP_DISPLAY_FIELDS = protoDisplayFields({
  help: { lldp: 'Link Layer Discovery Protocol (IEEE 802.1AB, ethertype 0x88cc): a neighbour announces its chassis, port, name and capabilities.' },
  aliases: [
    { name: 'lldp.chassis.id', reads: ['lldp.chassisId'], help: 'Chassis id of the announcing device, its base MAC address (lldp.chassisId).' },
    { name: 'lldp.port.id', reads: ['lldp.portId'], help: 'Port id, the announcing interface name (lldp.portId).' },
    { name: 'lldp.port.desc', reads: ['lldp.portDescription'], help: 'Description of the announcing port (lldp.portDescription).' },
    { name: 'lldp.time_to_live', reads: ['lldp.ttl'], help: 'Seconds a neighbour keeps this information (lldp.ttl).' },
    { name: 'lldp.tlv.system.name', reads: ['lldp.systemName'], help: 'Name of the announcing device (lldp.systemName).' },
    { name: 'lldp.tlv.system.desc', reads: ['lldp.systemDescription'], help: 'Description of the announcing device (lldp.systemDescription).' },
    { name: 'lldp.tlv.system.cap', reads: ['lldp.capabilities'], help: 'System capabilities bit map (lldp.capabilities).' },
    { name: 'lldp.tlv.enable.system.cap', reads: ['lldp.enabledCapabilities'], help: 'Enabled capabilities bit map (lldp.enabledCapabilities).' },
    { name: 'lldp.mgn.addr.ip4', reads: ['lldp.mgmtAddress'], help: 'IPv4 management address (lldp.mgmtAddress).' },
  ],
});
