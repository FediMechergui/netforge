/**
 * W1 l2 (ARCHITECTURE-P2 D12, §3.0 step 7, §3.8, §5.1): the pure port-security decision.
 *  - the config reader (enabling line, maximum, violation mode, sticky, configured and sticky addresses);
 *  - the decision: allow / learn (dynamic or sticky) / violation, per mode (protect, restrict, shutdown), and an
 *    address secured on another port of the same VLAN (§3.8 step 4);
 *  - the row helpers, the sticky configLine action, the status rule and the err-disable recovery reader.
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson } from '../src/cli/config-ast.js';
import type { ConfigAst, ConfigNode } from '../src/contracts/config.js';
import type { PortSecurityRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import {
  ERRDISABLE_RECOVERY_DEFAULT_NS,
  PORT_SECURITY_DEBUG_CATEGORY,
  applyPortSecurityVerdict,
  configuredSecureAddresses,
  decidePortSecurity,
  errdisableRecovery,
  errdisableTimerKey,
  isPortSecurityLine,
  portSecurityRow,
  portSecurityStatus,
  readPortSecurity,
  stickyConfigLine,
} from '../src/protocols/l2/port-security.js';
import type { PortSecurityConfig } from '../src/protocols/l2/port-security.js';

function lineNode(text: string): ConfigNode {
  const t = text.split(' ');
  return { key: t[0] as string, args: t.slice(1), children: [] };
}
function cfg(sections: Readonly<Record<string, readonly string[]>>, globals: readonly string[] = []): ConfigAst {
  const root: ConfigNode = { key: '', args: [], children: [] };
  for (const g of globals) root.children.push(lineNode(g));
  for (const [port, lines] of Object.entries(sections)) {
    root.children.push({ key: 'interface', args: [port], children: lines.map(lineNode) });
  }
  return configAstFromJson(root);
}

const FA1 = 'FastEthernet0/1';
const PC1 = '02:56:45:97:57:01';
const PCX = '02:11:22:33:44:01';

const BASE: PortSecurityConfig = { max: 1, violation: 'shutdown', sticky: false, configured: [], stickyMacs: [] };

describe('readPortSecurity (§5.1)', () => {
  it('nothing runs without the enabling line', () => {
    expect(readPortSecurity(cfg({}), FA1)).toBeUndefined();
    expect(readPortSecurity(cfg({ [FA1]: ['switchport mode access'] }), FA1)).toBeUndefined();
    expect(readPortSecurity(cfg({ [FA1]: ['switchport port-security maximum 2', 'switchport port-security violation restrict'] }), FA1)).toBeUndefined();
  });

  it('defaults: maximum 1, violation shutdown, no sticky learning', () => {
    expect(readPortSecurity(cfg({ [FA1]: ['switchport mode access', 'switchport port-security'] }), FA1)).toEqual(BASE);
  });

  it('reads the §3.8 setup and every line form', () => {
    const c = cfg({
      [FA1]: [
        'switchport mode access',
        'switchport port-security',
        'switchport port-security maximum 3',
        'switchport port-security violation restrict',
        'switchport port-security mac-address sticky',
        'switchport port-security mac-address aabb.cc00.0100',
        'switchport port-security mac-address sticky 02:56:45:97:57:01',
        'switchport port-security mac-address sticky 02-56-45-97-57-01',
        'switchport port-security mac-address AA:BB:CC:00:01:00',
      ],
    });
    expect(readPortSecurity(c, FA1)).toEqual({
      max: 3, violation: 'restrict', sticky: true, configured: ['aa:bb:cc:00:01:00'], stickyMacs: [PC1],
    });
  });

  it('ignores values that do not parse', () => {
    const c = cfg({
      [FA1]: [
        'switchport port-security',
        'switchport port-security maximum 0',
        'switchport port-security maximum many',
        'switchport port-security violation explode',
        'switchport port-security mac-address not-a-mac',
      ],
    });
    expect(readPortSecurity(c, FA1)).toEqual(BASE);
  });

  it('configured addresses come first, then sticky ones; an address is never listed twice', () => {
    const c = cfg({
      [FA1]: [
        'switchport port-security',
        'switchport port-security mac-address sticky 02:56:45:97:57:01',
        'switchport port-security mac-address 02:11:22:33:44:01',
        'switchport port-security mac-address 02:56:45:97:57:01',
      ],
    });
    const p = readPortSecurity(c, FA1) as PortSecurityConfig;
    expect(configuredSecureAddresses(p)).toEqual([
      { mac: PCX, secure: 'configured' },
      { mac: PC1, secure: 'configured' },
    ]);
  });
});

describe('decidePortSecurity (§3.8)', () => {
  it('an address already secure on the port is allowed', () => {
    expect(decidePortSecurity({ port: FA1, config: BASE, src: PC1, securedOn: FA1, count: 1 })).toEqual({ kind: 'allow' });
  });

  it('below the maximum an unknown address is learned: dynamic, or sticky when sticky learning is on', () => {
    expect(decidePortSecurity({ port: FA1, config: BASE, src: PC1, count: 0 })).toEqual({ kind: 'learn', secure: 'dynamic' });
    expect(decidePortSecurity({ port: FA1, config: { ...BASE, sticky: true }, src: PC1, count: 0 })).toEqual({ kind: 'learn', secure: 'sticky' });
    expect(decidePortSecurity({ port: FA1, config: { ...BASE, max: 3 }, src: PCX, count: 2 })).toEqual({ kind: 'learn', secure: 'dynamic' });
  });

  it('protect: the drop only', () => {
    expect(decidePortSecurity({ port: FA1, config: { ...BASE, violation: 'protect' }, src: PCX, count: 1 })).toEqual({
      kind: 'violation', mode: 'protect', counts: false, detail: `address ${PCX} is not allowed on FastEthernet0/1 (protect)`,
    });
  });

  it('restrict: the drop, a counted violation and one log line', () => {
    expect(decidePortSecurity({ port: FA1, config: { ...BASE, violation: 'restrict' }, src: PCX, count: 1 })).toEqual({
      kind: 'violation', mode: 'restrict', counts: true,
      detail: `address ${PCX} is not allowed on FastEthernet0/1 (restrict)`,
      log: { severity: 4, message: `Port security on FastEthernet0/1 refused ${PCX}: the port allows 1 address.` },
    });
    const two = decidePortSecurity({ port: FA1, config: { ...BASE, violation: 'restrict', max: 2 }, src: PCX, count: 2 });
    expect(two.kind === 'violation' ? two.log?.message : undefined).toBe(`Port security on FastEthernet0/1 refused ${PCX}: the port allows 2 addresses.`);
  });

  it('shutdown: the drop, a counted violation and err-disable with cause psecure-violation', () => {
    expect(decidePortSecurity({ port: FA1, config: BASE, src: PCX, count: 1 })).toEqual({
      kind: 'violation', mode: 'shutdown', counts: true,
      detail: `address ${PCX} is not allowed on FastEthernet0/1 (shutdown)`,
      errDisable: { cause: 'psecure-violation', detail: `port security refused ${PCX}: the port allows 1 address` },
    });
  });

  it('an address secured on another port of the VLAN is a violation even below the maximum (§3.8 step 4)', () => {
    expect(decidePortSecurity({ port: FA1, config: { ...BASE, max: 5, violation: 'restrict' }, src: PC1, securedOn: 'FastEthernet0/2', count: 0 })).toEqual({
      kind: 'violation', mode: 'restrict', counts: true,
      detail: `address ${PC1} is secured on FastEthernet0/2 (restrict)`,
      log: { severity: 4, message: `Port security on FastEthernet0/1 refused ${PC1}: it is secured on FastEthernet0/2.` },
    });
  });
});

describe('rows and actions', () => {
  it('a new row starts secure-up with no counts; config changes keep the counters', () => {
    const row = portSecurityRow(FA1, { ...BASE, sticky: true }, 5 * SEC);
    expect(row).toEqual({
      key: FA1, port: FA1, max: 1, count: 0, violation: 'shutdown', sticky: true, violations: 0, status: 'secure-up', updatedAt: 5 * SEC,
    });
    const prev: PortSecurityRow = { ...row, count: 1, violations: 2, lastViolationMac: PCX, status: 'secure-shutdown' };
    expect(portSecurityRow(FA1, { ...BASE, max: 4, violation: 'protect' }, 9 * SEC, prev)).toEqual({
      key: FA1, port: FA1, max: 4, count: 1, violation: 'protect', sticky: false, violations: 2, status: 'secure-shutdown',
      lastViolationMac: PCX, updatedAt: 9 * SEC,
    });
    expect(portSecurityRow(FA1, BASE, 9 * SEC, prev, 'secure-up').status).toBe('secure-up');
  });

  it('applyPortSecurityVerdict: learn counts, a counted violation records the address, shutdown shuts the row', () => {
    const row = portSecurityRow(FA1, BASE, 0);
    expect(applyPortSecurityVerdict(row, { kind: 'allow' }, PC1, SEC)).toBe(row);
    expect(applyPortSecurityVerdict(row, { kind: 'learn', secure: 'sticky' }, PC1, SEC)).toEqual({ ...row, count: 1, updatedAt: SEC });
    const protect = decidePortSecurity({ port: FA1, config: { ...BASE, violation: 'protect' }, src: PCX, count: 1 });
    expect(applyPortSecurityVerdict(row, protect, PCX, SEC)).toBe(row);
    const restrict = decidePortSecurity({ port: FA1, config: { ...BASE, violation: 'restrict' }, src: PCX, count: 1 });
    expect(applyPortSecurityVerdict(row, restrict, PCX, SEC)).toEqual({ ...row, violations: 1, lastViolationMac: PCX, updatedAt: SEC });
    const shutdown = decidePortSecurity({ port: FA1, config: BASE, src: PCX, count: 1 });
    expect(applyPortSecurityVerdict(row, shutdown, PCX, SEC)).toEqual({
      ...row, violations: 1, lastViolationMac: PCX, status: 'secure-shutdown', updatedAt: SEC,
    });
  });

  it('status: secure-shutdown while err-disabled by a violation, else up or down with the port', () => {
    expect(portSecurityStatus(true, undefined)).toBe('secure-up');
    expect(portSecurityStatus(false, undefined)).toBe('secure-down');
    expect(portSecurityStatus(false, 'psecure-violation')).toBe('secure-shutdown');
    expect(portSecurityStatus(false, 'bpduguard')).toBe('secure-down');
  });

  it('the sticky line is a configLine action on the interface (§3.8 step 2)', () => {
    expect(stickyConfigLine(FA1, PC1)).toEqual({
      type: 'configLine',
      context: [['interface', 'FastEthernet0/1']],
      line: ['switchport', 'port-security', 'mac-address', 'sticky', PC1],
      negate: false,
    });
    expect(isPortSecurityLine(stickyConfigLine(FA1, PC1).line)).toBe(true);
    expect(isPortSecurityLine(['switchport', 'port-security'])).toBe(true);
    expect(isPortSecurityLine(['switchport', 'mode', 'access'])).toBe(false);
    expect(PORT_SECURITY_DEBUG_CATEGORY).toBe('port-security');
  });
});

describe('err-disable recovery (§3.8 step 6, §5.1)', () => {
  it('off by default, 300 s interval', () => {
    expect(errdisableRecovery(cfg({}), 'psecure-violation')).toEqual({ enabled: false, intervalNs: ERRDISABLE_RECOVERY_DEFAULT_NS });
    expect(ERRDISABLE_RECOVERY_DEFAULT_NS).toBe(300 * SEC);
  });

  it('per cause, `all`, and the interval', () => {
    const c = cfg({}, ['errdisable recovery cause psecure-violation', 'errdisable recovery interval 30']);
    expect(errdisableRecovery(c, 'psecure-violation')).toEqual({ enabled: true, intervalNs: 30 * SEC });
    expect(errdisableRecovery(c, 'bpduguard')).toEqual({ enabled: false, intervalNs: 30 * SEC });
    const all = cfg({}, ['errdisable recovery cause all']);
    expect(errdisableRecovery(all, 'channel-misconfig').enabled).toBe(true);
    const bad = cfg({}, ['errdisable recovery interval 5', 'errdisable recovery interval x']);
    expect(errdisableRecovery(bad, 'bpduguard').intervalNs).toBe(ERRDISABLE_RECOVERY_DEFAULT_NS);
  });

  it('timer key errdisable:<port>', () => {
    expect(errdisableTimerKey(FA1)).toBe('errdisable:FastEthernet0/1');
  });
});
