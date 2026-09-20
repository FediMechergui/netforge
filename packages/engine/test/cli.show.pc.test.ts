/**
 * cli/handlers/pc.ts — the PC host shell: `ip address` expansion into config lines,
 * `ipconfig`, `arp -a`, and address validation.
 */
import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/cli/grammar.js';
import { pcHandlers, validateHostAddress } from '../src/cli/handlers/pc.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { fakeCtx, fakePort, MIN } from './cli.show.fixture.js';

const IF_CTX = [['interface', 'GigabitEthernet0']];
const pcPort = (extra: Partial<Parameters<typeof fakePort>[0]> = {}) =>
  fakePort({ mac: '00:1f:00:00:00:01', adminUp: true, operUp: true, ...extra, id: 'GigabitEthernet0' });

const run = (id: string, f: ReturnType<typeof fakeCtx>, args: Record<string, string> = {}, negate = false) => {
  const h = pcHandlers[id];
  if (!h) throw new Error(`no handler ${id}`);
  return h(f.ctx, args, negate);
};

describe('pc handlers registry', () => {
  it('covers every pc.* id in HANDLERS', () => {
    const ids = Object.values(HANDLERS).filter((id) => id.startsWith('pc.'));
    expect(Object.keys(pcHandlers).sort()).toEqual([...ids].sort());
  });
});

describe('ip address A M [GW]', () => {
  it('writes the interface ip address line and the global default-gateway line', () => {
    const f = fakeCtx({ ports: [pcPort()] });
    const r = run(HANDLERS.pcIpAddress, f, { address: '10.0.0.1', mask: '255.255.255.0', gateway: '10.0.0.254' });
    expect(r.error).toBeUndefined();
    expect(f.configCalls).toEqual([
      { line: ['ip', 'address', '10.0.0.1', '255.255.255.0'], negate: false, context: IF_CTX },
      { line: ['ip', 'default-gateway', '10.0.0.254'], negate: false, context: [] },
    ]);
    expect(r.output).toBe('GigabitEthernet0: IPv4 address 10.0.0.1/24, default gateway 10.0.0.254.');
  });

  it('without a gateway writes only the interface line', () => {
    const f = fakeCtx({ ports: [pcPort()] });
    const r = run(HANDLERS.pcIpAddress, f, { address: '192.168.5.7', mask: '255.255.255.128' });
    expect(f.configCalls).toEqual([
      { line: ['ip', 'address', '192.168.5.7', '255.255.255.128'], negate: false, context: IF_CTX },
    ]);
    expect(r.output).toBe('GigabitEthernet0: IPv4 address 192.168.5.7/25.');
  });

  it('falls back to GigabitEthernet0 when the port map is empty', () => {
    const f = fakeCtx();
    run(HANDLERS.pcIpAddress, f, { address: '10.0.0.1', mask: '255.255.255.0' });
    expect(f.configCalls[0]?.context).toEqual(IF_CTX);
  });

  it('no ip address unsets both lines', () => {
    const f = fakeCtx({ ports: [pcPort()] });
    const r = run(HANDLERS.pcIpAddress, f, {}, true);
    expect(f.configCalls).toEqual([
      { line: ['ip', 'address'], negate: true, context: IF_CTX },
      { line: ['ip', 'default-gateway'], negate: true, context: [] },
    ]);
    expect(r.output).toContain('removed');
  });

  it('rejects bad input before touching the config', () => {
    const f = fakeCtx({ ports: [pcPort()] });
    const cases: [Record<string, string>, RegExp][] = [
      [{ address: '10.0.0.0', mask: '255.255.255.0' }, /network address/],
      [{ address: '10.0.0.255', mask: '255.255.255.0' }, /broadcast address/],
      [{ address: '10.0.0.1', mask: '255.0.255.0' }, /not a valid subnet mask/],
      [{ address: '10.0.0.1', mask: '0.0.0.0' }, /0\.0\.0\.0/],
      [{ address: '224.0.0.1', mask: '255.255.255.0' }, /multicast/],
      [{ address: '127.0.0.1', mask: '255.0.0.0' }, /loopback/],
      [{ address: '10.0.0.1', mask: '255.255.255.0', gateway: '10.0.1.1' }, /not on the subnet 10\.0\.0\.0\/24/],
      [{ address: '10.0.0.1', mask: '255.255.255.0', gateway: '10.0.0.1' }, /own address/],
      [{ address: '300.1.1.1', mask: '255.255.255.0' }, /not a valid IPv4 address/],
    ];
    for (const [args, re] of cases) {
      const r = run(HANDLERS.pcIpAddress, f, args);
      expect(r.error, JSON.stringify(args)).toMatch(re);
      expect(r.error!.startsWith('%')).toBe(true);
    }
    expect(f.configCalls).toEqual([]);
  });

  it('accepts /31 and /32 host addresses and propagates config errors', () => {
    expect(validateHostAddress('10.0.0.0', '255.255.255.254')).toBeUndefined();
    expect(validateHostAddress('10.0.0.1', '255.255.255.255')).toBeUndefined();
    expect(validateHostAddress('10.0.0.1', '255.255.255.0', '10.0.0.254')).toBeUndefined();
    const f = fakeCtx({ ports: [pcPort()], configResult: '% refused by the runtime' });
    const r = run(HANDLERS.pcIpAddress, f, { address: '10.0.0.1', mask: '255.255.255.0' });
    expect(r.error).toBe('% refused by the runtime');
    expect(r.output).toBeUndefined();
  });
});

