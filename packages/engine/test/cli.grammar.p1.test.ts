/**
 * cli/grammar P1 fragments on real catalog models (ARCHITECTURE-P1 §4.3, §4.4, §4.6, §4.7, §4.10, §6, §8.2 W5):
 * IPv6, DHCP, DNS, web services, the socket listing, path traces, passwords and lines, and the host shell
 * expansions — each scoped by grammar, effective capabilities and the selected port, never by device kind.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CliMode } from '../src/contracts/cli.js';
import { GRAMMAR, HANDLERS, TRACE_MODE_ARG, TRACE_MODE_ICMP, TRACE_MODE_UDP } from '../src/cli/grammar/index.js';
import { help, matchCommand, type MatchContext } from '../src/cli/parser.js';
import { catalogModel, matchContextFor, type MatchContextOptions } from './cli.p05.fixture.js';

function on(type: string, mode: CliMode, opts: MatchContextOptions = {}): MatchContext {
  return matchContextFor(catalogModel(type), mode, opts);
}

function ok(c: MatchContext, line: string) {
  const r = matchCommand(GRAMMAR, c, line);
  if (!r.ok) throw new Error(`expected "${line}" to match, got ${r.kind}: ${r.error.message}`);
  return r;
}

function fail(c: MatchContext, line: string) {
  const r = matchCommand(GRAMMAR, c, line);
  if (r.ok) throw new Error(`expected "${line}" to fail, matched ${r.spec.handler}`);
  return r;
}

const tokens = (c: MatchContext, partial: string): string[] => help(GRAMMAR, c, partial).items.map((i) => i.token);

const ROUTER = 'router.nf2911';
const SWITCH = 'switch.nfc2960';
const PC = 'pc.nfpc';
const SERVER = 'server.nfserver';

describe('IPv6', () => {
  const rIf = (): MatchContext => on(ROUTER, 'config-if', { iface: 'GigabitEthernet0/0' });

  it('takes the interface lines of §6 and normalises the address', () => {
    const c = rIf();
    expect(ok(c, 'ipv6 enable').spec.handler).toBe(HANDLERS.ifIpv6Enable);
    expect(ok(c, 'ipv6 address 2001:0DB8:0000::1/64').args.prefix).toBe('2001:db8::1/64');
    expect(ok(c, 'ipv6 address 2001:db8::/64 eui-64').args).toEqual({ prefix: '2001:db8::/64', kind: 'eui-64' });
    expect(ok(c, 'ipv6 address fe80::1/64 link-local').args.kind).toBe('link-local');
    expect(ok(c, 'ipv6 address autoconfig').spec.handler).toBe(HANDLERS.ifIpv6Autoconfig);
    expect(ok(c, 'ipv6 nd suppress-ra').spec.handler).toBe(HANDLERS.ifIpv6SuppressRa);
    expect(ok(c, 'no ipv6 address').negated).toBe(true);
    expect(fail(c, 'ipv6 address 2001:db8::1').kind).toBe('invalid-arg');
  });

  it('takes the global lines and the show commands on a device that routes', () => {
    const conf = on(ROUTER, 'config');
    expect(ok(conf, 'ipv6 unicast-routing').spec.handler).toBe(HANDLERS.configIpv6UnicastRouting);
    expect(ok(conf, 'ipv6 route 2001:db8:2::/64 2001:db8:1::2').args).toEqual({ prefix: '2001:db8:2::/64', nexthop: '2001:db8:1::2' });
    expect(ok(conf, 'ipv6 route ::/0 GigabitEthernet0/1 fe80::1').args.via).toBe('fe80::1');
    const exec = on(ROUTER, 'priv-exec');
    expect(ok(exec, 'show ipv6 interface brief').spec.handler).toBe(HANDLERS.showIpv6IntBrief);
    expect(ok(exec, 'show ipv6 interface').spec.handler).toBe(HANDLERS.showIpv6Interface);
    expect(ok(exec, 'show ipv6 route').spec.handler).toBe(HANDLERS.showIpv6Route);
    expect(ok(exec, 'show ipv6 neighbors').spec.handler).toBe(HANDLERS.showIpv6Neighbors);
  });

  it('is absent where no IPv6 stack runs, and refuses a switched port by role', () => {
    // The `switching` capability brings no ipv6 daemon, so the whole surface is out of scope there.
    expect(fail(on(SWITCH, 'config'), 'ipv6 unicast-routing').kind).toBe('unrecognized');
    expect(fail(on(SWITCH, 'config-if', { iface: 'Vlan1' }), 'ipv6 enable').kind).toBe('unrecognized');
    const switched = on('mlswitch.nfc3650-24', 'config-if', { iface: 'GigabitEthernet1/0/24' });
    expect(fail(switched, 'ipv6 enable')).toMatchObject({ kind: 'port-unsupported', error: { message: CLI_MESSAGES.switchedPort } });
  });

  it('ping picks the IPv4 or the IPv6 job from the address, and hosts have ping -6', () => {
    const exec = on(ROUTER, 'user-exec');
    expect(ok(exec, 'ping 10.0.0.2').spec.handler).toBe(HANDLERS.execPing);
    expect(ok(exec, 'ping 2001:db8::2').spec.handler).toBe(HANDLERS.execPing6);
    const pc = on(PC, 'user-exec');
    expect(ok(pc, 'ping 2001:db8::2').spec.handler).toBe(HANDLERS.execPing6);
    expect(ok(pc, 'ping -6 2001:db8::2').args.target).toBe('2001:db8::2');
  });
});

describe('DHCP', () => {
  it('takes the client line on an interface that holds addresses', () => {
    const c = on(ROUTER, 'config-if', { iface: 'GigabitEthernet0/0' });
    expect(ok(c, 'ip address dhcp').spec.handler).toBe(HANDLERS.ifIpAddressDhcp);
    expect(ok(c, 'no ip address dhcp').negated).toBe(true);
    expect(ok(c, 'ip helper-address 10.0.0.10').args.address).toBe('10.0.0.10');
  });

  it('opens the pool section and takes its lines', () => {
    const conf = on(ROUTER, 'config');
    const pool = ok(conf, 'ip dhcp pool LAN');
    expect(pool.spec.entersMode).toBe('dhcp-config');
    expect(pool.args.name).toBe('LAN');
    expect(ok(conf, 'ip dhcp excluded-address 192.168.1.1 192.168.1.9').args).toEqual({ low: '192.168.1.1', high: '192.168.1.9' });
    expect(ok(conf, 'ip dhcp excluded-address 192.168.1.1').args.low).toBe('192.168.1.1');
    const inPool = on(ROUTER, 'dhcp-config');
    expect(ok(inPool, 'network 192.168.1.0 255.255.255.0').args).toEqual({ address: '192.168.1.0', mask: '255.255.255.0' });
    expect(ok(inPool, 'default-router 192.168.1.1').spec.handler).toBe(HANDLERS.poolDefaultRouter);
    expect(ok(inPool, 'dns-server 192.168.1.10 8.8.8.8').args.second).toBe('8.8.8.8');
    expect(ok(inPool, 'domain-name lab.nf').args.name).toBe('lab.nf');
    expect(ok(inPool, 'lease 0 12').args).toEqual({ days: '0', hours: '12' });
    expect(tokens(inPool, '')).toEqual(['default-router', 'dns-server', 'do', 'domain-name', 'end', 'exit', 'lease', 'network', 'no']);
  });

  it('the server surface follows the dhcp-server daemon, not the device kind', () => {
    // A server runs the host shell, so §6 gives it the `service dhcp …` expansion instead of the config-mode lines.
    expect(ok(on(SERVER, 'user-exec'), 'service dhcp pool 192.168.1.0 255.255.255.0 192.168.1.1').args.router).toBe('192.168.1.1');
    expect(ok(on(SERVER, 'user-exec'), 'service dhcp off').args).toEqual({ service: 'dhcp', state: 'off' });
    expect(fail(on(SWITCH, 'config'), 'ip dhcp pool LAN').kind).toBe('unrecognized');
    expect(fail(on(PC, 'user-exec'), 'service dhcp off').kind).toBe('unrecognized');
    expect(ok(on(ROUTER, 'priv-exec'), 'show ip dhcp binding').spec.handler).toBe(HANDLERS.showDhcpBinding);
    expect(ok(on(SERVER, 'user-exec'), 'show ip dhcp pool SERVICE').args.name).toBe('SERVICE');
  });
});

describe('DNS', () => {
  it('takes the resolver lines and the server lines of §6', () => {
    const conf = on(ROUTER, 'config');
    expect(ok(conf, 'ip name-server 192.168.1.10 8.8.4.4').args).toEqual({ first: '192.168.1.10', second: '8.8.4.4' });
    expect(ok(conf, 'ip domain-name lab.nf').args.name).toBe('lab.nf');
    expect(ok(conf, 'no ip domain-lookup').negated).toBe(true);
    expect(ok(conf, 'ip host www.lab.nf 192.168.1.80').args).toEqual({ name: 'www.lab.nf', first: '192.168.1.80' });
    expect(ok(conf, 'ip dns server').spec.handler).toBe(HANDLERS.configDnsServer);
    expect(ok(conf, 'ip dns record www.lab.nf A 192.168.1.80 300').args.ttl).toBe('300');
    expect(ok(conf, 'ip dns record mail.lab.nf CNAME www.lab.nf').args.data).toBe('www.lab.nf');
  });

  it('nslookup and show hosts are in both shells; the server lines need the name server', () => {
    expect(ok(on(ROUTER, 'user-exec'), 'nslookup www.lab.nf').spec.job).toBe(true);
    expect(ok(on(PC, 'user-exec'), 'nslookup www.lab.nf 192.168.1.10').args.server).toBe('192.168.1.10');
    expect(ok(on(PC, 'user-exec'), 'show hosts').spec.handler).toBe(HANDLERS.showHosts);
    expect(fail(on(SWITCH, 'config'), 'ip dns server').kind).toBe('unrecognized');
    expect(fail(on(SWITCH, 'user-exec'), 'nslookup www.lab.nf').kind).toBe('unrecognized');
  });
});

describe('web service and sockets', () => {
  it('ip http server and ip http page exist where the web server runs', () => {
    const conf = on(ROUTER, 'config');
    expect(ok(conf, 'ip http server').spec.handler).toBe(HANDLERS.configHttpServer);
    expect(ok(conf, 'ip http page /status All links are up').args).toEqual({ path: '/status', body: 'All links are up' });
    // A query or fragment is refused: http-server keys its pages by the path alone, so `/b?x=1` would silently
    // shadow `/b` instead of being served.
    expect(fail(conf, 'ip http page /b?x=1 <html>q</html>').kind).toBe('invalid-arg');
    expect(fail(conf, 'ip http page /b#top <html>q</html>').kind).toBe('invalid-arg');
    expect(fail(on(SWITCH, 'config'), 'ip http server').kind).toBe('unrecognized');
  });

  it('a server writes the same lines through the host shell service expansions', () => {
    const srv = on(SERVER, 'user-exec');
    expect(ok(srv, 'service http on').args).toEqual({ service: 'http', state: 'on' });
    expect(ok(srv, 'service dns on').args.service).toBe('dns');
    // Each sub-form names itself, so the one handler never has to guess it from whichever optional arg is present.
    expect(ok(srv, 'service http page /status All links are up').args).toEqual({ form: 'http-page', path: '/status', body: 'All links are up' });
    expect(ok(srv, 'service dns record www.lab.nf A 192.168.1.80').args.type).toBe('A');
    expect(ok(srv, 'service dns record www.lab.nf A 192.168.1.80').args.form).toBe('dns-record');
    expect(ok(srv, 'service dhcp pool 10.0.0.0 255.255.255.0').args.form).toBe('dhcp-pool');
    // the no forms take no args at all, and still reach their own sub-form
    expect(ok(srv, 'no service http page').args).toEqual({ form: 'http-page' });
    expect(ok(srv, 'no service dns record').args).toEqual({ form: 'dns-record' });
    expect(fail(on(PC, 'user-exec'), 'service http on').kind).toBe('unrecognized');
  });

  it('the socket listing is netstat at a host prompt and show ip sockets at a network OS prompt', () => {
    expect(ok(on(PC, 'user-exec'), 'netstat').spec.handler).toBe(HANDLERS.showSockets);
    expect(ok(on(ROUTER, 'priv-exec'), 'show ip sockets').spec.handler).toBe(HANDLERS.showSockets);
    expect(fail(on(ROUTER, 'priv-exec'), 'netstat').kind).toBe('unrecognized');
    // §10.2 accept.p1.host-shell types `netstat -an`: the option letters parse and the whole table is printed
    for (const line of ['netstat -a', 'netstat -n', 'netstat -an', 'netstat -na']) {
      expect(ok(on(PC, 'user-exec'), line).spec.handler).toBe(HANDLERS.showSockets);
    }
    expect(ok(on(PC, 'user-exec'), 'netstat -an').args.options).toBe('-an');
    expect(ok(on(PC, 'user-exec'), 'netstat -an | include tcp').filter).toEqual({ kind: 'include', pattern: 'tcp' });
    expect(fail(on(PC, 'user-exec'), 'netstat -x').kind).toBe('invalid-arg');
  });
});

describe('path traces', () => {
  it('a router traces with UDP probes and a host with echo probes', () => {
    const r = ok(on(ROUTER, 'user-exec'), 'traceroute www.lab.nf');
    expect(r.spec.handler).toBe(HANDLERS.execTraceroute);
    expect(r.args[TRACE_MODE_ARG]).toBe(TRACE_MODE_UDP);
    expect(r.args.target).toBe('www.lab.nf');
    expect(r.spec.job).toBe(true);
    // §9.2: "PC cannot traceroute" becomes hosts get `tracert`.
    const pc = ok(on(PC, 'user-exec'), 'tracert 10.0.0.2');
    expect(pc.spec.handler).toBe(HANDLERS.execTraceroute);
    expect(pc.args[TRACE_MODE_ARG]).toBe(TRACE_MODE_ICMP);
    expect(fail(on(PC, 'user-exec'), 'traceroute 10.0.0.2').kind).toBe('unrecognized');
    expect(fail(on(ROUTER, 'user-exec'), 'tracert 10.0.0.2').kind).toBe('unrecognized');
  });
});

describe('passwords, banners and lines', () => {
  const conf = on(ROUTER, 'config');

  it('takes the global password and banner lines, reading the secret to end of line', () => {
    expect(ok(conf, 'enable secret two words').args.secret).toBe('two words');
    expect(ok(conf, 'enable password letmein').spec.handler).toBe(HANDLERS.configEnablePassword);
    expect(ok(conf, 'service password-encryption').spec.handler).toBe(HANDLERS.configPasswordEncryption);
    expect(ok(conf, 'username ana secret pw1').args).toEqual({ name: 'ana', secret: 'pw1' });
    expect(ok(conf, 'banner login Authorised staff only').args).toMatchObject({ type: 'login', text: 'Authorised staff only' });
    expect(ok(conf, 'banner exec Session started').args.type).toBe('exec');
    expect(ok(conf, 'banner motd Lab kit').args.type).toBe('motd');
  });

  it('reports the columns of a typed secret so the runtime can mask it in history', () => {
    const r = ok(conf, 'enable secret topsecret');
    expect(r.secretSpans).toEqual([{ column: 14, end: 23 }]);
  });

  it('opens the console and vty line sections and takes their lines', () => {
    expect(ok(conf, 'line con 0').args).toEqual({ type: 'con', first: '0' });
    const vty = ok(conf, 'line vty 0 4');
    expect(vty.args).toEqual({ type: 'vty', first: '0', last: '4' });
    expect(vty.spec.entersMode).toBe('config-line');
    const inLine = on(ROUTER, 'config-line');
    expect(ok(inLine, 'password letmein').spec.handler).toBe(HANDLERS.linePassword);
    expect(ok(inLine, 'login').spec.handler).toBe(HANDLERS.lineLogin);
    expect(ok(inLine, 'login local').args.method).toBe('local');
    expect(ok(inLine, 'exec-timeout 5 30').args).toEqual({ minutes: '5', seconds: '30' });
    expect(tokens(inLine, '')).toEqual(['do', 'end', 'exec-timeout', 'exit', 'login', 'no', 'password']);
  });

  it('enable is interactive, so a settings panel refuses it', () => {
    expect(ok(on(ROUTER, 'user-exec'), 'enable').spec.interactive).toBe(true);
  });
});

describe('host shell expansions', () => {
  const pc = on(PC, 'user-exec');

  it('ipconfig takes the three options and keeps its bare form', () => {
    expect(ok(pc, 'ipconfig').args).toEqual({});
    expect(ok(pc, 'ipconfig /all').args.option).toBe('/all');
    expect(ok(pc, 'ipconfig /renew').args.option).toBe('/renew');
    expect(ok(pc, 'ipconfig /release').args.option).toBe('/release');
    expect(fail(pc, 'ipconfig /bogus').kind).toBe('invalid-arg');
    expect(tokens(pc, 'ipconfig ')).toEqual(['/all', '/release', '/renew']);
  });

  it('takes the address, name server and IPv6 expansions', () => {
    expect(ok(pc, 'ip address dhcp').spec.handler).toBe(HANDLERS.hostIpAddressDhcp);
    expect(ok(pc, 'ip address dhcp GigabitEthernet0').args.adapter).toBe('GigabitEthernet0');
    expect(ok(pc, 'ip address 10.0.0.2 255.255.255.0 10.0.0.1').spec.handler).toBe(HANDLERS.pcIpAddress);
    expect(ok(pc, 'ip dns 192.168.1.10').args.first).toBe('192.168.1.10');
    expect(ok(pc, 'ipv6 address 2001:db8::5/64').args.prefix).toBe('2001:db8::5/64');
    expect(ok(pc, 'ipv6 address GigabitEthernet0 2001:db8::5/64').args).toEqual({ adapter: 'GigabitEthernet0', prefix: '2001:db8::5/64' });
    expect(ok(pc, 'ipv6 autoconfig').spec.handler).toBe(HANDLERS.hostIpv6Autoconfig);
    expect(ok(pc, 'ipv6config').spec.handler).toBe(HANDLERS.hostIpv6config);
  });

  it('none of the host forms leaks into the network OS grammar', () => {
    const conf = on(ROUTER, 'config');
    for (const line of ['ipconfig', 'ipv6config', 'ip dns 1.1.1.1', 'ipv6 autoconfig']) {
      expect(fail(conf, line).ok, line).toBe(false);
    }
  });
});
