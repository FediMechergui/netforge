/**
 * cli/grammar/wlc.ts and cli/handlers/wlc.ts (ARCHITECTURE-P2 §3.12, §5.3, §5.4, D17; §7 W5 cli): the controller's
 * `wlc-interface` section (the handler keeps the interface's VLAN, the SVI that carries its address and, for
 * `management`, `ip default-gateway`), the `wlan` section, the lightweight access point's `capwap enable` and
 * `capwap controller`, and `show capwap`.
 *
 * Built on p2.world's TEST-ONLY wireless models (§7 W4 qa): NF-WLC-9800 (`NF_WLC_9800_TEST_INPUT`) and NF-AP-1832 with
 * `lightweight-ap` (`P2_WIRELESS_MODEL_DELTAS`). The capwap daemons are the W5 wireless item's (same wave, rule 9):
 * the worlds here are built without them (the registry overlay removes both names), so only the grammar, the handlers,
 * the config store and the runtime are under test; `show capwap` reads fake tables in the §2.6 row shapes.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, MODES, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import type { ConfigAst } from '../src/contracts/config.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { CapwapApRow, CapwapRow, Table, TableRow, VlanRow, WlanClientRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { createTable } from '../src/core/table.js';
import { findBannedWords } from '../src/device/catalog/validate.js';
import {
  BUILTIN_GRAMMAR,
  capabilitiesRunning,
  DEBUG_CATEGORIES,
  DEBUG_CATEGORY_DEFS,
  GRAMMAR,
  GRAMMAR_FRAGMENTS,
  HANDLERS,
  LITERAL_HELP,
  P2_GRAMMAR_FRAGMENTS,
  P2_HANDLERS,
  WLC_ARG_LIMITS,
  WLC_GRAMMAR,
  WLC_HANDLERS,
} from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY, P2_HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import * as wlcMessages from '../src/cli/handlers/wlc.js';
import {
  MSG_BAD_CAPWAP_CONTROLLER,
  MSG_BAD_WLAN_PASSPHRASE,
  MSG_BAD_WLC_DHCP_SERVER,
  MSG_BAD_WLC_GATEWAY,
  MSG_CAPWAP_OFF,
  MSG_CAPWAP_ON,
  MSG_NO_ACCESS_POINTS,
  MSG_NO_CONTROLLER_LINES,
  MSG_NO_CONTROLLER_YET,
  MSG_NO_SUCH_WLAN,
  MSG_NO_WIRELESS_CLIENTS,
  MSG_NO_WLAN_SELECTED,
  MSG_NO_WLC_INTERFACE_SELECTED,
  MSG_WLAN_ID_TAKEN,
  MSG_WLAN_WORDS_DIFFER,
  MSG_WLC_INTERFACE_IN_USE,
  MSG_WLC_MANAGEMENT_FIXED,
  MSG_WLC_NO_SUCH_INTERFACE,
  MSG_WLC_SUBNET_OVERLAP,
  MSG_WLC_VLAN_REQUIRED,
  MSG_WLC_VLAN_RESERVED,
  MSG_WLC_VLAN_TAKEN,
  wlans,
  wlcInterfaces,
} from '../src/cli/handlers/wlc.js';
import { modeForContext, modesOfClass } from '../src/cli/modes.js';
import { help, matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';
import { createP2Simulation, defineP2Model, NF_WLC_9800_TEST_INPUT } from './p2.world.js';

const WLC = defineP2Model(NF_WLC_9800_TEST_INPUT);
const AP = p2Model('ap.nfap-lw');
const H = P2_HANDLERS;
const MASK = '255.255.255.0';

function handler(id: string): CommandHandler {
  const h = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h;
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  return handler(id)(rec.ctx, args, negate);
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');
const tokens = (items: readonly { token: string }[]): string[] => items.map((i) => i.token);
const fill = (template: string, values: Record<string, string | number>): string => template.replace(/\{(\w+)\}/g, (_w, k: string) => String(values[k]));

/** The §3.12 controller configuration, as the controller panel's Interfaces and WLANs pages write it. */
const SECTION_3_12: readonly string[] = [
  'wlc-interface management',
  ' vlan 99',
  ` address 192.168.99.5 ${MASK}`,
  ' gateway 192.168.99.1',
  'wlc-interface STAFF-IF',
  ' vlan 20',
  ` address 192.168.20.5 ${MASK}`,
  ' gateway 192.168.20.1',
  ' dhcp-server 192.168.20.1',
  'wlan 1 STAFF LabNet',
  ' security wpa2-psk',
  ' passphrase correct horse battery',
  ' interface STAFF-IF',
  ' no shutdown',
];

/** A booted P2 world with the test-only controller (and the lightweight AP), without the capwap daemons. */
function world(profile: 'P1' | 'P2' = 'P2'): Simulation {
  const sim = createP2Simulation({ seed: 5, profile, factories: { 'capwap-wtp': undefined, 'capwap-ac': undefined } });
  sim.addDevice({ id: 'wlc', type: 'wlc.nfwlc9800', name: 'WLC1' });
  sim.addDevice({ id: 'ap', type: 'ap.nfap-lw', name: 'LAP1' });
  sim.runFor(30 * SEC);
  return sim;
}

const running = (sim: Simulation, dev: string): string => sim.device(dev)!.running.render();
const has = (text: string, line: string): boolean => text.split('\n').some((l) => l.trim() === line);

