/**
 * The §5.8 debug categories of the P3 MUST daemons (ARCHITECTURE-P3 §5.8 "binding across the daemon and cli seam";
 * §7 W3 cli part 2): each area grammar file declares its own categories and holds their `debug` specs (as dhcp.ts does;
 * `traffic` is composed into the `qos` fragment by the fold), the fold appends them — then the approved items' — to
 * `DEBUG_CATEGORY_DEFS`, which the `debug` handler validates against. Each category string is exactly the one its
 * daemon passes to `ctx.debug` / `ctx.transition`; each is offered where its daemon runs (capability literals); and on
 * a real P3 world `debug cdp packets` prints the cdp daemon's lines on the console, `no debug` stops them.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../src/contracts/trace.js';
import { SEC } from '../src/contracts/time.js';
import { ALL_MODELS } from '../src/device/catalog/index.js';
import { findBannedWords } from '../src/device/catalog/validate.js';
import {
  DEBUG_CATEGORIES,
  DEBUG_CATEGORY_DEFS,
  GRAMMAR,
  GRAMMAR_FRAGMENTS,
  HANDLERS,
  P2_DEBUG_CATEGORIES,
  P3_DEBUG_CATEGORIES,
  TRAFFIC_DEBUG_CATEGORIES,
} from '../src/cli/grammar/index.js';
import { P3_APPROVED_DEBUG_CATEGORIES } from '../src/cli/grammar/p3-approved.js';
import { matchCommand } from '../src/cli/parser.js';
import { ACL_DEBUG_CATEGORY } from '../src/protocols/acl.js';
import { CDP_DEBUG_EVENTS, CDP_DEBUG_PACKETS, createCdp } from '../src/protocols/cdp.js';
import { ARP_INSPECTION_DEBUG_CATEGORY } from '../src/protocols/l2/arp-inspection.js';
import { DHCP_SNOOPING_DEBUG_CATEGORY } from '../src/protocols/l2/dhcp-snooping.js';
import { LLDP_DEBUG_PACKETS } from '../src/protocols/lldp.js';
import { NTP_DEBUG_EVENTS, NTP_DEBUG_PACKETS } from '../src/protocols/ntp.js';
import { OSPF_DEBUG } from '../src/protocols/ospf.js';
import { TRAFFIC_DEBUG } from '../src/protocols/traffic.js';
import { catalogModel, matchContextFor } from './cli.p05.fixture.js';
import { output } from './sim.harness.js';
import { createStagedSimulation } from './staged.world.js';

const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const MLS = catalogModel('mlswitch.nfc3650-24');
const WLC = catalogModel('wlc.nfwlc9800');

/** §5.8 table order, the MUST rows: ospf, acl, eth-switch (snooping, DAI), cdp/lldp, ntp, restconf, traffic. */
const MUST = [
  'ip ospf adj', 'ip ospf hello', 'ip ospf flood', 'ip ospf spf', 'ip ospf packet',
  'ip access-list',
  'ip dhcp snooping', 'ip arp inspection',
  'cdp packets', 'cdp events', 'lldp packets',
  'ntp packets', 'ntp events',
  'restconf',
  'traffic',
];

/** The fragment each MUST category's `debug` spec lives in. */
const FRAGMENT_OF: Readonly<Record<string, string>> = {
  'ip ospf adj': 'ospf', 'ip ospf hello': 'ospf', 'ip ospf flood': 'ospf', 'ip ospf spf': 'ospf', 'ip ospf packet': 'ospf',
  'ip access-list': 'acl-p3',
  'ip dhcp snooping': 'hardening', 'ip arp inspection': 'hardening',
  'cdp packets': 'discovery', 'cdp events': 'discovery', 'lldp packets': 'discovery',
  'ntp packets': 'time', 'ntp events': 'time',
  restconf: 'api',
  traffic: 'qos',
};

const offered = (model: typeof ROUTER, category: string): boolean => matchCommand(GRAMMAR, matchContextFor(model, 'priv-exec'), `debug ${category}`).ok;

