import { describe, expect, it } from 'vitest';
import { defineModel, defineModule, type ModelInput } from '../src/device/catalog/define.js';
import {
  BANNED_VENDOR_WORDS,
  CATALOG_ISSUE_CODES,
  findBannedWords,
  formatCatalogIssues,
  jsonCloneProblem,
  validateCatalog,
  type CatalogIssueCode,
} from '../src/device/catalog/validate.js';
import { ROUTER_IP_DEFAULTS, type ModuleModel } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortSpec } from '../src/contracts/port.js';
import { ethInput, ethRangeInput } from './device.catalog.p0-inputs.js';

const RADIO_24 = {
  bands: ['2.4'],
  generations: ['n'],
  defaultBand: '2.4',
  defaultChannel: 6,
  maxTxPowerDbm: 20,
  antennaGainDbi: 2,
  streams: 2,
  maxWidthMhz: 40,
  maxRangeM: 100,
  maxBss: 1,
  maxClients: 32,
} as const;

const ROUTER_INPUT: ModelInput = {
  type: 'router.tv1941',
  model: 'NF-TV1941',
  description: 'Small modular test router',
  category: 'routers',
  icon: 'router-modular',
  capabilities: ['routing', 'modular'],
  ports: [
    ...ethRangeInput('GigabitEthernet', '0', 0, 2, 1_000_000_000, false),
    { name: 'Console', kind: 'console', speedBps: 9_600 },
    { name: 'Aux', kind: 'console', speedBps: 9_600 },
  ],
  slots: [
    { id: '0/0', label: 'Interface card slot 0', type: 'ehwic', numbering: '0/0' },
    { id: '0/1', label: 'Interface card slot 1', type: 'ehwic', numbering: '0/1', defaultModule: 'mod.tv-ehwic-2t' },
  ],
};

