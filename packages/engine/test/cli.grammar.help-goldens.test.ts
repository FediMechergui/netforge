/**
 * Generated `?` help goldens per catalog model × mode × port role (ARCHITECTURE-P1 §8.1 W3 cli, §11 "Help goldens pin
 * behaviour"). For every model the test lists the top-level help of each mode its grammar reaches, the `show ` and
 * `debug ` subtrees, and the config-if help of one representative port per (kind, role) — including the routed role
 * multilayer switch ports can take. The JSON golden lives in test/goldens/cli-help.p05.json; a grammar change that
 * alters any list shows up as a golden diff.
 */
import { describe, expect, it } from 'vitest';
import type { CliMode } from '../src/contracts/cli.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortView } from '../src/contracts/port.js';
import { ROLE_TRAITS, type PortRole } from '../src/contracts/catalog.js';
import { ALL_MODELS } from '../src/device/catalog/index.js';
import { GRAMMAR } from '../src/cli/grammar/index.js';
import { help } from '../src/cli/parser.js';
import { devicePortViews, matchContextFor, type MatchContextOptions } from './cli.p05.fixture.js';

function listing(model: DeviceModel, mode: CliMode, partial: string, opts: MatchContextOptions = {}): string[] {
  return help(GRAMMAR, matchContextFor(model, mode, opts), partial).items.map((i) => i.token);
}

/** Help lists of one model. */
function goldenFor(model: DeviceModel): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (model.cli?.grammar === 'host') {
    out['user-exec'] = listing(model, 'user-exec', '');
    out['user-exec show'] = listing(model, 'user-exec', 'show ');
    return out;
  }
  out['user-exec'] = listing(model, 'user-exec', '');
  out['priv-exec'] = listing(model, 'priv-exec', '');
  out['priv-exec show'] = listing(model, 'priv-exec', 'show ');
  out['priv-exec debug'] = listing(model, 'priv-exec', 'debug ');
  out.config = listing(model, 'config', '');
  const ports = devicePortViews(model);
  const seen = new Set<string>();
  for (const port of ports.values()) {
    const roles: readonly PortRole[] = port.spec.allowedRoles ?? (port.spec.role !== undefined ? [port.spec.role] : []);
    for (const role of roles) {
      if (!ROLE_TRAITS[role].configurable) continue;
      const key = `config-if ${port.spec.kind}/${role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const view: PortView = role === port.spec.role ? port : { ...port, role };
      out[key] = listing(model, 'config-if', '', { ports, ifaceView: view });
    }
  }
  return out;
}

describe('help goldens', () => {
  const goldens: Record<string, Record<string, string[]>> = {};
  for (const model of ALL_MODELS) goldens[model.type] = goldenFor(model);

  it('the P0 models carry their P0 lists plus the P1 additions', () => {
    // ARCHITECTURE-P1 §9.2 (P1): IPv6, the line and password commands and the host shell additions join the lists;
    // every P0 entry is still there, in the same order.
    // ARCHITECTURE-P2 §9.2 items 12 and 18 (W4 folds the P2 fragments into GRAMMAR): `encapsulation` (W2) and `standby`
    // [S2] (W3) on the routed Ethernet port, `access-list` (W3) in config
    expect(goldens['router.nf2911']!['config-if ethernet/routed']).toEqual(['description', 'do', 'duplex', 'encapsulation', 'end', 'exit', 'ip', 'ipv6', 'mac-address', 'no', 'shutdown', 'speed', 'standby']);
    expect(goldens['router.nf2911']!.config).toEqual(['access-list', 'banner', 'do', 'enable', 'end', 'exit', 'hostname', 'interface', 'ip', 'ipv6', 'line', 'no', 'service', 'username']);
    expect(goldens['router.nf2911']!['user-exec']).toEqual(['enable', 'exit', 'logout', 'nslookup', 'ping', 'show', 'traceroute']);
    expect(goldens['pc.nfpc']!['user-exec']).toEqual(['adapter', 'arp', 'exit', 'ip', 'ipconfig', 'ipv6', 'ipv6config', 'netstat', 'no', 'nslookup', 'ping', 'show', 'tracert']);
    expect(goldens['pc.nfpc']!['user-exec show']).toEqual(['arp', 'history', 'hosts', 'interfaces', 'ip', 'running-config', 'version']);
    // The L2 switch gained its management SVI (P1 W5 catalog), which takes an address although the switch does not route.
    expect(goldens['switch.nfc2960']!['config-if virtual/svi']).toContain('ip');
  });

  it('every model has a golden entry and the lists are sorted', () => {
    expect(Object.keys(goldens)).toEqual(ALL_MODELS.map((m) => m.type));
    for (const [type, modes] of Object.entries(goldens)) {
      for (const [mode, list] of Object.entries(modes)) {
        const lits = list.filter((t) => /^[a-z|]/.test(t));
        expect([...lits].sort(), `${type} ${mode}`).toEqual(lits);
      }
    }
  });

  it('matches the committed golden file', async () => {
    await expect(`${JSON.stringify(goldens, null, 2)}\n`).toMatchFileSnapshot('./goldens/cli-help.p05.json');
  });
});