/** Run lines headlessly on `dev`; returns every line's error message (undefined = accepted). */
function configure(sim: Simulation, dev: string, commands: readonly string[]): (string | undefined)[] {
  return sim.configure(dev, commands, { stopOnError: false }).lines.map((l) => l.error?.message);
}

describe('grammar and scope', () => {
  const ok = (m: ReturnType<typeof matchCommand>) => {
    if (!m.ok) throw new Error(m.error.message);
    return m;
  };

  it('parses the controller interface and WLAN sections on the controller', () => {
    const config = matchContextFor(WLC, 'config');
    expect(ok(matchCommand(BUILTIN_GRAMMAR, config, 'wlc-interface management'))).toMatchObject({ spec: { handler: H.configWlcInterface, entersMode: 'config-wlc-if' }, args: { name: 'management' }, negated: false });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, config, 'no wlc-interface STAFF-IF'))).toMatchObject({ args: { name: 'STAFF-IF' }, negated: true });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, config, 'wlan 1 STAFF LabNet'))).toMatchObject({ spec: { handler: H.configWlan, entersMode: 'config-wlan' }, args: { id: '1', profile: 'STAFF', ssid: 'LabNet' } });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, config, 'no wlan 1'))).toMatchObject({ args: { id: '1' }, negated: true });
    const wlcIf = matchContextFor(WLC, 'config-wlc-if');
    expect(ok(matchCommand(BUILTIN_GRAMMAR, wlcIf, 'vlan 99'))).toMatchObject({ spec: { handler: H.wlcIfVlan }, args: { vlan: '99' } });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, wlcIf, `address 192.168.99.5 ${MASK}`))).toMatchObject({ spec: { handler: H.wlcIfAddress }, args: { address: '192.168.99.5', mask: MASK } });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, wlcIf, 'gateway 192.168.99.1'))).toMatchObject({ spec: { handler: H.wlcIfGateway }, args: { address: '192.168.99.1' } });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, wlcIf, 'dhcp-server 192.168.20.1'))).toMatchObject({ spec: { handler: H.wlcIfDhcpServer }, args: { address: '192.168.20.1' } });
    for (const line of ['no vlan', 'no address', 'no gateway', 'no dhcp-server']) expect(ok(matchCommand(BUILTIN_GRAMMAR, wlcIf, line)).negated, line).toBe(true);
    const wlan = matchContextFor(WLC, 'config-wlan');
    expect(ok(matchCommand(BUILTIN_GRAMMAR, wlan, 'security wpa2-psk'))).toMatchObject({ spec: { handler: H.wlanSecurity }, args: { mode: 'wpa2-psk' } });
    const pass = ok(matchCommand(BUILTIN_GRAMMAR, wlan, 'passphrase correct horse battery'));
    expect(pass).toMatchObject({ spec: { handler: H.wlanPassphrase }, args: { text: 'correct horse battery' } });
    expect(pass.secretSpans).toEqual([{ column: 11, end: 32 }]);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, wlan, 'interface STAFF-IF'))).toMatchObject({ spec: { handler: H.wlanInterface }, args: { name: 'STAFF-IF' } });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, wlan, 'radio 5'))).toMatchObject({ spec: { handler: H.wlanRadio }, args: { band: '5' } });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, wlan, 'shutdown'))).toMatchObject({ spec: { handler: H.wlanShutdown }, negated: false });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, wlan, 'no shutdown'))).toMatchObject({ spec: { handler: H.wlanShutdown }, negated: true });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, wlan, 'no interface'))).toMatchObject({ spec: { handler: H.wlanInterface }, negated: true });
    // values the grammar refuses: a colon in an SSID (the CAPWAP WLAN field separator), a WLAN number out of range,
    // a name that does not start with a letter or digit, a VLAN out of range, the enterprise modes [S11 not built]
    expect(matchCommand(BUILTIN_GRAMMAR, config, 'wlan 1 STAFF Lab:Net')).toMatchObject({ ok: false, kind: 'invalid-arg' });
    expect(matchCommand(BUILTIN_GRAMMAR, config, 'wlan 513 STAFF LabNet')).toMatchObject({ ok: false, kind: 'invalid-arg' });
    expect(matchCommand(BUILTIN_GRAMMAR, config, 'wlc-interface -bad')).toMatchObject({ ok: false, kind: 'invalid-arg' });
    expect(matchCommand(BUILTIN_GRAMMAR, wlcIf, 'vlan 4095')).toMatchObject({ ok: false, kind: 'invalid-arg' });
    expect(matchCommand(BUILTIN_GRAMMAR, wlan, 'security wpa2-enterprise')).toMatchObject({ ok: false, kind: 'invalid-arg' });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, matchContextFor(WLC, 'user-exec'), 'show capwap'))).toMatchObject({ spec: { handler: H.showCapwap } });
  });

  it('parses the capwap lines and show capwap on the lightweight access point', () => {
    expect(AP.capabilities).toContain('lightweight-ap');
    const config = matchContextFor(AP, 'config');
    expect(ok(matchCommand(BUILTIN_GRAMMAR, config, 'capwap enable'))).toMatchObject({ spec: { handler: H.configCapwapEnable }, negated: false });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, config, 'no capwap enable'))).toMatchObject({ spec: { handler: H.configCapwapEnable }, negated: true });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, config, 'capwap controller 192.168.99.5'))).toMatchObject({ spec: { handler: H.configCapwapController }, args: { address: '192.168.99.5' } });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, config, 'no capwap controller'))).toMatchObject({ args: {}, negated: true });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, matchContextFor(AP, 'user-exec'), 'show capwap'))).toMatchObject({ spec: { handler: H.showCapwap } });
    expect(tokens(help(BUILTIN_GRAMMAR, config, 'capwap ').items)).toEqual(['controller', 'enable']);
    expect(help(BUILTIN_GRAMMAR, config, 'capw').items).toEqual([{ token: 'capwap', help: LITERAL_HELP['capwap'] }]);
    expect(LITERAL_HELP['capwap']).toBe('Controller link settings');
  });

  it('scopes the lines by capability: the controller lines on the controller, the capwap lines on the lightweight AP', () => {
    const unrecognized = (model: Parameters<typeof matchContextFor>[0], mode: string, line: string) =>
      expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(model, mode), line), `${model.type}: ${line}`).toMatchObject({ ok: false, kind: 'unrecognized' });
    unrecognized(WLC, 'config', 'capwap enable');
    unrecognized(AP, 'config', 'wlc-interface management');
    unrecognized(AP, 'config', 'wlan 1 STAFF LabNet');
    for (const model of [p2Model('switch.nfc2960'), p2Model('router.nf2911'), p2Model('mlswitch.nfc3650-24')]) {
      unrecognized(model, 'config', 'wlc-interface management');
      unrecognized(model, 'config', 'wlan 1 STAFF LabNet');
      unrecognized(model, 'config', 'capwap enable');
      unrecognized(model, 'user-exec', 'show capwap');
    }
    // the live catalog's NF-AP-1832 is still autonomous: `lightweight-ap` arrives with the W6 catalog item
    unrecognized(catalogModel('ap.nfap-lw'), 'config', 'capwap enable');
    unrecognized(catalogModel('ap.nfap-lw'), 'user-exec', 'show capwap');
  });

  it('lists exactly the section lines in the two new modes, and the new globals in config', () => {
    expect(tokens(help(BUILTIN_GRAMMAR, matchContextFor(WLC, 'config-wlc-if'), '').items)).toEqual(['address', 'dhcp-server', 'do', 'end', 'exit', 'gateway', 'no', 'vlan']);
    expect(tokens(help(BUILTIN_GRAMMAR, matchContextFor(WLC, 'config-wlan'), '').items)).toEqual(['do', 'end', 'exit', 'interface', 'no', 'passphrase', 'radio', 'security', 'shutdown']);
    const config = tokens(help(BUILTIN_GRAMMAR, matchContextFor(WLC, 'config'), '').items);
    expect(config).toContain('wlan');
    expect(config).toContain('wlc-interface');
    expect(config).not.toContain('capwap');
    expect(config).not.toContain('vlan');
    expect(tokens(help(BUILTIN_GRAMMAR, matchContextFor(AP, 'config'), '').items)).toContain('capwap');
    for (const model of [WLC, AP]) expect(tokens(help(BUILTIN_GRAMMAR, matchContextFor(model, 'user-exec'), 'show ').items), model.type).toContain('capwap');
  });

  it('entered config-wlan and config-wlc-if (their reserved flags dropped, §9.2 W2 item 12b)', () => {
    expect(MODES['config-wlan']?.reserved).toBeUndefined();
    expect(MODES['config-wlc-if']?.reserved).toBeUndefined();
    expect(modesOfClass('config').slice(-2)).toEqual(['config-wlan', 'config-wlc-if']);
    expect(modeForContext([['wlan', '1', 'STAFF', 'LabNet']])).toBe('config-wlan');
    expect(modeForContext([['wlc-interface', 'management']])).toBe('config-wlc-if');
  });

  it('registers the capwap debug category (§5.4), keyed on the capwap daemons\' capability rows', () => {
    expect(DEBUG_CATEGORIES).toContain('capwap');
    const def = DEBUG_CATEGORY_DEFS.find((d) => d.category === 'capwap');
    expect(def).toMatchObject({ since: 'P2', requiresAny: capabilitiesRunning('capwap-wtp', 'capwap-ac') });
    const spec = GRAMMAR.find((s) => s.handler === HANDLERS.execDebug && s.fixedArgs?.category === 'capwap');
    expect(spec?.path).toEqual(['debug', 'capwap']);
    expect(spec?.requiresAny).toEqual(def?.requiresAny);
  });

  it('is the `wlc` fragment, folded into GRAMMAR and HANDLERS after the W3 fragments', () => {
    expect(Object.keys(P2_GRAMMAR_FRAGMENTS).at(-1)).toBe('wlc');
    expect(Object.keys(GRAMMAR_FRAGMENTS).at(-1)).toBe('wlc');
    expect(GRAMMAR_FRAGMENTS['wlc']).toBe(WLC_GRAMMAR);
    expect(GRAMMAR.slice(GRAMMAR.length - WLC_GRAMMAR.length)).toEqual(WLC_GRAMMAR);
    expect(Object.values(WLC_HANDLERS)).toEqual([
      'config.wlc-interface', 'wlc-if.vlan', 'wlc-if.address', 'wlc-if.gateway', 'wlc-if.dhcp-server',
      'config.wlan', 'wlan.security', 'wlan.passphrase', 'wlan.interface', 'wlan.radio', 'wlan.shutdown',
      'config.capwap-enable', 'config.capwap-controller', 'show.capwap',
    ]);
    for (const id of Object.values(WLC_HANDLERS)) {
      expect(Object.values(HANDLERS), id).toContain(id);
      expect(P2_HANDLER_REGISTRY[id], id).toBeDefined();
      expect(HANDLER_REGISTRY[id], id).toBe(P2_HANDLER_REGISTRY[id]);
      expect(WLC_GRAMMAR.some((s) => s.handler === id), id).toBe(true);
    }
    for (const s of WLC_GRAMMAR) {
      expect(s.since, s.path.join(' ')).toBe('P2');
      expect(s.grammars, s.path.join(' ')).toEqual(['nfos']);
      expect((s.requiresAny ?? []).length, s.path.join(' ')).toBeGreaterThan(0);
    }
  });
});

