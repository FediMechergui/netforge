/**
 * cli/handlers P1 (ARCHITECTURE-P1 §4.3, §4.4, §4.6, §4.7, §4.10, §6): the IPv6, DHCP, DNS, web service,
 * transport, traceroute, password/line and host-shell handlers against a recording CommandCtx over real catalog
 * models, with the daemons faked through `processState` and the P1 tables.
 */
import { describe, expect, it } from 'vitest';
import type { CommandCtx, CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import type { DhcpBindingRow, DnsCacheRow, NdRow, Route6Row, SocketRow } from '../src/contracts/tables.js';
import {
  HANDLERS,
  SERVICE_FORM_ARG,
  SERVICE_FORM_DHCP_POOL,
  SERVICE_FORM_DNS_RECORD,
  SERVICE_FORM_HTTP_PAGE,
  SERVICE_POOL_NAME,
  TRACE_MODE_ARG,
  TRACE_MODE_ICMP,
} from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_LEASE_ZERO, MSG_NO_BINDINGS, MSG_RANGE_REVERSED, MSG_ROUTER_OFF_SUBNET } from '../src/cli/handlers/dhcp.js';
import { MSG_NO_HOSTS, NSLOOKUP_JOB_LABEL } from '../src/cli/handlers/dns.js';
import { MSG_EUI64_NEEDS_64, MSG_NOT_LINK_LOCAL, MSG_BAD_IPV6_ADDRESS, MSG_BAD_IPV6_NEXT_HOP } from '../src/cli/handlers/ipv6.js';
import { MSG_NO_TRACEROUTE, TRACEROUTE_JOB_LABEL } from '../src/cli/handlers/traceroute.js';
import { MSG_DHCP_NEEDS_POOL } from '../src/cli/handlers/services.js';
import { MSG_NO_SOCKETS } from '../src/cli/handlers/transport.js';
import { MSG_NO_DHCP_ADAPTER } from '../src/cli/handlers/pc.js';
import { enableSecretOf, passwordEncryptionOn } from '../src/cli/handlers/line-auth.js';
import { decodeReversibleSecret, secretsFor, verifySecret } from '../src/cli/secrets.js';
import { catalogModel, commandCtxFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';

function handler(id: string): CommandHandler {
  const h = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h;
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  return handler(id)(rec.ctx, args, negate);
}

function device(type: string, opts: CommandCtxOptions = {}): RecordingCtx {
  return commandCtxFor(catalogModel(type), opts);
}

const ROUTER = 'router.nf2911';
const PC = 'pc.nfpc';
const SERVER = 'server.nfserver';
const IF0 = 'GigabitEthernet0/0';
/** A StateView with a plain state object (what a faked daemon answers). */
const state = (process: string, s: Record<string, unknown>) => ({ process, state: s });

describe('IPv6 configuration', () => {
  it('writes the §6 interface lines and normalises nothing the parser already did', () => {
    const r = device(ROUTER, { iface: IF0 });
    expect(run(r, HANDLERS.ifIpv6Enable)).toEqual({});
    expect(run(r, HANDLERS.ifIpv6Address, { prefix: '2001:db8::1/64' })).toEqual({});
    expect(run(r, HANDLERS.ifIpv6Address, { prefix: '2001:db8:2::/64', kind: 'eui-64' })).toEqual({});
    expect(run(r, HANDLERS.ifIpv6Autoconfig)).toEqual({});
    expect(run(r, HANDLERS.ifIpv6SuppressRa)).toEqual({});
    const ifc = [['interface', IF0]];
    expect(r.configCalls).toEqual([
      { line: ['ipv6', 'enable'], negate: false, context: undefined },
      { line: ['ipv6', 'address', '2001:db8::1/64'], negate: false, context: undefined },
      { line: ['ipv6', 'address', '2001:db8:2::/64', 'eui-64'], negate: false, context: undefined },
      { line: ['ipv6', 'address', 'autoconfig'], negate: false, context: undefined },
      { line: ['ipv6', 'nd', 'suppress-ra'], negate: false, context: undefined },
    ]);
    expect(r.running.render()).toContain('ipv6 address 2001:db8::1/64');
    expect(ifc).toEqual([['interface', IF0]]);
  });

  it('refuses an address that can never sit on an interface, and the two tail forms', () => {
    const r = device(ROUTER, { iface: IF0 });
    expect(run(r, HANDLERS.ifIpv6Address, { prefix: 'ff02::1/16' }).error).toBe(MSG_BAD_IPV6_ADDRESS);
    expect(run(r, HANDLERS.ifIpv6Address, { prefix: '::/0' }).error).toBe(MSG_BAD_IPV6_ADDRESS);
    expect(run(r, HANDLERS.ifIpv6Address, { prefix: '2001:db8::/48', kind: 'eui-64' }).error).toBe(MSG_EUI64_NEEDS_64);
    expect(run(r, HANDLERS.ifIpv6Address, { prefix: '2001:db8::1/64', kind: 'link-local' }).error).toBe(MSG_NOT_LINK_LOCAL);
    expect(r.configCalls).toEqual([]);
  });

  it('ipv6 route takes an address or an exit interface, and refuses anything else', () => {
    const r = device(ROUTER, { mode: 'config' });
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '2001:db8:2::/64', nexthop: '2001:DB8:1::2' })).toEqual({});
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '::/0', nexthop: 'g0/1', via: 'fe80::1' })).toEqual({});
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '::/0', nexthop: 'nowhere' }).error).toBe(MSG_BAD_IPV6_NEXT_HOP);
    expect(r.configCalls.map((c) => c.line)).toEqual([
      ['ipv6', 'route', '2001:db8:2::/64', '2001:db8:1::2'],
      ['ipv6', 'route', '::/0', 'GigabitEthernet0/1', 'fe80::1'],
    ]);
  });
});

