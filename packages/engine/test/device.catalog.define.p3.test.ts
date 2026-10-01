/**
 * device.catalog.define.p3 — `cdpDefault` by the D2 rule (ARCHITECTURE-P3 D2, §2.1; §7 W1 catalog): with
 * `defineModel(…, 'P3')` the routers, managed and multilayer switches with a CLI and the controller carry
 * `cdpDefault: true`; the lightweight AP, home routers and hosts do not carry the key at all; and no model defined at
 * stage P2 or earlier carries it (every P0.5–P2-stage model keeps exactly its keys, §9.1).
 */
import { describe, expect, it } from 'vitest';
import { BUILD_STAGES, expandCapabilities } from '../src/contracts/catalog.js';
import { ALL_MODEL_INPUTS } from '../src/device/catalog.js';
import { defineModel, deriveCdpDefault, deriveCliSpec, type ModelInput } from '../src/device/catalog/define.js';

const input = (type: string): ModelInput => {
  const found = ALL_MODEL_INPUTS.find((i) => i.type === type);
  if (found === undefined) throw new Error(`no input ${type}`);
  return found;
};

describe('cdpDefault (D2)', () => {
  it('true for NF-2911, NF-C2960, NF-C3650-24 and NF-WLC-9800 at stage P3', () => {
    for (const type of ['router.nf2911', 'switch.nfc2960', 'mlswitch.nfc3650-24', 'wlc.nfwlc9800']) {
      const m = defineModel(input(type), 'P3');
      expect([type, m.cdpDefault]).toEqual([type, true]);
    }
  });

  it('absent for NF-AP-1832, the home routers and a PC at stage P3', () => {
    for (const type of ['ap.nfap-lw', 'wrouter.nfhome', 'wrouter.nfhome-ax', 'pc.nfpc']) {
      const m = defineModel(input(type), 'P3');
      expect([type, 'cdpDefault' in m]).toEqual([type, false]);
    }
    expect(defineModel(input('ap.nfap-lw'), 'P3').model).toBe('NF-AP-1832');
  });

  it('every model follows the rule at P3, and no model carries the key at an earlier stage', () => {
    for (const i of ALL_MODEL_INPUTS) {
      const p3 = defineModel(i, 'P3');
      const caps = p3.capabilities;
      const has = (c: (typeof caps)[number]): boolean => caps.includes(c);
      const want = !has('nat-gateway') && ((p3.cli.shell === 'nfos' && (has('routing') || has('managed-switch'))) || has('wireless-controller'));
      expect([i.type, p3.cdpDefault === true]).toEqual([i.type, want]);
      if (!want) expect([i.type, 'cdpDefault' in p3]).toEqual([i.type, false]);
      for (const stage of BUILD_STAGES.filter((s) => s !== 'P3')) {
        expect([i.type, stage, 'cdpDefault' in defineModel(i, stage)]).toEqual([i.type, stage, false]);
      }
    }
  });

  it('deriveCdpDefault is the D2 rule over expanded capabilities and the CLI shell', () => {
    const rule = (caps: Parameters<typeof expandCapabilities>[0]): boolean => {
      const e = expandCapabilities(caps);
      return deriveCdpDefault(e, deriveCliSpec(e));
    };
    expect(rule(['routing'])).toBe(true);
    expect(rule(['layer3-switch', 'managed-switch'])).toBe(true);
    expect(rule(['switching', 'managed-switch'])).toBe(true);
    expect(rule(['wireless-controller'])).toBe(true);
    expect(rule(['firewall'])).toBe(true);
    expect(rule(['switching'])).toBe(false); // an unmanaged switch
    expect(rule(['wifi-ap', 'lightweight-ap'])).toBe(false);
    expect(rule(['wifi-ap', 'switching', 'routing', 'dhcp-server', 'nat-gateway'])).toBe(false);
    expect(rule(['host'])).toBe(false);
    expect(rule(['server'])).toBe(false);
    expect(rule(['modem'])).toBe(false);
    // a routing model without an NFOS shell (a GUI appliance) does not run it by default
    expect(deriveCdpDefault(expandCapabilities(['routing']), { shell: 'none' })).toBe(false);
    expect(deriveCdpDefault(expandCapabilities(['wireless-controller']), { shell: 'none' })).toBe(true);
    expect(deriveCdpDefault(expandCapabilities(['routing', 'nat-gateway', 'wireless-controller']), { shell: 'nfos' })).toBe(false);
  });

  it('the models defined at P3 stay deeply frozen', () => {
    const m = defineModel(input('router.nf2911'), 'P3');
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as { cdpDefault?: true }).cdpDefault = undefined as unknown as true;
    }).toThrow();
  });
});