describe('controller interfaces: the lines each one stands for (recording context)', () => {
  /** A recording context on the controller inside `context`, sharing `ast`. */
  const wlcIn = (ast: ConfigAst, context: string[][] = []): RecordingCtx =>
    commandCtxFor(WLC, { mode: context.length === 0 ? 'config' : 'config-wlc-if', context, running: ast });

  it('creates the section and enters config-wlc-if; vlan adds the VLAN; address writes the SVI; gateway writes the default gateway', () => {
    const ast = createConfigAst();
    const top = wlcIn(ast);
    expect(run(top, H.configWlcInterface, { name: 'management' })).toEqual({});
    expect(top.configCalls).toEqual([{ line: ['wlc-interface', 'management'], negate: false, context: [] }]);
    expect(top.enterModeCalls).toEqual([{ mode: 'config-wlc-if', opts: { context: [['wlc-interface', 'management']] } }]);
    const mgmt = wlcIn(ast, [['wlc-interface', 'management']]);
    expect(run(mgmt, H.wlcIfVlan, { vlan: '99' })).toEqual({});
    expect(run(mgmt, H.wlcIfAddress, { address: '192.168.99.5', mask: MASK })).toEqual({});
    expect(run(mgmt, H.wlcIfGateway, { address: '192.168.99.1' })).toEqual({});
    expect(mgmt.configCalls).toEqual([
      // the controller's VLAN list gains the interface's VLAN, then the section stores the line
      { line: ['vlan', '99'], negate: false, context: [] },
      { line: ['vlan', '99'], negate: false, context: undefined },
      // the address, then the SVI that carries it (created, addressed, no shutdown)
      { line: ['address', '192.168.99.5', MASK], negate: false, context: undefined },
      { line: ['interface', 'Vlan99'], negate: false, context: [] },
      { line: ['ip', 'address', '192.168.99.5', MASK], negate: false, context: [['interface', 'Vlan99']] },
      { line: ['shutdown'], negate: true, context: [['interface', 'Vlan99']] },
      // the management interface's gateway is the controller's default gateway
      { line: ['gateway', '192.168.99.1'], negate: false, context: undefined },
      { line: ['ip', 'default-gateway', '192.168.99.1'], negate: false, context: [] },
    ]);
    expect(wlcInterfaces(mgmt.ctx)).toEqual([{ name: 'management', vlan: 99, address: '192.168.99.5', mask: MASK, gateway: '192.168.99.1' }]);
    expect(ast.render()).toContain('\nvlan 99\n!\nwlc-interface management\n vlan 99\n address 192.168.99.5 255.255.255.0\n gateway 192.168.99.1\n!\n');
    expect(ast.render()).toContain('\ninterface Vlan99\n ip address 192.168.99.5 255.255.255.0\n!\n');
    expect(ast.render()).toContain('\nip default-gateway 192.168.99.1\n');
  });

  it('keeps the address when the VLAN comes last, and only the management interface writes the default gateway', () => {
    const ast = createConfigAst();
    const staff = wlcIn(ast, [['wlc-interface', 'STAFF-IF']]);
    ast.set([], ['wlc-interface', 'STAFF-IF']);
    expect(run(staff, H.wlcIfAddress, { address: '192.168.20.5', mask: MASK })).toEqual({});
    expect(run(staff, H.wlcIfGateway, { address: '192.168.20.1' })).toEqual({});
    expect(run(staff, H.wlcIfDhcpServer, { address: '192.168.20.1' })).toEqual({});
    // no VLAN yet: nothing but the section lines
    expect(staff.configCalls.map((c) => c.line[0])).toEqual(['address', 'gateway', 'dhcp-server']);
    expect(run(staff, H.wlcIfVlan, { vlan: '20' })).toEqual({});
    expect(staff.configCalls.slice(3)).toEqual([
      { line: ['vlan', '20'], negate: false, context: [] },
      { line: ['vlan', '20'], negate: false, context: undefined },
      { line: ['interface', 'Vlan20'], negate: false, context: [] },
      { line: ['ip', 'address', '192.168.20.5', MASK], negate: false, context: [['interface', 'Vlan20']] },
      { line: ['shutdown'], negate: true, context: [['interface', 'Vlan20']] },
    ]);
    expect(ast.get('ip.default-gateway')).toBeUndefined();
    // VLAN 1 is built in: no `vlan 1` section is written for it
    const ast1 = createConfigAst();
    ast1.set([], ['wlc-interface', 'management']);
    const m1 = wlcIn(ast1, [['wlc-interface', 'management']]);
    expect(run(m1, H.wlcIfVlan, { vlan: '1' })).toEqual({});
    expect(m1.configCalls).toEqual([{ line: ['vlan', '1'], negate: false, context: undefined }]);
  });

  it('lines typed outside their section are refused', () => {
    const top = wlcIn(createConfigAst());
    expect(run(top, H.wlcIfVlan, { vlan: '99' }).error).toBe(MSG_NO_WLC_INTERFACE_SELECTED);
    expect(run(top, H.wlcIfAddress, { address: '192.168.99.5', mask: MASK }).error).toBe(MSG_NO_WLC_INTERFACE_SELECTED);
    for (const id of [H.wlanSecurity, H.wlanPassphrase, H.wlanInterface, H.wlanRadio, H.wlanShutdown]) {
      expect(run(top, id, { mode: 'open', text: 'correct horse', name: 'management', band: '5' }).error, id).toBe(MSG_NO_WLAN_SELECTED);
    }
    expect(top.configCalls).toEqual([]);
  });

  it('checks addresses, gateways and DHCP servers', () => {
    const ast = createConfigAst();
    ast.set([], ['wlc-interface', 'management']);
    const mgmt = wlcIn(ast, [['wlc-interface', 'management']]);
    expect(run(mgmt, H.wlcIfAddress, { address: '192.168.99.0', mask: MASK }).error).toBe('% Bad mask: that address is the network or broadcast address of the subnet.');
    expect(run(mgmt, H.wlcIfAddress, { address: '192.168.99.5', mask: '255.0.255.0' }).error).toBe('% Expected a contiguous subnet mask such as 255.255.255.0.');
    expect(run(mgmt, H.wlcIfAddress, { address: '127.0.0.5', mask: MASK }).error).toBe('% Invalid interface address.');
    expect(run(mgmt, H.wlcIfGateway, { address: '224.0.0.1' }).error).toBe(MSG_BAD_WLC_GATEWAY);
    expect(run(mgmt, H.wlcIfGateway, { address: '0.0.0.0' }).error).toBe(MSG_BAD_WLC_GATEWAY);
    expect(run(mgmt, H.wlcIfDhcpServer, { address: '255.255.255.255' }).error).toBe(MSG_BAD_WLC_DHCP_SERVER);
    expect(run(mgmt, H.wlcIfVlan, { vlan: '1003' }).error).toBe(MSG_WLC_VLAN_RESERVED);
    expect(run(mgmt, H.wlcIfVlan, {}, true).error).toBe(MSG_WLC_VLAN_REQUIRED);
    expect(mgmt.configCalls).toEqual([]);
  });
});