describe('IPv6 show output', () => {
  function withAddresses(): RecordingCtx {
    const ports = commandCtxFor(catalogModel(ROUTER)).ports;
    const p = ports.get(IF0)!;
    ports.set(IF0, {
      ...p,
      operUp: true,
      l3: {
        ipv6Enabled: true,
        ipv6: [
          { address: 'fe80::1', prefixLen: 64, scope: 'link-local', origin: 'auto-link-local', state: 'preferred' },
          { address: '2001:db8::1', prefixLen: 64, scope: 'global', origin: 'manual', state: 'preferred' },
        ],
        groups6: ['ff02::1'],
      },
    });
    return device(ROUTER, { ports });
  }

  it('show ipv6 interface brief lists only the interfaces that carry IPv6', () => {
    const r = withAddresses();
    const out = run(r, HANDLERS.showIpv6IntBrief).output ?? '';
    expect(out).toContain('GigabitEthernet0/0');
    expect(out).toContain('fe80::1, 2001:db8::1');
    expect(out).not.toContain('GigabitEthernet0/1');
    expect(run(device(ROUTER), HANDLERS.showIpv6IntBrief).output).toBe('No interface has IPv6 enabled.');
  });

  it('show ipv6 interface prints each address with its origin, state and groups', () => {
    const out = run(withAddresses(), HANDLERS.showIpv6Interface).output ?? '';
    expect(out).toContain('IPv6 enabled');
    expect(out).toContain('  fe80::1/64 (auto-link-local, preferred, link-local)');
    expect(out).toContain('  2001:db8::1/64 (manual, preferred)');
    expect(out).toContain('  Joined groups: ff02::1');
  });

  it('show ipv6 route and show ipv6 neighbors render their tables', () => {
    const r = device(ROUTER);
    expect(run(r, HANDLERS.showIpv6Route).output).toContain('The IPv6 routing table is empty.');
    r.table<Route6Row>('rib6').set({ key: '2001:db8::/64', network: '2001:db8::', prefixLen: 64, source: 'C', iface: IF0, ad: 0, metric: 0, updatedAt: 0 });
    r.table<Route6Row>('rib6').set({ key: '::/0', network: '::', prefixLen: 0, source: 'ND', nextHop: 'fe80::2', iface: IF0, ad: 2, metric: 0, isDefault: true, updatedAt: 0 });
    const routes = run(r, HANDLERS.showIpv6Route).output ?? '';
    expect(routes).toContain('C    2001:db8::/64  connected  GigabitEthernet0/0');
    expect(routes).toContain('ND*  ::/0  via fe80::2 [2/0] GigabitEthernet0/0');
    expect(run(r, HANDLERS.showIpv6Neighbors).output).toBe('The neighbour cache is empty.');
    r.table<NdRow>('nd').set({ key: `${IF0}|fe80::2`, ip: 'fe80::2', mac: '00:1f:00:00:00:02', iface: IF0, state: 'REACHABLE', isRouter: true, type: 'dynamic', updatedAt: 0 });
    const nd = run(r, HANDLERS.showIpv6Neighbors).output ?? '';
    expect(nd).toContain('fe80::2');
    expect(nd).toContain('001f.0000.0002');
    expect(nd).toContain('REACHABLE');
  });
});