const INPUTS: readonly ModelInput[] = [
  ROUTER_INPUT,
  {
    type: 'mlswitch.tv3650',
    model: 'NF-TV3650',
    description: 'Multilayer test switch',
    category: 'multilayer-switches',
    icon: 'mlswitch',
    capabilities: ['layer3-switch'],
    ports: [...ethRangeInput('GigabitEthernet', '1/0', 1, 4, 1_000_000_000, true), { ...ethInput('GigabitEthernet1/1/1', 1_000_000_000, false), connector: 'sfp' }],
    slots: [{ id: 'sfp0', label: 'Transceiver cage 1', type: 'sfp', numbering: '', cage: 'GigabitEthernet1/1/1' }],
  },
  {
    type: 'wrouter.tvhome',
    model: 'NF-TVHOME',
    description: 'Home wireless test router',
    category: 'home-soho',
    icon: 'home-router',
    tags: ['home', 'wifi'],
    capabilities: ['wifi-ap', 'switching', 'routing', 'dhcp-server', 'nat-gateway'],
    ports: [
      { ...ethInput('Internet', 1_000_000_000, false), role: 'wan' },
      ethInput('GigabitEthernet1', 1_000_000_000, true),
      ethInput('GigabitEthernet2', 1_000_000_000, true),
      { name: 'Wlan0', kind: 'wlan', speedBps: 300_000_000, radio: RADIO_24 },
    ],
  },
  {
    type: 'laptop.tvlaptop',
    model: 'NF-TVLAPTOP',
    description: 'Test laptop',
    category: 'computers',
    icon: 'laptop',
    capabilities: ['host', 'wifi-client'],
    ports: [ethInput('GigabitEthernet0', 1_000_000_000, true), { name: 'Wlan0', kind: 'wlan', speedBps: 300_000_000, radio: { ...RADIO_24, maxBss: undefined, maxClients: undefined } }],
  },
  {
    type: 'pc.tvexp',
    model: 'NF-TVEXP',
    description: 'Workstation with an expansion bay',
    category: 'computers',
    icon: 'pc',
    capabilities: ['host'],
    ports: [ethInput('GigabitEthernet0', 1_000_000_000, false)],
    slots: [{ id: 'exp0', label: 'Expansion bay', type: 'host-expansion', numbering: '' }],
  },
  {
    type: 'hub.tvhub4',
    model: 'NF-TVHUB4',
    description: 'Four-port test hub',
    category: 'legacy',
    icon: 'hub',
    capabilities: ['repeater'],
    ports: [0, 1, 2, 3].map((i) => ({ name: `Ethernet${i}`, kind: 'ethernet' as const, speedBps: 10_000_000, speeds: [10_000_000], autoMdix: false })),
  },
  {
    type: 'switch.tvpoe',
    model: 'NF-TVPOE',
    description: 'PoE test switch',
    category: 'switches',
    icon: 'switch-poe',
    capabilities: ['switching', 'poe-source'],
    poeBudgetW: 370,
    ports: ethRangeInput('GigabitEthernet', '0', 1, 2, 1_000_000_000, true).map((p) => ({ ...p, poe: { pse: { standard: 'at' as const, maxW: 30 } } })),
  },
  {
    type: 'ap.tvap',
    model: 'NF-TVAP',
    description: 'Powered test access point',
    category: 'wireless',
    icon: 'ap',
    capabilities: ['wifi-ap', 'poe-powered'],
    ports: [{ ...ethInput('GigabitEthernet0', 1_000_000_000, true), poe: { pd: { standard: 'at', drawW: 15 } } }, { name: 'Wlan0', kind: 'wlan', speedBps: 300_000_000, radio: RADIO_24 }],
  },
];

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const MODULES: readonly ModuleModel[] = [
  defineModule({ type: 'mod.tv-ehwic-2t', model: 'NF-TV-EHWIC-2T', description: 'Two serial ports', fits: 'ehwic', ports: [{ family: 'Serial', count: 2, spec: { kind: 'serial', speedBps: 2_000_000 } }] }),
  defineModule({ type: 'mod.tv-nim-2t', model: 'NF-TV-NIM-2T', description: 'Two serial ports for module slots', fits: 'nim', ports: [{ family: 'Serial', count: 2, spec: { kind: 'serial', speedBps: 2_000_000 } }] }),
  defineModule({ type: 'mod.tv-sfp-sx', model: 'NF-TV-SFP-SX', description: 'Short-range fibre transceiver', fits: 'sfp', ports: [], transceiver: { connector: 'lc', mode: 'mm', speedBps: 1_000_000_000, maxLengthM: 550, wavelengthNm: 850 } }),
  defineModule({
    type: 'mod.tv-wlan',
    model: 'NF-TV-WLAN',
    description: 'Wireless expansion card',
    fits: 'host-expansion',
    ports: [{ family: 'Wlan', count: 1, absolute: true, spec: { kind: 'wlan', speedBps: 300_000_000, radio: stripUndefined({ ...RADIO_24, maxBss: undefined, maxClients: undefined }) } }],
    capabilitiesAdded: ['wifi-client'],
  }),
];

// Models are derived against the same module list they are validated with (define.ts `defineModel` modules).
const MODELS: readonly DeviceModel[] = INPUTS.map((i) => defineModel(stripUndefined(i), 'P0.5', MODULES));

interface Cat {
  models: DeviceModel[];
  modules: ModuleModel[];
}

const base = (): Cat => ({ models: [...MODELS], modules: [...MODULES] });

function withModel(type: string, patch: (m: DeviceModel) => DeviceModel): Cat {
  const cat = base();
  cat.models = cat.models.map((m) => (m.type === type ? patch(m) : m));
  return cat;
}

function withPort(type: string, index: number, patch: Partial<PortSpec> | ((p: PortSpec) => PortSpec)): Cat {
  return withModel(type, (m) => ({ ...m, ports: m.ports.map((p, i) => (i !== index ? p : typeof patch === 'function' ? patch(p) : { ...p, ...patch })) }));
}