describe('controller interfaces and WLANs on a real controller', () => {
  it('builds the §3.12 configuration: interfaces, VLANs, SVIs up with their addresses, the default gateway, the WLAN', () => {
    const sim = world();
    const r = sim.configure('wlc', SECTION_3_12, { indentation: true });
    expect(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok))).toBe(true);
    expect(r.lines.map((l) => l.mode)).toEqual([
      'config-wlc-if', 'config-wlc-if', 'config-wlc-if', 'config-wlc-if',
      'config-wlc-if', 'config-wlc-if', 'config-wlc-if', 'config-wlc-if', 'config-wlc-if',
      'config-wlan', 'config-wlan', 'config-wlan', 'config-wlan', 'config-wlan',
    ]);
    expect(running(sim, 'wlc')).toBe([
      '! NetForge NFOS configuration',
      'version 1.0',
      '!',
      'hostname WLC1',
      '!',
      'vlan 99',
      '!',
      'vlan 20',
      '!',
      'wlc-interface management',
      ' vlan 99',
      ' address 192.168.99.5 255.255.255.0',
      ' gateway 192.168.99.1',
      '!',
      'wlc-interface STAFF-IF',
      ' vlan 20',
      ' address 192.168.20.5 255.255.255.0',
      ' gateway 192.168.20.1',
      ' dhcp-server 192.168.20.1',
      '!',
      'wlan 1 STAFF LabNet',
      ' security wpa2-psk',
      ' passphrase correct horse battery',
      ' interface STAFF-IF',
      '!',
      'interface GigabitEthernet0/1',
      '!',
      'interface GigabitEthernet0/2',
      '!',
      'interface GigabitEthernet0/3',
      '!',
      'interface GigabitEthernet0/4',
      '!',
      'interface Vlan99',
      ' ip address 192.168.99.5 255.255.255.0',
      '!',
      'interface Vlan20',
      ' ip address 192.168.20.5 255.255.255.0',
      '!',
      'ip default-gateway 192.168.99.1',
      '!',
      'end',
      '',
    ].join('\n'));
    const dev = sim.device('wlc')!;
    for (const [svi, address] of [['Vlan99', '192.168.99.5'], ['Vlan20', '192.168.20.5']] as const) {
      const view = dev.portView(svi);
      expect(view?.adminUp, svi).toBe(true);
      expect(view?.l3.ipv4, svi).toEqual({ address, prefixLen: 24 });
    }
    expect((dev.tables.get<VlanRow>('vlans')?.rows() ?? []).map((v) => v.vlan).sort((a, b) => a - b)).toEqual([20, 99]);
    const read = commandCtxFor(WLC, { running: dev.running });
    expect(wlans(read.ctx)).toEqual([{ id: 1, profile: 'STAFF', ssid: 'LabNet', security: 'wpa2-psk', passphrase: true, iface: 'STAFF-IF', shutdown: false }]);
    expect(wlcInterfaces(read.ctx)).toEqual([
      { name: 'management', vlan: 99, address: '192.168.99.5', mask: MASK, gateway: '192.168.99.1' },
      { name: 'STAFF-IF', vlan: 20, address: '192.168.20.5', mask: MASK, gateway: '192.168.20.1', dhcpServer: '192.168.20.1' },
    ]);
  });

  it('moves the SVI with the VLAN, removes it with the address, and removes the default gateway with the management gateway', () => {
    const sim = world();
    expect(sim.configure('wlc', SECTION_3_12, { indentation: true }).ok).toBe(true);
    expect(configure(sim, 'wlc', ['wlc-interface STAFF-IF', 'vlan 30'])).toEqual([undefined, undefined]);
    const dev = sim.device('wlc')!;
    expect(dev.portView('Vlan20')).toBeUndefined();
    expect(dev.portView('Vlan30')?.l3.ipv4).toEqual({ address: '192.168.20.5', prefixLen: 24 });
    expect(dev.portView('Vlan30')?.adminUp).toBe(true);
    let text = running(sim, 'wlc');
    expect(text).not.toContain('interface Vlan20');
    expect(text).toContain('\ninterface Vlan30\n ip address 192.168.20.5 255.255.255.0\n!\n');
    // the VLAN list keeps VLAN 20 (these handlers never remove a VLAN) and gains VLAN 30
    expect(has(text, 'vlan 20')).toBe(true);
    expect(has(text, 'vlan 30')).toBe(true);
    expect(configure(sim, 'wlc', ['wlc-interface STAFF-IF', 'no address'])).toEqual([undefined, undefined]);
    expect(dev.portView('Vlan30')).toBeUndefined();
    text = running(sim, 'wlc');
    expect(text).toContain('\nwlc-interface STAFF-IF\n vlan 30\n gateway 192.168.20.1\n dhcp-server 192.168.20.1\n!\n');
    expect(configure(sim, 'wlc', ['wlc-interface management', 'no gateway'])).toEqual([undefined, undefined]);
    expect(has(running(sim, 'wlc'), 'ip default-gateway 192.168.99.1')).toBe(false);
    expect(dev.portView('Vlan99')?.l3.ipv4).toEqual({ address: '192.168.99.5', prefixLen: 24 });
    // a second gateway replaces the first everywhere
    expect(configure(sim, 'wlc', ['wlc-interface management', 'gateway 192.168.99.254'])).toEqual([undefined, undefined]);
    expect(has(running(sim, 'wlc'), 'ip default-gateway 192.168.99.254')).toBe(true);
  });

  it('refuses what would break the controller: removing management or an interface in use, a shared VLAN, an overlapping subnet', () => {
    const sim = world();
    expect(sim.configure('wlc', SECTION_3_12, { indentation: true }).ok).toBe(true);
    const before = running(sim, 'wlc');
    expect(configure(sim, 'wlc', ['no wlc-interface management'])).toEqual([MSG_WLC_MANAGEMENT_FIXED]);
    expect(configure(sim, 'wlc', ['no wlc-interface STAFF-IF'])).toEqual([fill(MSG_WLC_INTERFACE_IN_USE, { id: 1, name: 'STAFF-IF' })]);
    expect(configure(sim, 'wlc', ['no wlc-interface GUEST'])).toEqual([fill(MSG_WLC_NO_SUCH_INTERFACE, { name: 'GUEST' })]);
    expect(configure(sim, 'wlc', ['wlc-interface STAFF-IF', 'vlan 99'])).toEqual([undefined, fill(MSG_WLC_VLAN_TAKEN, { vlan: 99, name: 'management' })]);
    expect(configure(sim, 'wlc', ['wlc-interface STAFF-IF', `address 192.168.99.9 ${MASK}`])).toEqual([undefined, fill(MSG_WLC_SUBNET_OVERLAP, { name: 'management' })]);
    expect(configure(sim, 'wlc', ['wlc-interface GUEST', `address 192.168.20.77 255.255.0.0`])).toEqual([undefined, fill(MSG_WLC_SUBNET_OVERLAP, { name: 'management' })]);
    expect(configure(sim, 'wlc', ['wlan 1 STAFF LabNet', 'interface NOPE'])).toEqual([undefined, fill(CLI_MESSAGES.wlcInterfaceMissing, { name: 'NOPE' })]);
    expect(configure(sim, 'wlc', ['wlan 1 OTHER LabNet'])).toEqual([fill(MSG_WLAN_ID_TAKEN, { id: 1, profile: 'STAFF', ssid: 'LabNet' })]);
    expect(configure(sim, 'wlc', ['no wlan 1 OTHER LabNet'])).toEqual([fill(MSG_WLAN_WORDS_DIFFER, { id: 1, profile: 'STAFF', ssid: 'LabNet' })]);
    expect(configure(sim, 'wlc', ['no wlan 7'])).toEqual([fill(MSG_NO_SUCH_WLAN, { id: 7 })]);
    expect(configure(sim, 'wlc', ['wlan 1 STAFF LabNet', 'passphrase short'])).toEqual([undefined, MSG_BAD_WLAN_PASSPHRASE]);
    // the only change of all of that: the empty GUEST section the refused address was typed in
    expect(running(sim, 'wlc')).toBe(before.replace('!\nwlan 1 STAFF LabNet', '!\nwlc-interface GUEST\n!\nwlan 1 STAFF LabNet'));
  });

  it('WLAN lines: interface back to management, radio, shutdown; removing an unused interface removes its SVI; no wlan', () => {
    const sim = world();
    expect(sim.configure('wlc', SECTION_3_12, { indentation: true }).ok).toBe(true);
    expect(configure(sim, 'wlc', ['wlan 1 STAFF LabNet', 'radio 5', 'shutdown', 'security open', 'no passphrase'])).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(running(sim, 'wlc')).toContain('\nwlan 1 STAFF LabNet\n security open\n interface STAFF-IF\n radio 5\n shutdown\n!\n');
    expect(configure(sim, 'wlc', ['wlan 1 STAFF LabNet', 'no shutdown', 'no interface', 'interface management'])).toEqual([undefined, undefined, undefined, undefined]);
    expect(running(sim, 'wlc')).toContain('\nwlan 1 STAFF LabNet\n security open\n interface management\n radio 5\n!\n');
    // STAFF-IF is unused now: it goes, and its SVI with it (VLAN 20 stays in the VLAN list)
    expect(configure(sim, 'wlc', ['no wlc-interface STAFF-IF'])).toEqual([undefined]);
    const text = running(sim, 'wlc');
    expect(text).not.toContain('wlc-interface STAFF-IF');
    expect(text).not.toContain('interface Vlan20');
    expect(has(text, 'vlan 20')).toBe(true);
    expect(sim.device('wlc')!.portView('Vlan20')).toBeUndefined();
    expect(configure(sim, 'wlc', ['no wlan 1'])).toEqual([undefined]);
    expect(running(sim, 'wlc')).not.toContain('wlan 1');
  });

  it('survives export and reload: the saved sections and SVIs come back as they were', () => {
    const sim = world();
    expect(sim.configure('wlc', SECTION_3_12, { indentation: true }).ok).toBe(true);
    const out = sim.exportTopology();
    const again = createP2Simulation({ seed: 5, profile: 'P1', factories: { 'capwap-wtp': undefined, 'capwap-ac': undefined } });
    again.loadTopology(out);
    expect(again.profile).toBe('P2');
    again.runFor(30 * SEC);
    expect(running(again, 'wlc')).toBe(running(sim, 'wlc'));
    for (const svi of ['Vlan99', 'Vlan20']) {
      expect(again.device('wlc')!.portView(svi)?.l3.ipv4, svi).toEqual(sim.device('wlc')!.portView(svi)?.l3.ipv4);
      expect(again.device('wlc')!.portView(svi)?.adminUp, svi).toBe(true);
    }
  });
});