describe('ping of an IPv6 target', () => {
  it('starts the icmpv6 job and blocks the session', () => {
    const r = device(ROUTER, { mode: 'user-exec', processStates: { icmpv6: state('icmpv6', {}) } });
    expect(run(r, HANDLERS.execPing6, { target: '2001:0db8::2' })).toEqual({});
    expect(r.requests).toEqual([
      { to: 'icmpv6', req: { kind: 'icmp6.ping', session: 's_1', target: '2001:db8::2', count: 5, timeoutNs: 2_000_000_000, sizeBytes: 100 } },
    ]);
    expect(r.deviceCalls).toContain('block');
  });

  it('refuses a multicast target and a device without the stack', () => {
    const r = device(ROUTER, { mode: 'user-exec', processStates: { icmpv6: state('icmpv6', {}) } });
    expect(run(r, HANDLERS.execPing6, { target: 'ff02::1' }).error).toMatch(/cannot be the target/);
    expect(run(device(ROUTER, { mode: 'user-exec' }), HANDLERS.execPing6, { target: '2001:db8::2' }).error).toMatch(/no IPv6 stack/);
  });
});

describe('DHCP', () => {
  it('writes the client and relay interface lines', () => {
    const r = device(ROUTER, { iface: IF0 });
    expect(run(r, HANDLERS.ifIpAddressDhcp)).toEqual({});
    expect(run(r, HANDLERS.ifHelperAddress, { address: '10.0.0.10' })).toEqual({});
    expect(r.configCalls.map((c) => c.line)).toEqual([['ip', 'address', 'dhcp'], ['ip', 'helper-address', '10.0.0.10']]);
  });

  it('opens the pool section and writes its lines into the session context', () => {
    const conf = device(ROUTER, { mode: 'config' });
    expect(run(conf, HANDLERS.configDhcpPool, { name: 'LAN' })).toEqual({});
    expect(conf.configCalls[0]).toEqual({ line: ['ip', 'dhcp', 'pool', 'LAN'], negate: false, context: [] });
    expect(conf.enterModeCalls).toEqual([{ mode: 'dhcp-config', opts: { context: [['ip', 'dhcp', 'pool', 'LAN']] } }]);

    const pool = device(ROUTER, { mode: 'dhcp-config', context: [['ip', 'dhcp', 'pool', 'LAN']], running: conf.running });
    expect(run(pool, HANDLERS.poolNetwork, { address: '192.168.1.0', mask: '255.255.255.0' })).toEqual({});
    expect(run(pool, HANDLERS.poolDefaultRouter, { first: '192.168.1.1' })).toEqual({});
    expect(run(pool, HANDLERS.poolDnsServer, { first: '192.168.1.10', second: '8.8.8.8' })).toEqual({});
    expect(run(pool, HANDLERS.poolDomainName, { name: 'lab.nf' })).toEqual({});
    expect(run(pool, HANDLERS.poolLease, { days: '0', hours: '12' })).toEqual({});
    const text = pool.running.render();
    expect(text).toContain('ip dhcp pool LAN');
    expect(text).toContain(' network 192.168.1.0 255.255.255.0');
    expect(text).toContain(' default-router 192.168.1.1');
    expect(text).toContain(' dns-server 192.168.1.10 8.8.8.8');
    expect(text).toContain(' lease 0 12 0');
  });

  it('explains the mistakes a learner makes in a pool', () => {
    const conf = device(ROUTER, { mode: 'config' });
    expect(run(conf, HANDLERS.configDhcpExcluded, { low: '192.168.1.9', high: '192.168.1.1' }).error).toBe(MSG_RANGE_REVERSED);
    expect(run(conf, HANDLERS.poolNetwork, { address: '192.168.1.5', mask: '255.255.255.0' }).error).toMatch(/host bits/);
    const pool = device(ROUTER, { mode: 'dhcp-config', context: [['ip', 'dhcp', 'pool', 'LAN']] });
    pool.running.set([], ['ip', 'dhcp', 'pool', 'LAN']);
    pool.running.set([['ip', 'dhcp', 'pool', 'LAN']], ['network', '192.168.1.0', '255.255.255.0']);
    expect(run(pool, HANDLERS.poolDefaultRouter, { first: '10.0.0.1' }).error).toBe(MSG_ROUTER_OFF_SUBNET);
    expect(run(pool, HANDLERS.poolLease, { days: '0', hours: '0', minutes: '0' }).error).toBe(MSG_LEASE_ZERO);
  });

  it('show ip dhcp binding and show ip dhcp pool read what the daemon produced', () => {
    const r = device(ROUTER, { mode: 'priv-exec' });
    expect(run(r, HANDLERS.showDhcpBinding).output).toBe(MSG_NO_BINDINGS);
    r.table<DhcpBindingRow>('dhcp-bindings').set({
      key: 'LAN|192.168.1.2', ip: '192.168.1.2', mac: '00:1f:00:00:00:02', pool: 'LAN', state: 'bound',
      hostname: 'PC1', expiresAt: 86_400_000_000_000, updatedAt: 0,
    });
    const bindings = run(r, HANDLERS.showDhcpBinding).output ?? '';
    expect(bindings).toContain('192.168.1.2');
    expect(bindings).toContain('001f.0000.0002');
    expect(bindings).toContain('PC1');
    r.running.set([], ['ip', 'dhcp', 'pool', 'LAN']);
    r.running.set([['ip', 'dhcp', 'pool', 'LAN']], ['network', '192.168.1.0', '255.255.255.0']);
    r.running.set([['ip', 'dhcp', 'pool', 'LAN']], ['default-router', '192.168.1.1']);
    const pools = run(r, HANDLERS.showDhcpPool).output ?? '';
    expect(pools).toContain('Pool LAN: 192.168.1.0/24');
    expect(pools).toMatch(/Leased 1, free 25\d, lease 86400 s/);
    expect(pools).toContain('Default gateway: 192.168.1.1');
    expect(run(r, HANDLERS.showDhcpPool, { name: 'OTHER' }).output).toMatch(/No pool named "OTHER"/);
  });
});