function withModule(type: string, patch: (m: ModuleModel) => ModuleModel): Cat {
  const cat = base();
  cat.modules = cat.modules.map((m) => (m.type === type ? patch(m) : m));
  return cat;
}

const PC = 'pc.tvexp';
const HUB = 'hub.tvhub4';
const RT = 'router.tv1941';
const ML = 'mlswitch.tv3650';

/** One negative fixture per issue code. */
const FIXTURES: Record<CatalogIssueCode, () => Cat> = {
  'duplicate-type': () => {
    const cat = base();
    cat.models.push({ ...(cat.models[0] as DeviceModel), model: 'NF-OTHER' });
    return cat;
  },
  'bad-type': () => withModel(PC, (m) => ({ ...m, type: 'pc.NF_EXP' })),
  'kind-prefix': () => withModel(PC, (m) => ({ ...m, kind: 'router' })),
  'bad-model-name': () => withModel(PC, (m) => ({ ...m, model: 'PC-EXP' })),
  'duplicate-model-name': () => withModel(HUB, (m) => ({ ...m, model: 'NF-TV1941' })),
  'banned-word': () => withModel(PC, (m) => ({ ...m, description: `Works like a ${BANNED_VENDOR_WORDS[0] as string} desktop` })),
  'not-cloneable': () => withModel(PC, (m) => ({ ...m, extra: () => 1 }) as unknown as DeviceModel),
  'missing-field': () => withModel(PC, (m) => ({ ...m, gui: undefined }) as unknown as DeviceModel),
  'unknown-category': () => withModel(PC, (m) => ({ ...m, category: 'toys' }) as unknown as DeviceModel),
  'unknown-icon': () => withModel(PC, (m) => ({ ...m, icon: 'teapot' }) as unknown as DeviceModel),
  'bad-tags': () => withModel(PC, (m) => ({ ...m, tags: ['Desk'] })),
  'bad-hostname-prefix': () => withModel(PC, (m) => ({ ...m, hostnamePrefix: '1PC' })),
  'bad-timing': () => withModel(PC, (m) => ({ ...m, bootNs: -1 })),
  'unknown-capability': () => withModel(PC, (m) => ({ ...m, capabilities: ['host', 'teleport'] }) as unknown as DeviceModel),
  'capabilities-not-expanded': () => withModel(ML, (m) => ({ ...m, capabilities: ['layer3-switch'] })),
  'capability-conflict': () => withModel(HUB, (m) => ({ ...m, capabilities: ['host', 'repeater'] })),
  'bad-processes': () => withModel(PC, (m) => ({ ...m, processes: ['host', 'arp'] })),
  'processes-mismatch': () => withModel(PC, (m) => ({ ...m, processes: ['arp', 'ipv4'] })),
  'tables-mismatch': () => withModel(PC, (m) => ({ ...m, tables: ['cam'] })),
  'ipdefaults-mismatch': () => withModel(PC, (m) => ({ ...m, ipDefaults: ROUTER_IP_DEFAULTS })),
  'bad-cli': () => withModel(PC, (m) => ({ ...m, cli: { shell: 'none', grammar: 'host', initialPrivilege: 15, consoleVia: ['console'] } })),
  'bad-gui': () => withModel(PC, (m) => ({ ...m, gui: ['desktop.ip-config', 'physical'] })),
  'no-ports': () => withModel(HUB, (m) => ({ ...m, ports: [] })),
  'duplicate-port': () => withModel(HUB, (m) => ({ ...m, ports: [...m.ports, { ...(m.ports[0] as PortSpec), ordinal: 9 }] })),
  'bad-port-name': () => withPort(HUB, 1, { name: 'Eth1' }),
  'bad-port-short': () => withPort(HUB, 1, { short: 'E1' }),
  'missing-port-field': () => withPort(HUB, 1, { role: undefined }),
  'role-kind': () => withPort(HUB, 1, { role: 'wireless-bss', allowedRoles: ['wireless-bss'] }),
  'bad-allowed-roles': () => withPort(HUB, 1, { allowedRoles: ['switched'] }),
  'bad-ordinal': () => withPort(HUB, 1, { ordinal: 200 }),
  'duplicate-ordinal': () => withPort(HUB, 1, { ordinal: 1 }),
  'bad-encap': () => withPort(HUB, 1, { encap: 'hdlc' }),
  'bad-speed': () => withPort(HUB, 1, { speeds: [10_000_000, 100_000_000] }),
  'bad-radio': () => withPort('laptop.tvlaptop', 1, (p) => ({ ...p, radio: { ...(p.radio as NonNullable<PortSpec['radio']>), defaultChannel: 200 } })),
  'bad-mtu': () => withPort(HUB, 1, { mtu: 20 }),
  'bad-host-ports': () => withModel(PC, (m) => ({ ...m, hostPorts: ['Console'] })),
  'bad-port-owner': () => withModel('wrouter.tvhome', (m) => ({ ...m, portOwners: {} })),
  'bad-virtual-family': () => withModel(ML, (m) => ({ ...m, virtualFamilies: m.virtualFamilies?.map((f, i) => (i === 0 ? { ...f, min: 5, max: 2 } : f)) })),
  'bad-poe': () =>
    withModel('switch.tvpoe', (m) => {
      const { poeBudgetW: _unused, ...rest } = m;
      return rest;
    }),
  'bad-slot': () => withModel(RT, (m) => ({ ...m, slots: m.slots?.map((s, i) => (i === 1 ? { ...s, slotIndex: 5 } : s)) })),
  'modular-mismatch': () => withModel(RT, (m) => ({ ...m, capabilities: ['routing'] })),
  'bad-default-module': () => withModel(RT, (m) => ({ ...m, slots: m.slots?.map((s, i) => (i === 1 ? { ...s, defaultModule: 'mod.tv-nim-2t' } : s)) })),
  'bad-module': () => withModule('mod.tv-ehwic-2t', (m) => ({ ...m, ports: [{ ...(m.ports[0] as ModuleModel['ports'][number]), count: 0 }] })),
  'module-port-clash': () => {
    const cat = base();
    const clashing = defineModel({ ...ROUTER_INPUT, ports: [...ROUTER_INPUT.ports, { name: 'Serial0/0/0', kind: 'serial', speedBps: 2_000_000 }] }, 'P0.5', MODULES);
    cat.models = cat.models.map((m) => (m.type === RT ? clashing : m));
    return cat;
  },
};