describe('the registry', () => {
  it('holds every §5.8 MUST category once, in the table order, after the P2 ones; then the approved items\'', () => {
    expect(P3_DEBUG_CATEGORIES.map((d) => d.category)).toEqual(MUST);
    const tail = DEBUG_CATEGORY_DEFS.slice(-(P3_DEBUG_CATEGORIES.length + P3_APPROVED_DEBUG_CATEGORIES.length));
    expect(tail).toEqual([...P3_DEBUG_CATEGORIES, ...P3_APPROVED_DEBUG_CATEGORIES]);
    const p2End = DEBUG_CATEGORY_DEFS.indexOf(P2_DEBUG_CATEGORIES[P2_DEBUG_CATEGORIES.length - 1]!);
    expect(DEBUG_CATEGORY_DEFS.indexOf(P3_DEBUG_CATEGORIES[0]!)).toBe(p2End + 1);
    expect(new Set(DEBUG_CATEGORIES).size).toBe(DEBUG_CATEGORIES.length);
    for (const c of MUST) expect(DEBUG_CATEGORIES, c).toContain(c);
  });

  it('every string is the one its daemon passes to ctx.debug / ctx.transition', () => {
    expect(MUST).toEqual([
      OSPF_DEBUG.adj, OSPF_DEBUG.hello, OSPF_DEBUG.flood, OSPF_DEBUG.spf, OSPF_DEBUG.packet,
      ACL_DEBUG_CATEGORY,
      DHCP_SNOOPING_DEBUG_CATEGORY, ARP_INSPECTION_DEBUG_CATEGORY,
      CDP_DEBUG_PACKETS, CDP_DEBUG_EVENTS, LLDP_DEBUG_PACKETS,
      NTP_DEBUG_PACKETS, NTP_DEBUG_EVENTS,
      'restconf',
      TRAFFIC_DEBUG,
    ]);
  });

  it('each has one `debug` spec in its area fragment: literal path, allowNo, its scope, since P3, original help', () => {
    for (const def of P3_DEBUG_CATEGORIES) {
      const specs = GRAMMAR.filter((s) => s.handler === HANDLERS.execDebug && s.fixedArgs?.category === def.category);
      expect(specs, def.category).toHaveLength(1);
      const s = specs[0]!;
      expect(GRAMMAR_FRAGMENTS[FRAGMENT_OF[def.category]!], def.category).toContain(s);
      expect(s.path).toEqual(['debug', ...def.category.split(' ')]);
      expect(s.mode).toBe('priv-exec');
      expect(s.allowNo).toBe(true);
      expect(s.requiresAny).toEqual(def.requiresAny);
      expect(def.since).toBe('P3');
      expect(s.since).toBe('P3');
      expect(def.help.length).toBeGreaterThan(0);
      expect(findBannedWords(def.help), def.category).toEqual([]);
    }
  });
});

describe('scope (capability literals: offered where the daemon runs)', () => {
  it('OSPF on routing devices, access-layer checks on managed switches, ACLs on both', () => {
    for (const c of ['ip ospf adj', 'ip ospf packet']) {
      expect(offered(ROUTER, c), c).toBe(true);
      expect(offered(MLS, c), c).toBe(true);
      expect(offered(SWITCH, c), c).toBe(false);
    }
    for (const c of ['ip dhcp snooping', 'ip arp inspection']) {
      expect(offered(SWITCH, c), c).toBe(true);
      expect(offered(ROUTER, c), c).toBe(false);
      expect(offered(WLC, c), c).toBe(false);
    }
    expect(offered(ROUTER, 'ip access-list')).toBe(true);
    expect(offered(SWITCH, 'ip access-list')).toBe(true);
  });

  it('CDP and NTP on routers, switches and the controller; LLDP and the API on routers and switches', () => {
    for (const c of ['cdp packets', 'cdp events', 'ntp packets', 'ntp events']) {
      for (const m of [ROUTER, SWITCH, WLC]) expect(offered(m, c), `${c} on ${m.type}`).toBe(true);
    }
    for (const c of ['lldp packets', 'restconf']) {
      expect(offered(ROUTER, c), c).toBe(true);
      expect(offered(SWITCH, c), c).toBe(true);
      expect(offered(WLC, c), c).toBe(false);
    }
  });

  it('traffic is registered but offered on no model: the traffic daemon runs on hosts, whose shell has no debug', () => {
    expect(TRAFFIC_DEBUG_CATEGORIES.map((d) => d.requiresAny)).toEqual([['host']]);
    for (const model of ALL_MODELS) {
      if (model.cli === undefined) continue;
      const mode = model.cli.grammar === 'host' ? 'user-exec' : 'priv-exec';
      expect(matchCommand(GRAMMAR, matchContextFor(model, mode), 'debug traffic').ok, model.type).toBe(false);
    }
  });
});

describe('on a real P3 world', () => {
  it('debug cdp packets prints the cdp daemon\'s lines on the console; no debug stops them; debug ip ospf adj is accepted', () => {
    const sim = createStagedSimulation({ seed: 11, stage: 'P3', factories: { cdp: createCdp } });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: 'hostname R1\n!\ninterface GigabitEthernet0/0\n no shutdown\n!\nend\n' });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: 'hostname SW1\n!\nend\n' });
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
    sim.runFor(60 * SEC);
    const s = sim.cli.open('r1', 'console');
    sim.cli.exec(s, 'enable');
    expect(sim.cli.exec(s, 'debug cdp packets').output).toBe('Debugging enabled for cdp packets.');
    expect(sim.cli.exec(s, 'debug ip ospf adj').output).toBe('Debugging enabled for ip ospf adj.');
    let cursor = sim.trace(0).next;
    sim.runFor(130 * SEC);
    const on = output(sim.trace(cursor).events as TraceEvent[], s);
    expect(on).toContain('sent CDP v2 on GigabitEthernet0/0, holdtime 180 s');
    expect(on).toMatch(/received CDP v2 from SW1 on GigabitEthernet0\/0/);
    expect(sim.cli.exec(s, 'no debug cdp packets').output).toBe('Debugging disabled for cdp packets.');
    cursor = sim.trace(0).next;
    sim.runFor(130 * SEC);
    expect(output(sim.trace(cursor).events as TraceEvent[], s)).not.toContain('CDP v2');
  });
});
