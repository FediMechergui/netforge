/** capture/filter/fields/dns.ts — DNS display fields: flags, the question and the answer records. */
import type { LayerView } from '../../../contracts/pdu.js';
import { derived, derivedField, protoDisplayFields, textField, type DisplayScalar } from './kit.js';

/** Entries of a DNS record list ('name TYPE …' joined by ';'). */
function dnsEntries(layer: LayerView, field: string): string[][] {
  const text = textField(layer, field);
  if (text === undefined || text.length === 0) return [];
  const out: string[][] = [];
  for (const entry of text.split(';')) {
    const parts = entry.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length > 0) out.push(parts);
  }
  return out;
}

function dnsAnswerData(type: string): (layer: LayerView) => DisplayScalar[] {
  return (layer) => {
    const out: DisplayScalar[] = [];
    for (const field of ['answers', 'authorities', 'additionals']) {
      for (const parts of dnsEntries(layer, field)) {
        if ((parts[1] ?? '').toUpperCase() !== type) continue;
        const data = parts.slice(3).join(' ');
        if (data.length > 0) out.push(data);
      }
    }
    return out;
  };
}

const RECORDS = ['dns.answers', 'dns.authorities', 'dns.additionals'];

export const DNS_DISPLAY_FIELDS = protoDisplayFields({
  help: { dns: 'Domain Name System.' },
  aliases: [
    { name: 'dns.flags.response', reads: ['dns.qr'], help: 'The DNS message is a response (dns.qr).' },
    { name: 'dns.flags.rcode', reads: ['dns.rcode'], help: 'DNS response code: 0 no error, 2 server failure, 3 no such name (dns.rcode).' },
  ],
  derived: [
    derivedField('dns.qry.name', ['dns.questions'], 'string', 'Name asked for in a DNS question, e.g. "www.lab.nf".', derived('dns', (layer) => dnsEntries(layer, 'questions').map((p) => p[0] as string))),
    derivedField('dns.qry.type', ['dns.questions'], 'string', 'Record type asked for in a DNS question, e.g. "A" or "AAAA".', derived('dns', (layer) => dnsEntries(layer, 'questions').filter((p) => p.length > 1).map((p) => (p[1] as string).toUpperCase()))),
    derivedField('dns.resp.name', ['dns.answers'], 'string', 'Owner name of a DNS answer record.', derived('dns', (layer) => dnsEntries(layer, 'answers').map((p) => p[0] as string))),
    derivedField('dns.a', RECORDS, 'ipv4', 'IPv4 address carried by a DNS A record.', derived('dns', dnsAnswerData('A'))),
    derivedField('dns.aaaa', RECORDS, 'ipv6', 'IPv6 address carried by a DNS AAAA record.', derived('dns', dnsAnswerData('AAAA'))),
    derivedField('dns.cname', RECORDS, 'string', 'Canonical name carried by a DNS CNAME record.', derived('dns', dnsAnswerData('CNAME'))),
  ],
  values: { 'dns.qry.type': ['A', 'AAAA', 'CNAME', 'MX', 'PTR', 'NS', 'SOA'] },
});