describe('DNS', () => {
  it('writes the resolver and server lines of §6', () => {
    const r = device(ROUTER, { mode: 'config' });
    run(r, HANDLERS.configNameServer, { first: '192.168.1.10', second: '8.8.4.4' });
    run(r, HANDLERS.configDomainName, { name: 'lab.nf' });
    run(r, HANDLERS.configDomainLookup, {}, true);
    run(r, HANDLERS.configIpHost, { name: 'www.lab.nf', first: '192.168.1.80' });
    run(r, HANDLERS.configDnsServer);
    run(r, HANDLERS.configDnsRecord, { name: 'mail.lab.nf', type: 'CNAME', data: 'www.lab.nf' });
    const text = r.running.render();
    expect(text).toContain('ip name-server 192.168.1.10 8.8.4.4');
    expect(text).toContain('ip domain-name lab.nf');
    expect(text).toContain('no ip domain-lookup');
    expect(text).toContain('ip host www.lab.nf 192.168.1.80');
    expect(text).toContain('ip dns server');
    // The server parses the four-value form only, so a missing TTL becomes the default.
    expect(text).toContain('ip dns record mail.lab.nf CNAME www.lab.nf 300');
  });

  it('show hosts prints the static names first, then what was resolved', () => {
    const r = device(ROUTER, { mode: 'priv-exec' });
    expect(run(r, HANDLERS.showHosts).output).toBe(MSG_NO_HOSTS);
    const cache = r.table<DnsCacheRow>('dns-cache');
    cache.set({ key: 'www.lab.nf|A', name: 'www.lab.nf', type: 'A', data: '192.168.1.80', ttl: 300, source: 'answer', expiresAt: 300_000_000_000, updatedAt: 0 });
    cache.set({ key: 'gw.lab.nf|A', name: 'gw.lab.nf', type: 'A', data: '192.168.1.1', ttl: 0, source: 'static', updatedAt: 0 });
    const out = (run(r, HANDLERS.showHosts).output ?? '').split('\n');
    expect(out[1]).toMatch(/^gw\.lab\.nf\s+A\s+192\.168\.1\.1\s+static\s+never$/);
    expect(out[2]).toMatch(/^www\.lab\.nf\s+A\s+192\.168\.1\.80\s+answer\s+00:05:00$/);
  });

  it('nslookup blocks on dns-client with a job.abort of its own', () => {
    const r = device(ROUTER, { mode: 'user-exec', processStates: { 'dns-client': state('dns-client', {}) } });
    expect(run(r, HANDLERS.execNslookup, { name: 'www.lab.nf', server: '192.168.1.10' })).toEqual({});
    expect(r.requests).toEqual([
      { to: 'dns-client', req: { kind: 'dns.lookup', session: 's_1', name: 'www.lab.nf', server: '192.168.1.10' } },
    ]);
    expect(NSLOOKUP_JOB_LABEL).toBe('nslookup');
    expect(run(device(ROUTER, { mode: 'user-exec' }), HANDLERS.execNslookup, { name: 'www.lab.nf' }).error).toMatch(/no name resolver/);
  });
});