describe('the lightweight access point lines', () => {
  it('P2 world: `capwap enable` is replayed; controllers are added and removed; `no capwap enable` is stored explicitly and undone by `capwap enable`', () => {
    const sim = world('P2');
    expect(has(running(sim, 'ap'), 'capwap enable')).toBe(true);
    expect(configure(sim, 'ap', ['capwap controller 192.168.99.6', 'capwap controller 192.168.99.5'])).toEqual([undefined, undefined]);
    let text = running(sim, 'ap');
    expect(text).toContain('\ncapwap enable\ncapwap controller 192.168.99.6\ncapwap controller 192.168.99.5\n');
    // removing a controller that is not configured writes nothing (no stray `no capwap controller …` line)
    expect(configure(sim, 'ap', ['no capwap controller 10.9.9.9', 'no capwap controller 192.168.99.6'])).toEqual([undefined, undefined]);
    text = running(sim, 'ap');
    expect(text).not.toContain('192.168.99.6');
    expect(text).not.toContain('10.9.9.9');
    expect(has(text, 'capwap controller 192.168.99.5')).toBe(true);
    expect(configure(sim, 'ap', ['no capwap controller', 'no capwap controller'])).toEqual([undefined, undefined]);
    expect(running(sim, 'ap')).not.toContain('capwap controller');
    // completeness (D2): the reversal of the replayed default line is stored explicitly, once
    expect(configure(sim, 'ap', ['no capwap enable', 'no capwap enable'])).toEqual([undefined, undefined]);
    text = running(sim, 'ap');
    expect(text.split('\n').filter((l) => l === 'no capwap enable')).toHaveLength(1);
    expect(has(text, 'capwap enable')).toBe(false);
    expect(configure(sim, 'ap', ['capwap enable'])).toEqual([undefined]);
    text = running(sim, 'ap');
    expect(has(text, 'capwap enable')).toBe(true);
    expect(has(text, 'no capwap enable')).toBe(false);
    expect(configure(sim, 'ap', ['capwap controller 224.0.0.5', 'capwap controller 0.0.0.0'])).toEqual([MSG_BAD_CAPWAP_CONTROLLER, MSG_BAD_CAPWAP_CONTROLLER]);
  });

  it('P1 world: nothing is replayed; `capwap enable` is stored as typed and `no capwap enable` removes it without a stray negation', () => {
    const sim = world('P1');
    expect(running(sim, 'ap')).not.toContain('capwap');
    expect(configure(sim, 'ap', ['no capwap enable'])).toEqual([undefined]);
    expect(running(sim, 'ap')).not.toContain('capwap');
    expect(configure(sim, 'ap', ['capwap enable'])).toEqual([undefined]);
    expect(has(running(sim, 'ap'), 'capwap enable')).toBe(true);
    expect(configure(sim, 'ap', ['no capwap enable'])).toEqual([undefined]);
    expect(running(sim, 'ap')).not.toContain('capwap');
  });

  it('show capwap on the access point console reads the lines (no capwap row without the daemon)', () => {
    const sim = world('P2');
    const s = sim.cli.open('ap', 'console');
    expect(sim.cli.exec(s, 'show capwap').output).toBe([MSG_CAPWAP_ON, MSG_NO_CONTROLLER_LINES, MSG_NO_CONTROLLER_YET].join('\n'));
    expect(configure(sim, 'ap', ['capwap controller 192.168.99.5', 'no capwap enable'])).toEqual([undefined, undefined]);
    expect(sim.cli.exec(s, 'show capwap').output).toBe([MSG_CAPWAP_OFF, 'Controllers configured: 192.168.99.5'].join('\n'));
    // the controller has no console (shell none); a headless `do show capwap` reads its side
    expect(sim.configure('wlc', ['do show capwap']).lines[0]!.output).toBe(`${MSG_NO_ACCESS_POINTS}\n\n${MSG_NO_WIRELESS_CLIENTS}`);
  });
});