const codesOf = (cat: Cat, opts = { stage: 'P0.5' as const }): string[] => validateCatalog(cat.models, cat.modules, opts).map((i) => i.code);

describe('validateCatalog', () => {
  it('accepts the base test catalog', () => {
    const issues = validateCatalog(MODELS, MODULES, { stage: 'P0.5' });
    expect(formatCatalogIssues(issues)).toBe('');
    expect(issues).toEqual([]);
  });

  it('has exactly one negative fixture per issue code', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...CATALOG_ISSUE_CODES].sort());
    expect(new Set(CATALOG_ISSUE_CODES).size).toBe(CATALOG_ISSUE_CODES.length);
  });

  it.each([...CATALOG_ISSUE_CODES])('reports %s', (code) => {
    const cat = FIXTURES[code]();
    const issues = validateCatalog(cat.models, cat.modules, { stage: 'P0.5' });
    const hit = issues.find((i) => i.code === code);
    expect(hit, formatCatalogIssues(issues)).toBeDefined();
    expect(hit?.message.length).toBeGreaterThan(10);
    expect(findBannedWords(hit?.message ?? '')).toEqual([]);
  });

  it('is deterministic and never mutates its input', () => {
    const cat = FIXTURES['bad-port-name']();
    const before = JSON.stringify(cat.models);
    const a = validateCatalog(cat.models, cat.modules, { stage: 'P0.5' });
    const b = validateCatalog(cat.models, cat.modules, { stage: 'P0.5' });
    expect(a).toEqual(b);
    expect(JSON.stringify(cat.models)).toBe(before);
    expect(a[0]).toMatchObject({ code: 'bad-port-name', subject: HUB, path: 'ports[1].name' });
  });

  it('checks daemons against a process registry when given one', () => {
    const issues = validateCatalog(MODELS, MODULES, { processNames: ['arp', 'ipv4', 'icmpv4', 'host'] });
    expect(issues.filter((i) => i.code === 'bad-processes').map((i) => i.subject)).toContain(ML);
    expect(issues.some((i) => i.code === 'processes-mismatch')).toBe(false);
  });

  it('flags a stage mismatch only when a stage is given', () => {
    const p1 = INPUTS.map((i) => defineModel(stripUndefined(i), 'P1', MODULES));
    expect(validateCatalog(p1, MODULES)).toEqual([]);
    expect(codesOf({ models: p1, modules: [...MODULES] })).toContain('processes-mismatch');
  });

  it('reports malformed entries instead of throwing', () => {
    const broken = { ...(MODELS[0] as DeviceModel), description: undefined, cli: { shell: 'nfos', grammar: 'nfos', initialPrivilege: 1 }, ports: [{ kind: 'ethernet', speedBps: 1 }] } as unknown as DeviceModel;
    const module = { ...(MODULES[0] as ModuleModel), description: undefined } as unknown as ModuleModel;
    let issues: ReturnType<typeof validateCatalog> = [];
    expect(() => {
      issues = validateCatalog([broken], [module], { stage: 'P0.5' });
    }).not.toThrow();
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('missing-field');
    expect(codes).toContain('bad-cli');
    expect(codes).toContain('bad-port-name');
  });

  it('checks radio data on module port templates', () => {
    const cat = withModule('mod.tv-wlan', (m) => ({ ...m, ports: [{ ...(m.ports[0] as ModuleModel['ports'][number]), spec: { kind: 'wlan', speedBps: 300_000_000 } }] }));
    const issues = validateCatalog(cat.models, cat.modules, { stage: 'P0.5' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'bad-module', subject: 'mod.tv-wlan', path: 'ports[0].spec.radio' }));
  });

  it('formats issues one per line', () => {
    const text = formatCatalogIssues([
      { code: 'bad-mtu', subject: 'hub.x', path: 'ports[0].mtu', message: 'Too small.' },
      { code: 'no-ports', subject: 'hub.y', path: '', message: 'Empty.' },
    ]);
    expect(text).toBe('hub.x ports[0].mtu: Too small. [bad-mtu]\nhub.y: Empty. [no-ports]');
  });
});