describe('web service and sockets', () => {
  it('ip http server and ip http page write their lines', () => {
    const r = device(ROUTER, { mode: 'config' });
    run(r, HANDLERS.configHttpServer);
    run(r, HANDLERS.configHttpPage, { path: '/status', body: 'All links are up' });
    expect(r.running.render()).toContain('ip http server');
    expect(r.running.render()).toContain('ip http page /status All links are up');
    expect(run(r, HANDLERS.configHttpPage, { path: 'status', body: 'x' }).error).toMatch(/starts with a slash/);
  });

  it('the host service expansions write exactly the router lines', () => {
    const s = device(SERVER, { mode: 'user-exec' });
    // Every sub-form names itself in `fixedArgs`, exactly as the parser hands it to the handler.
    expect(run(s, HANDLERS.hostService, { service: 'http', state: 'on' }).output).toMatch(/Web service started/);
    run(s, HANDLERS.hostService, { service: 'dns', state: 'on' });
    run(s, HANDLERS.hostService, { [SERVICE_FORM_ARG]: SERVICE_FORM_HTTP_PAGE, path: '/status', body: 'All links are up' });
    run(s, HANDLERS.hostService, { [SERVICE_FORM_ARG]: SERVICE_FORM_DNS_RECORD, name: 'www.lab.nf', type: 'A', data: '192.168.1.80' });
    run(s, HANDLERS.hostService, { [SERVICE_FORM_ARG]: SERVICE_FORM_DHCP_POOL, network: '192.168.1.0', mask: '255.255.255.0', router: '192.168.1.1' });
    const text = s.running.render();
    expect(text).toContain('ip http server');
    expect(text).toContain('ip dns server');
    expect(text).toContain('ip http page /status All links are up');
    expect(text).toContain('ip dns record www.lab.nf A 192.168.1.80 300');
    expect(text).toContain(`ip dhcp pool ${SERVICE_POOL_NAME}`);
    expect(text).toContain(' network 192.168.1.0 255.255.255.0');
    expect(text).toContain(' default-router 192.168.1.1');
    expect(run(s, HANDLERS.hostService, { service: 'http', state: 'off' }).output).toMatch(/Web service stopped/);
    expect(s.running.render()).not.toContain('ip http server');
  });

  it('service dhcp on reports the running address service once a pool leases a subnet', () => {
    const s = device(SERVER, { mode: 'user-exec' });
    expect(run(s, HANDLERS.hostService, { service: 'dhcp', state: 'on' }).error).toBe(MSG_DHCP_NEEDS_POOL);
    run(s, HANDLERS.hostService, { [SERVICE_FORM_ARG]: SERVICE_FORM_DHCP_POOL, network: '10.0.0.0', mask: '255.255.255.0', router: '10.0.0.1' });
    expect(run(s, HANDLERS.hostService, { service: 'dhcp', state: 'on' }).output).toMatch(/Address service started/);
    expect(run(s, HANDLERS.hostService, { service: 'dhcp', state: 'off' }).output).toMatch(/Address service stopped/);
    // `off` deletes the pool, so `on` legitimately asks for a subnet again
    expect(run(s, HANDLERS.hostService, { service: 'dhcp', state: 'on' }).error).toBe(MSG_DHCP_NEEDS_POOL);
  });

  it('the no form of a sub-form removes its own lines, with no argument to infer it from', () => {
    const s = device(SERVER, { mode: 'user-exec' });
    run(s, HANDLERS.hostService, { [SERVICE_FORM_ARG]: SERVICE_FORM_HTTP_PAGE, path: '/a', body: '<html>A</html>' });
    run(s, HANDLERS.hostService, { [SERVICE_FORM_ARG]: SERVICE_FORM_DNS_RECORD, name: 'www.lab.nf', type: 'A', data: '10.0.0.9' });
    expect(s.running.render()).toContain('ip http page /a');
    expect(run(s, HANDLERS.hostService, { [SERVICE_FORM_ARG]: SERVICE_FORM_HTTP_PAGE }, true).error).toBeUndefined();
    expect(run(s, HANDLERS.hostService, { [SERVICE_FORM_ARG]: SERVICE_FORM_DNS_RECORD }, true).error).toBeUndefined();
    const text = s.running.render();
    expect(text).not.toContain('ip http page');
    expect(text).not.toContain('ip dns record');
  });

  it('netstat renders the sockets table', () => {
    const r = device(PC, { mode: 'user-exec' });
    expect(run(r, HANDLERS.showSockets).output).toBe(MSG_NO_SOCKETS);
    const sockets = r.table<SocketRow>('sockets');
    sockets.set({ key: 'udp|dhcp-client#Gi0', id: 'dhcp-client#Gi0', proto: 'udp', family: 4, localAddr: '0.0.0.0', localPort: 68, state: 'BOUND', owner: 'dhcp-client', iface: 'GigabitEthernet0', updatedAt: 0 });
    sockets.set({ key: 'tcp|http-client#1', id: 'http-client#1', proto: 'tcp', family: 4, localAddr: '192.168.1.2', localPort: 49152, remoteAddr: '192.168.1.80', remotePort: 80, state: 'ESTABLISHED', owner: 'http-client', updatedAt: 0 });
    const out = (run(r, HANDLERS.showSockets).output ?? '').split('\n');
    expect(out[0]).toMatch(/^Proto\s+Local address\s+Remote address\s+State\s+Owner\s+Interface$/);
    expect(out[1]).toMatch(/^tcp\s+192\.168\.1\.2:49152\s+192\.168\.1\.80:80\s+ESTABLISHED\s+http-client\s+-$/);
    expect(out[2]).toMatch(/^udp\s+0\.0\.0\.0:68\s+-\s+BOUND\s+dhcp-client\s+GigabitEthernet0$/);
  });
});