describe('ipconfig', () => {
  it('renders address, mask, gateway, MAC and link state from live state', () => {
    const running = createConfigAst();
    running.set([], ['ip', 'default-gateway', '10.0.0.254']);
    const f = fakeCtx({ running, ports: [pcPort({ id: 'GigabitEthernet0', ipv4: { address: '10.0.0.1', prefixLen: 24 } })] });
    expect((run(HANDLERS.pcIpconfig, f).output ?? '').split('\n')).toEqual([
      'GigabitEthernet0 (link up)',
      '  Physical address ....: 00:1f:00:00:00:01',
      '  IPv4 address ........: 10.0.0.1',
      '  Subnet mask .........: 255.255.255.0',
      '  Default gateway .....: 10.0.0.254',
    ]);
  });

  it('shows not set for a bare host and the link-down state', () => {
    const f = fakeCtx({ ports: [pcPort({ id: 'GigabitEthernet0', operUp: false })] });
    const out = run(HANDLERS.pcIpconfig, f).output ?? '';
    expect(out).toContain('GigabitEthernet0 (link down)');
    expect(out).toContain('IPv4 address ........: not set');
    expect(out).toContain('Subnet mask .........: not set');
    expect(out).toContain('Default gateway .....: not set');
    const off = fakeCtx({ ports: [pcPort({ id: 'GigabitEthernet0', adminUp: false, operUp: false })] });
    expect(run(HANDLERS.pcIpconfig, off).output).toContain('(link disabled)');
    expect(run(HANDLERS.pcIpconfig, fakeCtx()).error).toMatch(/no network interface/);
  });
});

describe('arp -a', () => {
  it('lists entries per interface in OS style with dashed MACs', () => {
    const f = fakeCtx({ now: 5 * MIN, ports: [pcPort({ id: 'GigabitEthernet0', ipv4: { address: '10.0.0.1', prefixLen: 24 } })] });
    f.arp.set({ key: '10.0.0.254', ip: '10.0.0.254', mac: '00:1f:00:00:00:fe', iface: 'GigabitEthernet0', type: 'dynamic', updatedAt: 0 });
    f.arp.set({ key: '10.0.0.2', ip: '10.0.0.2', mac: '00:1f:00:00:00:02', iface: 'GigabitEthernet0', type: 'dynamic', updatedAt: 0 });
    f.arp.set({ key: '10.0.0.9', ip: '10.0.0.9', mac: '00:00:00:00:00:00', iface: 'GigabitEthernet0', type: 'dynamic', updatedAt: 0, incomplete: true });
    const out = (run(HANDLERS.pcArp, f).output ?? '').split('\n');
    expect(out[0]).toBe('Interface: 10.0.0.1 --- GigabitEthernet0');
    expect(out[1]).toMatch(/^  IPv4 address\s+MAC address\s+Kind$/);
    expect(out[1]).not.toMatch(/Internet address|Physical address/);
    expect(out[2]).toMatch(/^  10\.0\.0\.2\s+00-1f-00-00-00-02\s+dynamic$/);
    expect(out[3]).toMatch(/^  10\.0\.0\.9\s+incomplete\s+dynamic$/);
    expect(out[4]).toMatch(/^  10\.0\.0\.254\s+00-1f-00-00-00-fe\s+dynamic$/);
    expect(out).toHaveLength(5);
  });

  it('prints an original empty line when the cache is empty', () => {
    expect(run(HANDLERS.pcArp, fakeCtx({ ports: [pcPort()] })).output).toBe('No ARP entries found.');
  });
});
