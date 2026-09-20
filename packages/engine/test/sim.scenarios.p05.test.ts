/**
 * sim/scenarios.ts P0.5 templates (ARCHITECTURE-P1 §8.1 W5): every template validates against the real catalog
 * (validateTopologyAgainstCatalog and the atomic load gate), uses only known config lines, valid cables and in-range
 * radios, and the three P0 templates keep their exact entries.
 */
import { describe, expect, it } from 'vitest';
import { SCENARIOS, TEMPLATES, HOME_WIFI_LAPTOP_UNITS, HOME_WIFI_PASSPHRASE, HOME_WIFI_SSID, RADIO_BRIDGE_DISTANCE_M, RADIO_BRIDGE_PEER_KEY, SERIAL_PAIR_CLOCK_RATE_BPS, pcRouterPc, threeRouters, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { prepareTopologyLoad, validateTopologyAgainstCatalog } from '../src/io/schema.js';
import { walkConfigText } from '../src/cli/config-text.js';
import { DEFAULT_CONFIG_RULES } from '../src/cli/config-rules.js';
import { checkCable } from '../src/link/cabling.js';
import { DEFAULT_METRES_PER_UNIT, type Topology, type TopologyDevice } from '../src/contracts/topology.js';
import type { PortSpec } from '../src/contracts/port.js';
import { scenarioMeta } from '../src/contracts/scenario.js';

const catalog = createCatalog(PROCESS_FACTORIES);

const P0_NAMES = ['two-pcs-and-switch', 'pc-router-pc', 'three-routers'];
const P05_NAMES = ['home-wifi', 'hub-collision', 'serial-pair', 'multilayer-routed-port', 'radio-bridge', 'cellular-phones'];

function scenario(name: string): Topology {
  const s = SCENARIOS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no scenario ${name}`);
  return s.build();
}

function dev(t: Topology, id: string): TopologyDevice {
  const d = t.devices.find((x) => x.id === id);
  if (d === undefined) throw new Error(`no device ${id}`);
  return d;
}

function portSpec(t: Topology, ref: { device: string; port: string }): PortSpec {
  const model = catalog.get(dev(t, ref.device).type);
  const spec = model?.ports.find((p) => p.name === ref.port);
  if (spec === undefined) throw new Error(`no port ${ref.device}/${ref.port}`);
  return spec;
}

/** Interface-section child lines of a device config (`interface <port>` → its indented lines). */
function interfaceLines(d: TopologyDevice, port: string): string[] {
  return walkConfigText(d.config ?? '')
    .filter((l) => l.context.length === 1 && l.context[0]?.[0] === 'interface' && l.context[0]?.[1] === port)
    .map((l) => (l.negate ? ['no', ...l.tokens] : l.tokens).join(' '));
}

describe('scenario templates (P0.5)', () => {
  it('lists the three P0 templates first, unchanged, then the six P0.5 templates', () => {
    // §9.2 "sim (P1 W6)": SCENARIOS gains the CCNA 1 labs after the templates, so the exact list is pinned on
    // TEMPLATES and SCENARIOS is only required to start with them, unchanged and in order.
    expect(TEMPLATES.map((s) => s.name)).toEqual([...P0_NAMES, ...P05_NAMES]);
    expect(SCENARIOS.slice(0, TEMPLATES.length)).toEqual(TEMPLATES);
    expect(SCENARIOS.slice(0, 3).map((s) => Object.keys(s))).toEqual([0, 1, 2].map(() => ['name', 'category', 'title', 'description', 'build']));
    expect(SCENARIOS[0]!.build).toBe(twoPcsAndSwitch);
    expect(SCENARIOS[1]!.build).toBe(pcRouterPc);
    expect(SCENARIOS[2]!.build).toBe(threeRouters);
    expect(scenario('two-pcs-and-switch').devices.map((d) => d.type)).toEqual(['pc.nfpc', 'switch.nfc2960', 'pc.nfpc']);
    for (const s of TEMPLATES) {
      expect(s.category).toBe('template');
      expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  for (const s of SCENARIOS) {
    describe(s.name, () => {
      it('validates against the catalog and passes the atomic load gate', () => {
        const t = s.build();
        expect(validateTopologyAgainstCatalog(t, catalog)).toEqual([]);
        expect(() => prepareTopologyLoad(JSON.parse(JSON.stringify(t)) as unknown, catalog)).not.toThrow();
      });

      it('builds a fresh, structured-clone safe topology each time', () => {
        const a = s.build();
        const b = s.build();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
        expect(structuredClone(scenarioMeta(s))).toEqual(scenarioMeta(s));
        expect(new Set(a.devices.map((d) => d.id)).size).toBe(a.devices.length);
        expect(new Set(a.devices.map((d) => d.name)).size).toBe(a.devices.length);
        expect(new Set(a.links.map((l) => l.id)).size).toBe(a.links.length);
      });

      it('uses only config lines the config rules recognize', () => {
        for (const d of s.build().devices) {
          for (const line of walkConfigText(d.config ?? '')) {
            expect(DEFAULT_CONFIG_RULES.ruleFor(line.context, line.tokens), `${d.id} line ${line.lineNo}: ${line.tokens.join(' ')}`).toBeDefined();
          }
        }
      });

      it('uses valid cables and pairings', () => {
        const t = s.build();
        for (const l of t.links) {
          const a = { ...portSpec(t, l.a), device: l.a.device, label: `${l.a.device} ${l.a.port}` };
          const b = { ...portSpec(t, l.b), device: l.b.device, label: `${l.b.device} ${l.b.port}` };
          const opts = l.kind === undefined ? {} : { kind: l.kind };
          const check = checkCable(a, b, l.media, l.distance_m ?? l.length_m ?? 0, opts);
          expect(check, `${l.id}: ${check.reason ?? ''}`).toMatchObject({ ok: true });
        }
      });

      if (P05_NAMES.includes(s.name)) {
        it('declares exactly the catalog types it uses in requires', () => {
          const types = [...new Set(s.build().devices.map((d) => d.type))];
          expect([...(s.requires ?? [])].sort()).toEqual(types.sort());
          for (const type of s.requires ?? []) expect(catalog.get(type), type).toBeDefined();
        });
      }
    });
  }

  it('home-wifi: the router and the laptop share network LAB 40 m apart', () => {
    const t = scenario('home-wifi');
    const home = dev(t, 'home1');
    const laptop = dev(t, 'laptop1');
    const wifi = [`ssid ${HOME_WIFI_SSID}`, 'security wpa2-psk', `passphrase ${HOME_WIFI_PASSPHRASE}`];
    expect(interfaceLines(home, 'Wlan0')).toEqual(wifi);
    expect(interfaceLines(laptop, 'Wlan0')).toEqual(['ip address 192.168.1.20 255.255.255.0', ...wifi]);
    expect(interfaceLines(home, 'Vlan1')).toEqual(['ip address 192.168.1.1 255.255.255.0']);
    const [hx, hy] = home.position.logical;
    const [lx, ly] = laptop.position.logical;
    expect(Math.hypot(lx - hx, ly - hy)).toBe(HOME_WIFI_LAPTOP_UNITS);
    expect(HOME_WIFI_LAPTOP_UNITS * DEFAULT_METRES_PER_UNIT).toBe(40);
    expect(t.canvas).toBeUndefined();
    expect(portSpec(t, { device: 'laptop1', port: 'Wlan0' }).radio!.maxRangeM).toBeGreaterThanOrEqual(40);
  });

  it('hub-collision: three PCs on hub repeater ports', () => {
    const t = scenario('hub-collision');
    expect(t.links.map((l) => `${l.b.device}/${l.b.port}`)).toEqual(['hub1/Ethernet0', 'hub1/Ethernet1', 'hub1/Ethernet2']);
    expect(t.devices.filter((d) => d.type === 'pc.nfpc')).toHaveLength(3);
    expect(dev(t, 'hub1').config).toBeUndefined();
  });

  it('serial-pair: the DCE end of the serial cable sets the clock rate, the DTE end does not', () => {
    const t = scenario('serial-pair');
    const serial = t.links.find((l) => l.id === 'l_r1_r2')!;
    expect(serial).toMatchObject({ media: 'serial-dce', a: { device: 'r1', port: 'Serial0/0/0' }, b: { device: 'r2', port: 'Serial0/0/0' } });
    expect(interfaceLines(dev(t, 'r1'), 'Serial0/0/0')).toContain(`clock rate ${SERIAL_PAIR_CLOCK_RATE_BPS}`);
    expect(interfaceLines(dev(t, 'r2'), 'Serial0/0/0').some((l) => l.startsWith('clock'))).toBe(false);
  });

  it('multilayer-routed-port: Gi1/0/24 is routed with an address, the loopback is addressed, PCs stay on switchports', () => {
    const t = scenario('multilayer-routed-port');
    const mls = dev(t, 'mls1');
    expect(interfaceLines(mls, 'GigabitEthernet1/0/24')).toEqual(['no switchport', 'ip address 10.1.1.1 255.255.255.0']);
    expect(interfaceLines(mls, 'Loopback0')).toEqual(['ip address 10.9.9.1 255.255.255.255']);
    const spec = portSpec(t, { device: 'mls1', port: 'GigabitEthernet1/0/24' });
    expect(spec.allowedRoles ?? []).toContain('routed');
    expect(t.links.filter((l) => l.b.device === 'mls1').map((l) => l.b.port)).toEqual(['GigabitEthernet1/0/1', 'GigabitEthernet1/0/2']);
  });

  it('radio-bridge: one radio pairing 10 km long with matching channel and key, within both radios range', () => {
    const t = scenario('radio-bridge');
    const radios = t.links.filter((l) => l.kind === 'radio');
    expect(radios).toEqual([{ id: 'l_radio1_radio2', a: { device: 'radio1', port: 'Radio0' }, b: { device: 'radio2', port: 'Radio0' }, media: 'radio', kind: 'radio', distance_m: RADIO_BRIDGE_DISTANCE_M }]);
    expect(interfaceLines(dev(t, 'radio1'), 'Radio0')).toEqual(interfaceLines(dev(t, 'radio2'), 'Radio0'));
    expect(interfaceLines(dev(t, 'radio1'), 'Radio0')).toContain(`peer-key ${RADIO_BRIDGE_PEER_KEY}`);
    expect(portSpec(t, radios[0]!.a).radio!.maxRangeM).toBeGreaterThanOrEqual(RADIO_BRIDGE_DISTANCE_M);
  });

  it('cellular-phones: both phones are addressed on Cellular0 and within tower range', () => {
    const t = scenario('cellular-phones');
    const tower = dev(t, 'tower1');
    const range = portSpec(t, { device: 'tower1', port: 'Cellular0' }).radio!.maxRangeM;
    for (const id of ['phone1', 'phone2']) {
      const phone = dev(t, id);
      expect(interfaceLines(phone, 'Cellular0')).toHaveLength(1);
      const [px, py] = phone.position.logical;
      const [tx, ty] = tower.position.logical;
      expect(Math.hypot(px - tx, py - ty) * DEFAULT_METRES_PER_UNIT).toBeLessThanOrEqual(range);
    }
    expect(t.links).toHaveLength(1);
    expect(t.links[0]).toMatchObject({ a: { device: 'srv1', port: 'GigabitEthernet0' }, b: { device: 'tower1', port: 'GigabitEthernet0' } });
  });
});