describe('path traces', () => {
  it('blocks on the traceroute daemon and starts the job in the right mode', () => {
    const r = device(PC, { mode: 'user-exec', processStates: { traceroute: state('traceroute', {}) } });
    expect(run(r, HANDLERS.execTraceroute, { target: 'www.lab.nf', [TRACE_MODE_ARG]: TRACE_MODE_ICMP })).toEqual({});
    expect(r.requests).toEqual([{ to: 'traceroute', req: { kind: 'trace.start', session: 's_1', target: 'www.lab.nf', mode: 'icmp' } }]);
    expect(r.deviceCalls).toContain('block');
    expect(TRACEROUTE_JOB_LABEL).toBe('trace');
    const udp = device(ROUTER, { mode: 'user-exec', processStates: { traceroute: state('traceroute', {}) } });
    run(udp, HANDLERS.execTraceroute, { target: '10.0.0.2' });
    expect(udp.requests[0]?.req).toMatchObject({ mode: 'udp' });
    expect(run(device(PC, { mode: 'user-exec' }), HANDLERS.execTraceroute, { target: '10.0.0.2' }).error).toBe(MSG_NO_TRACEROUTE);
  });
});

describe('passwords, banners and lines', () => {
  it('stores the enable secret hashed and never in the clear', () => {
    const r = device(ROUTER, { mode: 'config' });
    expect(run(r, HANDLERS.configEnableSecret, { secret: 'two words' })).toEqual({});
    const text = r.running.render();
    expect(text).toMatch(/enable secret nf1 [0-9a-f]{16}/);
    expect(text).not.toContain('two words');
    expect(verifySecret('d_1', enableSecretOf(r.running)!, 'two words')).toBe(true);
  });

  it('service password-encryption scrambles the passwords already stored, and later ones', () => {
    const r = device(ROUTER, { mode: 'config' });
    run(r, HANDLERS.configEnablePassword, { secret: 'letmein' });
    expect(r.running.render()).toContain('enable password letmein');
    const done = run(r, HANDLERS.configPasswordEncryption);
    expect(done.output).toMatch(/Scrambled 1 stored password/);
    expect(passwordEncryptionOn(r.running)).toBe(true);
    const stored = enableSecretOf(r.running)!;
    expect(stored).toMatch(/^nf7 [0-9a-f]+$/);
    expect(decodeReversibleSecret(stored)).toBe('letmein');
    const line = device(ROUTER, { mode: 'config-line', context: [['line', 'con', '0']], running: r.running });
    run(line, HANDLERS.linePassword, { secret: 'console pw' });
    expect(r.running.render()).toMatch(/ password nf7 [0-9a-f]+/);
    expect(r.running.render()).not.toContain('console pw');
  });

  it('username is hashed, and the line section takes login and exec-timeout', () => {
    const r = device(ROUTER, { mode: 'config' });
    run(r, HANDLERS.configUsername, { name: 'ana', secret: 'pw1' });
    expect(r.running.render()).toMatch(/username ana secret nf1 [0-9a-f]{16}/);
    expect(run(r, HANDLERS.configLine, { type: 'vty', first: '0', last: '4' })).toEqual({});
    expect(r.enterModeCalls).toEqual([{ mode: 'config-line', opts: { context: [['line', 'vty', '0', '4']] } }]);
    const line = device(ROUTER, { mode: 'config-line', context: [['line', 'vty', '0', '4']], running: r.running });
    run(line, HANDLERS.lineLogin, { method: 'local' });
    run(line, HANDLERS.lineExecTimeout, { minutes: '5', seconds: '30' });
    const text = r.running.render();
    expect(text).toContain('line vty 0 4');
    expect(text).toContain(' login local');
    expect(text).toContain(' exec-timeout 5 30');
  });

  it('a line command typed outside a line section says so', () => {
    const r = device(ROUTER, { mode: 'config' });
    expect(run(r, HANDLERS.linePassword, { secret: 'x' }).error).toMatch(/Select a line first/);
  });

  it('enable asks for the stored secret and verifies the answer in resume', () => {
    const r = device(ROUTER, { mode: 'user-exec' });
    expect(run(r, HANDLERS.execEnable)).toEqual({});
    r.running.set([], ['enable', 'secret', ...secretsFor('d_1').hash('class').split('$')]);
    const asked = run(r, HANDLERS.execEnable);
    expect(asked.ask?.request).toEqual({ kind: 'secret', prompt: 'Password: ' });
    const wrong = asked.ask!.resume(r.ctx as CommandCtx, 'guess', 1);
    expect(wrong.ask?.request).toEqual({ kind: 'secret', prompt: 'Password: ' });
    const right = wrong.ask!.resume(r.ctx as CommandCtx, 'class', 2);
    expect(right).toEqual({});
    expect(r.deviceCalls.filter((c) => c === 'setPrivilege 15')).toHaveLength(2);
  });
});

