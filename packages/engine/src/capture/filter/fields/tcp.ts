/** capture/filter/fields/tcp.ts — TCP display fields: ports, the window, the flag letters as booleans, the payload length. */
import type { LayerView } from '../../../contracts/pdu.js';
import { derived, derivedField, protoDisplayFields, type DerivedField, type DisplayScalar } from './kit.js';

/** TCP flag letter as a boolean for every tcp layer. */
function tcpFlag(letter: string): (layer: LayerView) => DisplayScalar | undefined {
  return (layer) => {
    const flags = layer.fields['flags'];
    if (typeof flags !== 'string') return undefined;
    return flags.includes(letter);
  };
}

const FLAGS: readonly [string, string, string][] = [
  ['fin', 'F', 'FIN: the sender has finished sending.'],
  ['syn', 'S', 'SYN: synchronise sequence numbers (connection open).'],
  ['reset', 'R', 'RST: reset the connection.'],
  ['rst', 'R', 'RST: reset the connection (same as tcp.flags.reset).'],
  ['push', 'P', 'PSH: push buffered data to the application.'],
  ['ack', 'A', 'ACK: the acknowledgement number is valid.'],
  ['urg', 'U', 'URG: the urgent pointer is valid.'],
  ['ece', 'E', 'ECE: ECN echo.'],
  ['cwr', 'C', 'CWR: congestion window reduced.'],
];

const DERIVED: DerivedField[] = FLAGS.map(([name, letter, help]) =>
  derivedField(`tcp.flags.${name}`, ['tcp.flags'], 'bool', `TCP flag ${help} Compare with 1 or 0.`, derived('tcp', tcpFlag(letter))),
);
DERIVED.push(
  derivedField('tcp.len', ['tcp'], 'number', 'TCP segment payload length, in bytes.', derived('tcp', (layer) => Math.max(0, layer.length - layer.headerLength - (layer.trailerLength ?? 0)))),
);

export const TCP_DISPLAY_FIELDS = protoDisplayFields({
  help: { tcp: 'Transmission Control Protocol.' },
  aliases: [
    { name: 'tcp.port', reads: ['tcp.srcPort', 'tcp.dstPort'], help: 'Either TCP port.' },
    { name: 'tcp.srcport', reads: ['tcp.srcPort'], help: 'TCP source port (tcp.srcPort).' },
    { name: 'tcp.dstport', reads: ['tcp.dstPort'], help: 'TCP destination port (tcp.dstPort).' },
    { name: 'tcp.window_size', reads: ['tcp.window'], help: 'TCP receive window (tcp.window).' },
  ],
  derived: DERIVED,
});
