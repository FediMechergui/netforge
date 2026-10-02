/** capture/filter/fields/http.ts — HTTP display fields: request and response parts and a few headers. */
import type { LayerView } from '../../../contracts/pdu.js';
import { derived, derivedField, protoDisplayFields, textField, type DisplayScalar } from './kit.js';

function httpKind(kind: 'request' | 'response', field?: string): (layer: LayerView) => DisplayScalar | undefined {
  return (layer) => {
    if (layer.fields['kind'] !== kind) return undefined;
    if (field === undefined) return true;
    const v = layer.fields[field];
    return v === undefined || v === null ? undefined : v;
  };
}

function httpHeader(name: string): (layer: LayerView) => DisplayScalar[] {
  const lower = name.toLowerCase();
  return (layer) => {
    const headers = textField(layer, 'headers');
    if (headers === undefined) return [];
    const out: DisplayScalar[] = [];
    for (const line of headers.split('\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      if (line.slice(0, colon).trim().toLowerCase() === lower) out.push(line.slice(colon + 1).trim());
    }
    return out;
  };
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'];

export const HTTP_DISPLAY_FIELDS = protoDisplayFields({
  help: { http: 'Hypertext Transfer Protocol.' },
  aliases: [
    { name: 'http.request.uri', reads: ['http.target'], help: 'Request target, e.g. "/index.html" (http.target).' },
    { name: 'http.response.phrase', reads: ['http.reason'], help: 'Response reason phrase (http.reason).' },
    { name: 'http.file_data', reads: ['http.body'], help: 'HTTP message body (http.body).' },
  ],
  derived: [
    derivedField('http.request', ['http.kind'], 'bool', 'The HTTP message is a request.', derived('http', httpKind('request'))),
    derivedField('http.response', ['http.kind'], 'bool', 'The HTTP message is a response.', derived('http', httpKind('response'))),
    derivedField('http.request.method', ['http.method'], 'string', 'Request method, e.g. "GET".', derived('http', httpKind('request', 'method'))),
    derivedField('http.request.version', ['http.version'], 'string', 'Version of an HTTP request.', derived('http', httpKind('request', 'version'))),
    derivedField('http.response.code', ['http.status'], 'number', 'Response status code, e.g. 200 or 404.', derived('http', httpKind('response', 'status'))),
    derivedField('http.response.version', ['http.version'], 'string', 'Version of an HTTP response.', derived('http', httpKind('response', 'version'))),
    derivedField('http.host', ['http.headers'], 'string', 'Value of the Host header.', derived('http', httpHeader('host'))),
    derivedField('http.content_type', ['http.headers'], 'string', 'Value of the Content-Type header.', derived('http', httpHeader('content-type'))),
    derivedField('http.server', ['http.headers'], 'string', 'Value of the Server header.', derived('http', httpHeader('server'))),
    derivedField('http.user_agent', ['http.headers'], 'string', 'Value of the User-Agent header.', derived('http', httpHeader('user-agent'))),
  ],
  values: { 'http.method': METHODS, 'http.request.method': METHODS, 'http.kind': ['request', 'response'] },
});