describe('host shell P1 expansions', () => {
  it('ip address dhcp and ip dns write the canonical lines with an explicit context', () => {
    const pc = device(PC, { mode: 'user-exec' });
    expect(run(pc, HANDLERS.hostIpAddressDhcp).output).toMatch(/asking a DHCP server/);
    expect(run(pc, HANDLERS.hostIpDns, { first: '192.168.1.10' }).output).toMatch(/Name server: 192\.168\.1\.10/);
    expect(pc.configCalls).toEqual([
      { line: ['ip', 'address', 'dhcp'], negate: false, context: [['interface', 'GigabitEthernet0']] },
      { line: ['ip', 'name-server', '192.168.1.10'], negate: false, context: [] },
    ]);
    expect(run(pc, HANDLERS.hostIpAddressDhcp, { adapter: 'nowhere' }).error).toMatch(/No such network adapter/);
  });

  it('the IPv6 expansions enable IPv6 before they write the address', () => {
    const pc = device(PC, { mode: 'user-exec' });
    expect(run(pc, HANDLERS.hostIpv6Address, { prefix: '2001:db8::5/64' }).output).toContain('2001:db8::5/64');
    run(pc, HANDLERS.hostIpv6Autoconfig);
    expect(pc.configCalls.map((c) => c.line)).toEqual([
      ['ipv6', 'enable'], ['ipv6', 'address', '2001:db8::5/64'], ['ipv6', 'enable'], ['ipv6', 'address', 'autoconfig'],
    ]);
    expect(pc.configCalls.every((c) => c.context?.[0]?.[0] === 'interface')).toBe(true);
  });

  it('ipv6config reports the addresses, the router and the neighbours', () => {
    const ports = commandCtxFor(catalogModel(PC)).ports;
    const p = ports.get('GigabitEthernet0')!;
    ports.set('GigabitEthernet0', {
      ...p, operUp: true,
      l3: { ipv6Enabled: true, ipv6: [{ address: '2001:db8::5', prefixLen: 64, scope: 'global', origin: 'slaac', state: 'preferred' }] },
    });
    const pc = device(PC, { mode: 'user-exec', ports });
    pc.table<Route6Row>('rib6').set({ key: '::/0', network: '::', prefixLen: 0, source: 'ND', nextHop: 'fe80::1', iface: 'GigabitEthernet0', ad: 2, metric: 0, isDefault: true, updatedAt: 0 });
    pc.table<NdRow>('nd').set({ key: 'GigabitEthernet0|fe80::1', ip: 'fe80::1', mac: '00:1f:00:00:00:01', iface: 'GigabitEthernet0', state: 'REACHABLE', isRouter: true, type: 'dynamic', updatedAt: 0 });
    const out = run(pc, HANDLERS.hostIpv6config).output ?? '';
    expect(out).toContain('2001:db8::5/64 (slaac, preferred)');
    expect(out).toContain('Default router ......: fe80::1');
    expect(out).toContain('Neighbours:');
    expect(out).toContain('001f.0000.0001');
  });
});

