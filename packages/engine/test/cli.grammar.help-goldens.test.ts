/**
 * Generated `?` help goldens per catalog model × mode × port role (ARCHITECTURE-P1 §8.1 W3 cli, §11 "Help goldens pin
 * behaviour"). For every model the test lists the top-level help of each mode its grammar reaches, the `show ` and
 * `debug ` subtrees, and the config-if help of one representative port per (kind, role) — including the routed role
 * multilayer switch ports can take. The JSON golden lives in test/goldens/cli-help.p05.json; a grammar change that
 * alters any list shows up as a golden diff.
 *
 * ARCHITECTURE-P3 §9.2 item 21 (W3, the final lists): the approved items' new modes — `config-router-eigrp` [C1] and the
 * four crypto modes [C13] — are listed for every model whose grammar offers more there than the navigation words, and
 * the Tunnel interface [S18]/[C13] (`config-if virtual/tunnel`) for every model the Tunnel family is derived for
 * (`withTunnelFamily`: routing, not a home router; the catalog derives it at the W4 flip); they are new golden
 * entries, appended after the P0-P2 keys of a model.
 */
import { describe, expect, it } from 'vitest';
import type { CliMode } from '../src/contracts/cli.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortView } from '../src/contracts/port.js';
import { ROLE_TRAITS, type PortRole } from '../src/contracts/catalog.js';
import { ALL_MODELS } from '../src/device/catalog/index.js';
import { GRAMMAR } from '../src/cli/grammar/index.js';
import { help } from '../src/cli/parser.js';
import { virtualPortName } from '../src/device/catalog/names.js';
import { withTunnelFamily } from '../src/device/catalog/define.js';
import { testPortView } from './cli.parser.fixture.js';
import { devicePortViews, matchContextFor, type MatchContextOptions } from './cli.p05.fixture.js';

/** ARCHITECTURE-P3 §9.2 item 21 (W3): the approved items' modes recorded as new golden entries. */
const P3_APPROVED_MODES: readonly CliMode[] = ['config-router-eigrp', 'config-ikev2-keyring', 'config-ikev2-keyring-peer', 'config-ikev2-profile', 'config-ipsec-profile'];
/** The words every configuration mode offers (a mode offering only these is not one the model's grammar reaches). */
const NAVIGATION_WORDS: ReadonlySet<string> = new Set(['do', 'end', 'exit', 'no']);

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
  // ARCHITECTURE-P3 §9.2 item 21 (W3): the approved items' modes and the Tunnel interface (file header)
  for (const mode of P3_APPROVED_MODES) {
    const list = listing(model, mode, '');
    if (list.some((t) => !NAVIGATION_WORDS.has(t))) out[mode] = list;
  }
  // the Tunnel family is derived at build stage P3 only (`withTunnelFamily`, the W4 flip): the same derivation here
  // records its list now, so the Tunnel family moves no golden list at the flip (the flip's dormant udp/tcp on managed
  // switches, D22, did add `tcp` and `udp` to their `priv-exec debug` lists: ruling R48, §9.2 W4 entry 37b)
  for (const fam of withTunnelFamily(model.capabilities, model.virtualFamilies ?? [])) {
    if (fam.role !== 'tunnel') continue;
    const view: PortView = {
      ...testPortView({ name: virtualPortName({ family: fam.family }, 0), short: `${fam.short}0`, kind: 'virtual', role: 'tunnel', allowedRoles: ['tunnel'], encap: fam.encap ?? 'tunnel', connector: 'none', speedBps: 100_000 }),
      role: 'tunnel',
    };
    out['config-if virtual/tunnel'] = listing(model, 'config-if', '', { ports, ifaceView: view });
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
    // ARCHITECTURE-P3 §9.2 W2 item 21 (W2 cli folds the P3 fragments and the approved items' into GRAMMAR): the complete
    // new lists — `delay` [C1], `fair-queue` [S21], `logging` [S24]/[S25], `crypto` [C13], `router` (also EIGRP [C1]),
    // `ssh` and `telnet` [S13]; OSPF, EIGRP and ACL interface lines sit under the existing `ip`
    expect(goldens['router.nf2911']!['config-if ethernet/routed']).toEqual(['bandwidth', 'cdp', 'delay', 'description', 'do', 'duplex', 'encapsulation', 'end', 'exit', 'fair-queue', 'ip', 'ipv6', 'lldp', 'mac-address', 'no', 'service-policy', 'shutdown', 'speed', 'standby']);
    expect(goldens['router.nf2911']!.config).toEqual(['access-list', 'banner', 'cdp', 'class-map', 'clock', 'crypto', 'do', 'enable', 'end', 'exit', 'hostname', 'interface', 'ip', 'ipv6', 'line', 'lldp', 'logging', 'no', 'ntp', 'policy-map', 'restconf', 'router', 'service', 'username']);
    expect(goldens['router.nf2911']!['user-exec']).toEqual(['enable', 'exit', 'logout', 'nslookup', 'ping', 'show', 'ssh', 'telnet', 'traceroute']);
    expect(goldens['pc.nfpc']!['user-exec']).toEqual(['adapter', 'arp', 'exit', 'flow', 'ip', 'ipconfig', 'ipv6', 'ipv6config', 'netstat', 'no', 'nslookup', 'ping', 'rest', 'show', 'ssh', 'telnet', 'tracert']);
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