describe('legal and clone helpers', () => {
  it('matches banned words as whole words only', () => {
    const word = BANNED_VENDOR_WORDS[1] as string;
    expect(findBannedWords(`NF-${word.toUpperCase()}`)).toEqual([word]);
    expect(findBannedWords(`studio${word}s bios`)).toEqual([]);
    expect(findBannedWords('Layer-2 access switch: 24 fast-ethernet ports')).toEqual([]);
    const phrase = BANNED_VENDOR_WORDS.find((w) => w.includes(' ')) as string;
    expect(findBannedWords(`a ${phrase.toUpperCase()} clone`)).toEqual([phrase]);
  });

  it('finds the first non-JSON value with its path', () => {
    expect(jsonCloneProblem({ a: [1, 'x', null, { b: true }] })).toBeUndefined();
    expect(jsonCloneProblem({ a: [1, Number.NaN] })?.path).toBe('a[1]');
    expect(jsonCloneProblem({ a: { m: new Map() } })?.path).toBe('a.m');
    expect(jsonCloneProblem({ a: undefined })?.path).toBe('a');
    // eslint-disable-next-line no-sparse-arrays
    expect(jsonCloneProblem({ s: [1, , 3] })?.path).toBe('s[1]');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonCloneProblem(cyclic)?.message).toMatch(/itself/);
    const shared = { x: 1 };
    expect(jsonCloneProblem({ a: shared, b: shared })).toBeUndefined();
  });
});