describe('ipconfig', () => {
  const lease = {
    address: '192.168.1.2', prefixLen: 24, router: '192.168.1.1', server: '192.168.1.1',
    dns: ['192.168.1.10'], domain: 'lab.nf', leaseS: 86_400, boundAt: 0,
  };

  function bound(): RecordingCtx {
    const ports = commandCtxFor(catalogModel(PC)).ports;
    const p = ports.get('GigabitEthernet0')!;
    ports.set('GigabitEthernet0', { ...p, operUp: true, l3: { ipv4: { address: '192.168.1.2', prefixLen: 24, origin: 'dhcp' } } });
    return device(PC, {
      mode: 'user-exec', ports,
      processStates: { 'dhcp-client': state('dhcp-client', { clients: [{ iface: 'GigabitEthernet0', state: 'BOUND', lease }] }) },
    });
  }

  it('/all shows where the address came from and the live lease', () => {
    const pc = bound();
    const plain = run(pc, HANDLERS.pcIpconfig).output ?? '';
    expect(plain).toContain('IPv4 address ........: 192.168.1.2');
    expect(plain).not.toContain('DHCP server');
    const all = run(pc, HANDLERS.pcIpconfig, { option: '/all' }).output ?? '';
    expect(all).toContain('Address from DHCP ...: yes (BOUND)');
    expect(all).toContain('IPv4 address ........: 192.168.1.2 (dhcp)');
    expect(all).toContain('Default gateway .....: 192.168.1.1');
    expect(all).toContain('DHCP server .........: 192.168.1.1');
    expect(all).toContain('Lease length ........: 86400 s');
    expect(all).toContain('Domain name .........: lab.nf');
    expect(all).toContain('Name servers ........: 192.168.1.10');
  });

  it('/renew and /release ask dhcp-client and block the session; without a lease they say so', () => {
    const pc = bound();
    expect(run(pc, HANDLERS.pcIpconfig, { option: '/renew' })).toEqual({});
    expect(pc.requests).toEqual([{ to: 'dhcp-client', req: { kind: 'dhcp.client', iface: 'GigabitEthernet0', op: 'renew', session: 's_1' } }]);
    expect(pc.deviceCalls).toContain('block');
    const release = bound();
    run(release, HANDLERS.pcIpconfig, { option: '/release' });
    expect(release.requests[0]?.req).toMatchObject({ op: 'release' });
    const manual = device(PC, { mode: 'user-exec' });
    expect(run(manual, HANDLERS.pcIpconfig, { option: '/renew' }).error).toBe(MSG_NO_DHCP_ADAPTER);
    expect(manual.requests).toEqual([]);
  });
});