describe('show capwap against the §2.6 row shapes', () => {
  function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
    const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
    rec.extra.set(name, t as unknown as Table<TableRow>);
    return t;
  }

  it('on the access point: the controller rows, sorted by address, with the time in state', () => {
    const ast = createConfigAst();
    ast.set([], ['capwap', 'enable']);
    ast.set([], ['capwap', 'controller', '192.168.99.6']);
    ast.set([], ['capwap', 'controller', '192.168.99.5']);
    const r = commandCtxFor(AP, { mode: 'priv-exec', running: ast });
    (r.ctx as { now: number }).now = 125 * SEC;
    const t = attach<CapwapRow>(r, 'capwap');
    t.set({ key: '192.168.99.6', updatedAt: 0, controller: '192.168.99.6', state: 'discovery', since: 120 * SEC, wlans: 0 });
    t.set({ key: '192.168.99.5', updatedAt: 0, controller: '192.168.99.5', state: 'run', since: 5 * SEC, wlans: 2 });
    expect(lines(run(r, H.showCapwap).output)).toEqual([
      'CAPWAP: on',
      'Controllers configured: 192.168.99.5, 192.168.99.6',
      'Controller    State      In state for  WLANs',
      '192.168.99.5  run        00:02:00      2',
      '192.168.99.6  discovery  00:00:05      0',
    ]);
  });

  it('on the controller: the joined access points and the wireless clients (the access point by name)', () => {
    const r = commandCtxFor(WLC, { mode: 'priv-exec' });
    expect(run(r, H.showCapwap).output).toBe(`${MSG_NO_ACCESS_POINTS}\n\n${MSG_NO_WIRELESS_CLIENTS}`);
    const aps = attach<CapwapApRow>(r, 'capwap-aps');
    const clients = attach<WlanClientRow>(r, 'wlan-clients');
    aps.set({ key: '02:4e:00:30:00:00', updatedAt: 0, apMac: '02:4e:00:30:00:00', apIp: '192.168.99.21', name: 'LAP2', state: 'join', clients: 0 });
    aps.set({ key: '02:4e:00:20:00:00', updatedAt: 0, apMac: '02:4e:00:20:00:00', apIp: '192.168.99.20', name: 'LAP1', state: 'run', clients: 1 });
    clients.set({ key: '02:4e:00:40:00:07', updatedAt: 0, station: '02:4e:00:40:00:07', ap: '02:4e:00:20:00:00', bssid: '02:4e:00:20:00:02', wlanId: 1, ssid: 'LabNet', vlan: 20, iface: 'STAFF-IF', state: 'associated' });
    expect(lines(run(r, H.showCapwap).output)).toEqual([
      'Access points: 2',
      'AP name  AP MAC             AP address     State  Clients',
      'LAP1     02:4e:00:20:00:00  192.168.99.20  run    1',
      'LAP2     02:4e:00:30:00:00  192.168.99.21  join   0',
      '',
      'Wireless clients: 1',
      'Client             Access point  BSSID              WLAN  SSID    VLAN  Interface  State',
      '02:4e:00:40:00:07  LAP1          02:4e:00:20:00:02  1     LabNet  20    STAFF-IF   associated',
    ]);
  });
});

