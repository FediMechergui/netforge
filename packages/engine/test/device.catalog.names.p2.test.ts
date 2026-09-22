/**
 * W1 catalog (ARCHITECTURE-P2 §3.4, §7 W1, D10, D11): the P2 additions of device/catalog/names.ts — hyphenated
 * families (`Port-channel1`, `po1`, `port-channel 1`) and subinterface resolution (`g0/0.10` →
 * `{kind:'virtual', family:'subinterface', parent}`). The P1 resolution rules are pinned unchanged by
 * device.catalog.names.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { VirtualFamilySpec } from '../src/contracts/catalog.js';
import type { DeviceModel, PortNameSource } from '../src/contracts/device.js';
import type { PortId } from '../src/contracts/ids.js';
import type { PortSpec } from '../src/contracts/port.js';
import { SPEED_1G } from '../src/contracts/port.js';
import { defineModel } from '../src/device/catalog/define.js';
import { parseSubinterfaceName, resolvePortName, shortPortName, splitPortName, subinterfacePortName, SUBINTERFACE_FAMILY } from '../src/device/catalog/names.js';
import { createPortState, createSubinterfacePortState, fixedPortStates } from '../src/device/ports.js';
import { NF_2911_INPUT, NF_C2960_INPUT, ethInput } from './device.catalog.p0-inputs.js';

const router = defineModel(NF_2911_INPUT, 'P2');
const switchModel = defineModel({ ...NF_C2960_INPUT, capabilities: ['switching', 'managed-switch'] }, 'P2');
const p1Router = defineModel(NF_2911_INPUT, 'P1');

/** A live source: the model's fixed ports (plus anything extra), in Map order. */
function sourceOf(model: DeviceModel, extra: readonly { id: PortId; spec: PortSpec }[] = []): PortNameSource {
  const ports = new Map<PortId, { spec: PortSpec }>();
  for (const p of fixedPortStates(model, { macBase: 1, capabilities: model.capabilities, portsDefaultUp: true })) ports.set(p.id, { spec: p.spec });
  for (const e of extra) ports.set(e.id, { spec: e.spec });
  return { model, ports };
}

describe('hyphenated virtual families (D10)', () => {
  const family = (switchModel.virtualFamilies ?? []).find((f) => f.family === 'Port-channel') as VirtualFamilySpec;

  it('resolves Port-channel1, po1 and port-channel 1 to the same creatable interface', () => {
    expect(family).toMatchObject({ family: 'Port-channel', short: 'Po', role: 'channel', min: 1, max: 48 });
    const source = sourceOf(switchModel);
    for (const typed of ['Port-channel1', 'port-channel1', 'port-channel 1', 'po1', 'Po 1', 'PORT-CHANNEL1']) {
      expect(resolvePortName(source, typed)).toEqual({ kind: 'virtual', port: 'Port-channel1', family: 'Port-channel' });
    }
    // a prefix of the long family still resolves
    expect(resolvePortName(source, 'port 2')).toEqual({ kind: 'virtual', port: 'Port-channel2', family: 'Port-channel' });
    // outside the range, and on a model without the family
    expect(resolvePortName(source, 'po49')).toEqual({ kind: 'unknown' });
    expect(resolvePortName(sourceOf(p1Router), 'po1')).toEqual({ kind: 'unknown' });
  });

  it('finds an existing Port-channel by its long and short name', () => {
    const po1 = createPortState(
      { name: 'Port-channel1', short: 'Po1', kind: 'virtual', speedBps: SPEED_1G, role: 'channel', allowedRoles: ['channel'], encap: 'ethernet', ordinal: 0, connector: 'none' },
      0,
      { macBase: 1, capabilities: switchModel.capabilities, portsDefaultUp: true },
    );
    const source = sourceOf(switchModel, [{ id: po1.id, spec: po1.spec }]);
    expect(resolvePortName(source, 'po1')).toEqual({ kind: 'existing', port: 'Port-channel1' });
    expect(resolvePortName(source, 'Port-channel 1')).toEqual({ kind: 'existing', port: 'Port-channel1' });
    expect(splitPortName('Port-channel12')).toEqual({ family: 'Port-channel', number: '12' });
    // PORT_FAMILIES has no Port-channel entry, so the short name comes from the family spec, not from shortPortName
    expect(shortPortName('Port-channel1')).toBeUndefined();
  });
});

