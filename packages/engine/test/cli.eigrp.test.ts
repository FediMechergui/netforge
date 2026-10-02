/**
 * cli.eigrp — [C1] the EIGRP configuration lines (ARCHITECTURE-P3 §2.16, §5.1, D26; §7 W2 cli, approved items):
 * grammar scope and modes, the handlers' canonical lines and refusals, the rendered `router eigrp` section, and the
 * mode walk through the runtime.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, MODES } from '../src/contracts/cli.js';
import { EIGRP_HANDLERS as H, EIGRP_MODE, MSG_DELAY_PORT } from '../src/cli/grammar/eigrp.js';
import { classfulNetwork, MSG_EIGRP_ROUTER_ID, MSG_EIGRP_WILDCARD, MSG_NO_EIGRP_PROCESS } from '../src/cli/handlers/eigrp.js';
import { modeForContextEntry } from '../src/cli/modes.js';
import { approvedCtx, approvedHarness, body, handlerOf, parse, run } from './cli.p3-approved.fixture.js';

const R = 'router.nf2911';
const EIGRP_CTX = [['router', 'eigrp', '100']];

describe('cli.eigrp grammar', () => {
  it('parses every line in its mode and scopes them to routing devices', () => {
    expect(handlerOf(R, 'config', 'router eigrp 100')).toBe(H.configRouterEigrp);
    expect(handlerOf(R, 'config', 'no router eigrp 100')).toBe(H.configRouterEigrp);
    expect(handlerOf(R, EIGRP_MODE, 'network 10.0.0.0')).toBe(H.eigrpNetwork);
    expect(handlerOf(R, EIGRP_MODE, 'network 10.1.0.0 0.0.255.255')).toBe(H.eigrpNetwork);
    expect(handlerOf(R, EIGRP_MODE, 'eigrp router-id 1.1.1.1')).toBe(H.eigrpRouterId);
    expect(handlerOf(R, EIGRP_MODE, 'passive-interface default')).toBe(H.eigrpPassiveDefault);
    expect(handlerOf(R, EIGRP_MODE, 'passive-interface g0/0')).toBe(H.eigrpPassiveInterface);
    expect(handlerOf(R, EIGRP_MODE, 'metric weights 0 1 0 1 0 0')).toBe(H.eigrpMetricWeights);
    expect(handlerOf(R, EIGRP_MODE, 'maximum-paths 2')).toBe(H.eigrpMaximumPaths);
    expect(handlerOf(R, EIGRP_MODE, 'no auto-summary')).toBe(H.eigrpAutoSummary);
    expect(handlerOf(R, 'config-if', 'delay 10', { iface: 'GigabitEthernet0/0' })).toBe(H.ifDelay);
    expect(handlerOf(R, 'config-if', 'ip hello-interval eigrp 100 2', { iface: 'GigabitEthernet0/0' })).toBe(H.ifIpHelloEigrp);
    expect(handlerOf(R, 'config-if', 'ip hold-time eigrp 100 6', { iface: 'GigabitEthernet0/0' })).toBe(H.ifIpHoldEigrp);
    // a switch without routing has no EIGRP; out-of-range values are refused by the parser
    expect(parse('switch.nfc2960', 'config', 'router eigrp 100').ok).toBe(false);
    expect(parse(R, 'config', 'router eigrp 0').ok).toBe(false);
    expect(parse(R, EIGRP_MODE, 'maximum-paths 5').ok).toBe(false);
    expect(parse(R, EIGRP_MODE, 'metric weights 1 1 0 1 0 0').ok).toBe(false);
  });

  it('offers delay on routed Ethernet and serial ports but not on a VLAN interface', () => {
    expect(parse(R, 'config-if', 'delay 2000', { iface: 'Serial0/0/0' }).ok).toBe(true);
    const svi = parse('mlswitch.nfc3650-24', 'config-if', 'delay 10', { iface: 'Vlan1' });
    expect(svi.ok).toBe(false);
    if (!svi.ok) expect(svi.error.message).toBe(MSG_DELAY_PORT);
  });

  it('enters config-router-eigrp: prompt (config-router)#, context key router eigrp, not reserved (§9.2 item 22)', () => {
    expect(MODES[EIGRP_MODE]).toMatchObject({ prompt: '(config-router)#', contextKey: 'router eigrp', parent: 'config' });
    expect(MODES[EIGRP_MODE]?.reserved).toBeUndefined();
    expect(modeForContextEntry(['router', 'eigrp', '100'])).toBe(EIGRP_MODE);
  });
});

describe('cli.eigrp handlers', () => {
  it('router eigrp stores the section, enters its mode, and keeps one process', () => {
    const r = approvedCtx(R);
    expect(run(r, H.configRouterEigrp, { as: '100' })).toEqual({});
    expect(r.enterModeCalls).toEqual([{ mode: EIGRP_MODE, opts: { context: EIGRP_CTX } }]);
    expect(run(r, H.configRouterEigrp, { as: '100' })).toEqual({});
    expect(run(r, H.configRouterEigrp, { as: '200' })).toEqual({
      error: '% This device runs one EIGRP process; autonomous system 100 is already configured. Remove it with "no router eigrp 100" first.',
    });
    expect(run(r, H.configRouterEigrp, { as: '100' }, true)).toEqual({});
    expect(body(r)).toEqual([]);
  });

  it('refuses router eigrp under no ip routing', () => {
    const r = approvedCtx(R);
    r.ctx.config(['ip', 'routing'], true, []);
    expect(run(r, H.configRouterEigrp, { as: '100' })).toEqual({ error: CLI_MESSAGES.eigrpNeedsIpRouting });
  });

  it('stores the process lines in their canonical form and renders them in the child order of §2.16', () => {
    const g = approvedCtx(R);
    run(g, H.configRouterEigrp, { as: '100' });
    const r = approvedCtx(R, { mode: EIGRP_MODE, context: EIGRP_CTX, running: g.running });
    expect(run(r, H.eigrpMaximumPaths, { paths: '2' })).toEqual({});
    expect(run(r, H.eigrpNetwork, { address: '10.1.2.3' })).toEqual({}); // classful: 10.0.0.0
    expect(run(r, H.eigrpNetwork, { address: '192.168.1.77', wildcard: '0.0.0.255' })).toEqual({}); // host bits cleared
    expect(run(r, H.eigrpNetwork, { address: '172.16.0.0', wildcard: '0.0.255.0' })).toEqual({ error: MSG_EIGRP_WILDCARD });
    expect(run(r, H.eigrpPassiveInterface, { iface: 'GigabitEthernet0/1' })).toEqual({});
    expect(run(r, H.eigrpMetricWeights, { tos: '0', k1: '1', k2: '0', k3: '1', k4: '0', k5: '0' })).toEqual({});
    expect(run(r, H.eigrpRouterId, { address: '0.0.0.0' })).toEqual({ error: MSG_EIGRP_ROUTER_ID });
    expect(run(r, H.eigrpRouterId, { address: '1.1.1.1' })).toEqual({});
    expect(run(r, H.eigrpAutoSummary, {})).toEqual({ error: CLI_MESSAGES.eigrpAutoSummary });
    expect(run(r, H.eigrpAutoSummary, {}, true)).toEqual({}); // accepted, never stored
    expect(body(r)).toEqual([
      'router eigrp 100',
      ' eigrp router-id 1.1.1.1',
      ' metric weights 0 1 0 1 0 0',
      ' network 10.0.0.0',
      ' network 192.168.1.0 0.0.0.255',
      ' passive-interface GigabitEthernet0/1',
      ' maximum-paths 2',
    ]);
    // the `no` forms remove their lines
    run(r, H.eigrpNetwork, { address: '10.0.0.0' }, true);
    run(r, H.eigrpRouterId, {}, true);
    run(r, H.eigrpMetricWeights, {}, true);
    run(r, H.eigrpMaximumPaths, {}, true);
    run(r, H.eigrpPassiveInterface, { iface: 'GigabitEthernet0/1' }, true);
    expect(body(r)).toEqual(['router eigrp 100', ' network 192.168.1.0 0.0.0.255']);
  });

  it('passive-interface default keeps exceptions as stored negations and drops them with the default', () => {
    const g = approvedCtx(R);
    run(g, H.configRouterEigrp, { as: '100' });
    const r = approvedCtx(R, { mode: EIGRP_MODE, context: EIGRP_CTX, running: g.running });
    run(r, H.eigrpPassiveDefault, {});
    run(r, H.eigrpPassiveInterface, { iface: 'GigabitEthernet0/0' }, true);
    expect(body(r)).toEqual(['router eigrp 100', ' passive-interface default', ' no passive-interface GigabitEthernet0/0']);
    // positive form under the default: the exception goes, nothing redundant is stored
    run(r, H.eigrpPassiveInterface, { iface: 'GigabitEthernet0/0' });
    expect(body(r)).toEqual(['router eigrp 100', ' passive-interface default']);
    run(r, H.eigrpPassiveInterface, { iface: 'GigabitEthernet0/1' }, true);
    run(r, H.eigrpPassiveDefault, {}, true);
    expect(body(r)).toEqual(['router eigrp 100']);
  });

  it('refuses process lines outside the section', () => {
    expect(run(approvedCtx(R), H.eigrpNetwork, { address: '10.0.0.0' })).toEqual({ error: MSG_NO_EIGRP_PROCESS });
  });

  it('writes the interface lines', () => {
    const r = approvedCtx(R, { iface: 'Serial0/0/0' });
    expect(run(r, H.ifDelay, { 'tens-of-us': '2000' })).toEqual({});
    expect(run(r, H.ifIpHelloEigrp, { as: '100', seconds: '2' })).toEqual({});
    expect(run(r, H.ifIpHoldEigrp, { as: '100', seconds: '6' })).toEqual({});
    expect(r.running.render()).toContain('interface Serial0/0/0\n delay 2000\n ip hello-interval eigrp 100 2\n ip hold-time eigrp 100 6');
    run(r, H.ifDelay, {}, true);
    run(r, H.ifIpHelloEigrp, { as: '100' }, true);
    expect(r.running.render()).toContain('interface Serial0/0/0\n ip hold-time eigrp 100 6');
    expect(run(r, H.ifIpHoldEigrp, {}, true)).toEqual({ error: '% Give the autonomous system number.' });
  });

  it('classful networks follow the address class', () => {
    expect(classfulNetwork('10.200.3.4')).toBe('10.0.0.0');
    expect(classfulNetwork('172.16.9.9')).toBe('172.16.0.0');
    expect(classfulNetwork('192.168.10.9')).toBe('192.168.10.0');
  });
});

describe('cli.eigrp through the runtime', () => {
  it('walks into config-router-eigrp with the (config-router)# prompt and back out', () => {
    const h = approvedHarness();
    h.add('d_1', 'router', 'R1');
    const s = h.cli.open('d_1', 'console');
    for (const line of ['enable', 'configure terminal']) h.cli.exec(s, line);
    const r = h.cli.exec(s, 'router eigrp 100');
    expect(r).toMatchObject({ mode: EIGRP_MODE, prompt: 'R1(config-router)#' });
    expect(h.cli.exec(s, 'network 10.0.0.0').error).toBeUndefined();
    expect(h.cli.session(s)?.context).toEqual(EIGRP_CTX);
    expect(h.cli.exec(s, 'exit')).toMatchObject({ mode: 'config', prompt: 'R1(config)#' });
    expect(h.devices.get('d_1')?.running.render()).toContain('router eigrp 100\n network 10.0.0.0');
  });
});