describe('original wording', () => {
  it('help, arguments and messages name no vendor', () => {
    const texts: [string, string][] = [];
    for (const s of WLC_GRAMMAR) {
      texts.push([s.path.join(' '), s.help]);
      for (const [k, a] of Object.entries(s.args ?? {})) texts.push([`${s.path.join(' ')} <${k}>`, a.help]);
    }
    for (const [k, v] of Object.entries(wlcMessages)) if (k.startsWith('MSG_') && typeof v === 'string') texts.push([k, v]);
    texts.push(['LITERAL_HELP.capwap', LITERAL_HELP['capwap'] ?? ''], ['CLI_MESSAGES.standbyNotHere', CLI_MESSAGES.standbyNotHere]);
    for (const d of DEBUG_CATEGORY_DEFS.filter((x) => x.category === 'capwap')) texts.push(['debug capwap', d.help]);
    expect(texts.length).toBeGreaterThan(50);
    for (const [where, t] of texts) expect(findBannedWords(t), where).toEqual([]);
    expect(WLC_ARG_LIMITS.managementInterface).toBe('management');
    expect(MSG_BAD_WLAN_PASSPHRASE).toContain(`${WLC_ARG_LIMITS.passphraseMin} to ${WLC_ARG_LIMITS.passphraseMax} printable characters`);
  });
});