describe('subinterface names (D11)', () => {
  const source = sourceOf(router);

  it('resolves <parent>.<n> against the live ports of a model that supports subinterfaces', () => {
    expect(resolvePortName(source, 'g0/0.10')).toEqual({
      kind: 'virtual',
      port: 'GigabitEthernet0/0.10',
      family: SUBINTERFACE_FAMILY,
      parent: 'GigabitEthernet0/0',
    });
    expect(SUBINTERFACE_FAMILY).toBe('subinterface');
    expect(resolvePortName(source, 'GigabitEthernet0/1.4094')).toMatchObject({ kind: 'virtual', port: 'GigabitEthernet0/1.4094', parent: 'GigabitEthernet0/1' });
    // leading zeros are dropped, as for every virtual instance number
    expect(resolvePortName(source, 'gi 0/0.010')).toMatchObject({ kind: 'virtual', port: 'GigabitEthernet0/0.10' });
    // a serial parent resolves by name here; whether it may carry subinterfaces is decided at creation
    expect(resolvePortName(source, 's0/0/0.1')).toMatchObject({ kind: 'virtual', port: 'Serial0/0/0.1', parent: 'Serial0/0/0' });
  });

  it('finds an existing subinterface and refuses what cannot be one', () => {
    const parent = fixedPortStates(router, { macBase: 1, capabilities: router.capabilities, portsDefaultUp: true })[0];
    const subif = createSubinterfacePortState(parent as never, 10);
    const live = sourceOf(router, [{ id: subif.id, spec: subif.spec }]);
    expect(resolvePortName(live, 'g0/0.10')).toEqual({ kind: 'existing', port: 'GigabitEthernet0/0.10' });
    expect(resolvePortName(live, 'GigabitEthernet0/0.10')).toEqual({ kind: 'existing', port: 'GigabitEthernet0/0.10' });

    expect(resolvePortName(source, 'g0/9.10')).toEqual({ kind: 'unknown' }); // no such parent
    expect(resolvePortName(source, 'g0/0.0')).toEqual({ kind: 'unknown' }); // subinterface 0
    expect(resolvePortName(source, 'g0/0.65536')).toEqual({ kind: 'unknown' }); // above the model's max
    expect(resolvePortName(source, 'g0/0.10.5')).toEqual({ kind: 'unknown' }); // a subinterface of a subinterface
    expect(resolvePortName(source, 'g0/0.')).toEqual({ kind: 'unknown' });
    expect(resolvePortName(source, 'lo0.1')).toEqual({ kind: 'unknown' }); // not on a virtual interface
    // a model without subinterface support (P1 stage, or a switch)
    expect(resolvePortName(sourceOf(p1Router), 'g0/0.10')).toEqual({ kind: 'unknown' });
    expect(p1Router.subinterfaces).toBeUndefined();
    expect(resolvePortName(sourceOf(switchModel), 'fa0/1.10')).toEqual({ kind: 'unknown' });
  });

  it('parseSubinterfaceName and subinterfacePortName are inverse', () => {
    expect(subinterfacePortName('GigabitEthernet0/0', 10)).toBe('GigabitEthernet0/0.10');
    expect(parseSubinterfaceName('GigabitEthernet0/0.10')).toEqual({ parent: 'GigabitEthernet0/0', number: 10 });
    expect(parseSubinterfaceName('GigabitEthernet0/0')).toBeUndefined();
    expect(parseSubinterfaceName('GigabitEthernet0/0.10.5')).toBeUndefined();
    expect(parseSubinterfaceName('GigabitEthernet0/0.x')).toBeUndefined();
  });

  it('ambiguous parents give ambiguous subinterfaces', () => {
    const model = defineModel(
      {
        type: 'router.nft2',
        model: 'NF-T2',
        description: 'Two families that share a number',
        category: 'routers',
        icon: 'router',
        capabilities: ['routing'],
        ports: [ethInput('FastEthernet0', SPEED_1G, false), ethInput('FortyGigabitEthernet0', SPEED_1G, false)],
      },
      'P2',
    );
    expect(resolvePortName(sourceOf(model), 'f0.10')).toEqual({ kind: 'ambiguous', candidates: ['FastEthernet0.10', 'FortyGigabitEthernet0.10'] });
  });
});
