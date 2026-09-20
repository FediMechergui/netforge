// Services panel (ARCHITECTURE-P1 §6 "Host shell expansions (P1)", §7 "Browser and Services", D9, §8.2 W7
// web-learn): the canonical lines each form writes — checked against the text AND against the real device
// grammar through `configure` — what the panel reads back out of a running config, the client-side checks and
// the rendered panel.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCENARIOS, SEC, createSimulation } from '@netforge/engine';
import type { DeviceSnapshot, ScenarioInfo, Simulation, SimSnapshot } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: { configure: vi.fn() } }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { catalog: [] };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import type { CommandPlan } from '../src/gui/commands';
import {
  ServicesPanel,
  dhcpPoolCommands,
  dhcpStopCommands,
  dnsRecordCommands,
  excludedCommands,
  hostEntryCommands,
  httpPageCommands,
  runsService,
  serviceStateText,
  serviceSwitchCommands,
  servicesViewOf,
  validateExcluded,
  validateHostEntry,
  validatePage,
  validatePool,
  validateRecord,
} from '../src/inspector/ServicesPanel';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function lab(name: string): ScenarioInfo {
  const s = SCENARIOS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no scenario ${name}`);
  return s;
}

/** A booted world from `scenario`, with every link up. */
function world(scenario: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: scenario.seed ?? 1 });
  sim.loadTopology(scenario.build());
  sim.runFor(120 * SEC); // every device booted (a router takes the longest) and every link up
  return sim;
}

function device(snapshot: SimSnapshot, name: string): DeviceSnapshot {
  const d = snapshot.devices.find((x) => x.name === name);
  if (d === undefined) throw new Error(`no device ${name}`);
  return d;
}

/** Run a plan through the device's own CLI, exactly as the panel does. */
function apply(sim: Simulation, deviceName: string, plan: CommandPlan): { ok: boolean; messages: string[] } {
  const id = device(sim.snapshot(), deviceName).id;
  const result = sim.configure(id, [...plan.commands], { ...plan.options });
  return { ok: result.ok, messages: result.lines.filter((l) => !l.ok).map((l) => l.error?.message ?? l.output) };
}

const webLab = lab('ccna1-web-server'); // PC1 – SW1 – SRV1 (host shell)
const dhcpLab = lab('ccna1-dhcpv4-server'); // PC1, PC2 – SW1 – R1 (nfos shell)

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the lines the forms write', () => {
  it('writes the host-shell service expansions, and the device takes them', () => {
    expect(serviceSwitchCommands('host', 'http', true).commands).toEqual(['service http on']);
    expect(serviceSwitchCommands('host', 'http', false).commands).toEqual(['service http off']);
    expect(serviceSwitchCommands('host', 'dns', true).commands).toEqual(['service dns on']);
    expect(httpPageCommands('host', { path: '/index.html', text: 'A short page' }).commands).toEqual(['service http page /index.html A short page']);
    expect(httpPageCommands('host', { path: '/index.html', text: '' }, true).commands).toEqual(['no service http page /index.html']);
    expect(dnsRecordCommands('host', { name: 'www.lab.nf', type: 'a', data: '192.168.26.80', ttl: '3600' }).commands).toEqual([
      'service dns record www.lab.nf A 192.168.26.80 3600',
    ]);
    expect(dnsRecordCommands('host', { name: 'www.lab.nf', type: 'A', data: '192.168.26.80', ttl: '' }).commands).toEqual([
      'service dns record www.lab.nf A 192.168.26.80',
    ]);
    expect(dhcpPoolCommands('host', { network: '192.168.26.0', mask: '/24', router: '192.168.26.1' }).commands).toEqual([
      'service dhcp pool 192.168.26.0 255.255.255.0 192.168.26.1',
    ]);
    expect(dhcpStopCommands('host').commands).toEqual(['service dhcp off']);

    const sim = world(webLab);
    for (const plan of [
      serviceSwitchCommands('host', 'dns', true),
      dnsRecordCommands('host', { name: 'www.lab.nf', type: 'A', data: '192.168.26.80', ttl: '3600' }),
      serviceSwitchCommands('host', 'http', true),
      httpPageCommands('host', { path: '/index.html', text: 'A short page' }),
      dhcpPoolCommands('host', { network: '192.168.26.0', mask: '255.255.255.0', router: '192.168.26.1' }),
      httpPageCommands('host', { path: '/index.html', text: '' }, true),
      dhcpStopCommands('host'),
      serviceSwitchCommands('host', 'http', false),
    ]) {
      expect(apply(sim, 'SRV1', plan)).toEqual({ ok: true, messages: [] });
    }
  });

  it('writes the router-form lines, and the device takes those too', () => {
    expect(serviceSwitchCommands('nfos', 'http', true).commands).toEqual(['ip http server']);
    expect(serviceSwitchCommands('nfos', 'http', false).commands).toEqual(['no ip http server']);
    expect(serviceSwitchCommands('nfos', 'dns', true).commands).toEqual(['ip dns server']);
    expect(httpPageCommands('nfos', { path: '/notes', text: 'Two words' }).commands).toEqual(['ip http page /notes Two words']);
    expect(dnsRecordCommands('nfos', { name: 'files.lab.nf', type: 'A', data: '192.168.15.9', ttl: '600' }).commands).toEqual([
      'ip dns record files.lab.nf A 192.168.15.9 600',
    ]);
    expect(hostEntryCommands({ name: 'srv1', address: '192.168.15.9' }).commands).toEqual(['ip host srv1 192.168.15.9']);
    expect(hostEntryCommands({ name: 'srv1', address: '' }, true).commands).toEqual(['no ip host srv1']);
    expect(excludedCommands({ low: '192.168.15.1', high: '192.168.15.10' }).commands).toEqual(['ip dhcp excluded-address 192.168.15.1 192.168.15.10']);
    expect(excludedCommands({ low: '192.168.15.1', high: '' }).commands).toEqual(['ip dhcp excluded-address 192.168.15.1']);
    // The pool is a section: the children are indented, and the plan is applied as pasted configuration.
    const pool = dhcpPoolCommands('nfos', { network: '192.168.15.0', mask: '255.255.255.0', router: '192.168.15.1' }, 'LAN15');
    expect(pool.commands).toEqual(['ip dhcp pool LAN15', ' network 192.168.15.0 255.255.255.0', ' default-router 192.168.15.1']);
    expect(pool.options.indentation).toBe(true);
    expect(dhcpStopCommands('nfos', 'LAN15').commands).toEqual(['no ip dhcp pool LAN15']);

    const sim = world(dhcpLab);
    for (const plan of [
      excludedCommands({ low: '192.168.15.1', high: '192.168.15.10' }),
      dhcpPoolCommands('nfos', { network: '192.168.15.0', mask: '255.255.255.0', router: '192.168.15.1' }, 'LAN15'),
      serviceSwitchCommands('nfos', 'dns', true),
      dnsRecordCommands('nfos', { name: 'files.lab.nf', type: 'A', data: '192.168.15.9', ttl: '600' }),
      hostEntryCommands({ name: 'srv1', address: '192.168.15.9' }),
      serviceSwitchCommands('nfos', 'http', true),
      httpPageCommands('nfos', { path: '/notes', text: 'Two words' }),
      excludedCommands({ low: '192.168.15.1', high: '192.168.15.10' }, true),
      dhcpStopCommands('nfos', 'LAN15'),
    ]) {
      expect(apply(sim, 'R1', plan)).toEqual({ ok: true, messages: [] });
    }
  });

  it('sends a refused line so the device can name the field that is wrong', () => {
    const sim = world(webLab);
    const bad = apply(sim, 'SRV1', httpPageCommands('host', { path: 'index.html', text: 'no slash' }));
    expect(bad.ok).toBe(false);
    expect(bad.messages.join(' ')).not.toBe('');
    // The panel checks the same thing before sending, and names the field.
    expect(validatePage({ path: 'index.html', text: 'no slash' })['page.path']).toContain('slash');
  });

  // The grammar takes the rest of the line verbatim, so what the student typed is what the page serves.
  it('keeps the spacing of the page text, through the plan and back out of the config', () => {
    expect(httpPageCommands('host', { path: '/status', text: 'All  systems   fine' }).commands).toEqual(['service http page /status All  systems   fine']);
    expect(httpPageCommands('nfos', { path: '/status', text: 'All  systems   fine' }).commands).toEqual(['ip http page /status All  systems   fine']);
    const sim = world(webLab);
    apply(sim, 'SRV1', serviceSwitchCommands('host', 'http', true));
    apply(sim, 'SRV1', httpPageCommands('host', { path: '/status', text: 'All  systems   fine' }));
    const view = servicesViewOf(device(sim.snapshot(), 'SRV1').runningConfig);
    expect(view.http.pages).toEqual([{ path: '/status', text: 'All  systems   fine' }]);
  });

  // Nothing on screen is keyed to these lines, so a refusal has to reach the panel's reason box.
  it('leaves a refused service switch to the reason box rather than an invisible field', () => {
    for (const plan of [serviceSwitchCommands('host', 'http', true), serviceSwitchCommands('nfos', 'dns', false), dhcpStopCommands('host'), dhcpStopCommands('nfos')]) {
      const line = plan.lines[0]!;
      expect(line.spans.every((s) => s.field === null)).toBe(true);
    }
  });
});

describe('reading what the device runs', () => {
  it('reads the web and name services out of a server config', () => {
    const sim = world(webLab);
    for (const plan of [
      serviceSwitchCommands('host', 'dns', true),
      dnsRecordCommands('host', { name: 'www.lab.nf', type: 'A', data: '192.168.26.80', ttl: '3600' }),
      serviceSwitchCommands('host', 'http', true),
      httpPageCommands('host', { path: '/index.html', text: 'A short page' }),
    ]) {
      apply(sim, 'SRV1', plan);
    }
    const view = servicesViewOf(device(sim.snapshot(), 'SRV1').runningConfig);
    expect(view.http.enabled).toBe(true);
    expect(view.http.pages).toEqual([{ path: '/index.html', text: 'A short page' }]);
    expect(view.dns.enabled).toBe(true);
    expect(view.dns.records).toEqual([{ name: 'www.lab.nf', type: 'A', data: '192.168.26.80', ttl: '3600' }]);
    expect(view.dhcp.pool).toBeNull();
  });

  it('reads the address pool and the excluded addresses out of a router config', () => {
    const sim = world(dhcpLab);
    for (const [name, lines] of Object.entries(dhcpLab.solution ?? {})) {
      sim.configure(device(sim.snapshot(), name).id, [...lines], { stopOnError: true });
    }
    const view = servicesViewOf(device(sim.snapshot(), 'R1').runningConfig);
    expect(view.dhcp.pool).toMatchObject({ name: 'LAN15', network: '192.168.15.0', mask: '255.255.255.0', router: '192.168.15.1' });
    expect(view.dhcp.excluded).toEqual([{ low: '192.168.15.1', high: '192.168.15.10' }]);
    expect(view.http.enabled).toBe(false);
  });

  it('reads nothing out of an empty config and ignores negations', () => {
    const view = servicesViewOf(['hostname X', 'no ip http server', '!', 'interface GigabitEthernet0', ' ip address 10.0.0.1 255.0.0.0'].join('\n'));
    expect(view).toEqual({ http: { enabled: false, pages: [] }, dns: { enabled: false, records: [], hosts: [] }, dhcp: { pool: null, excluded: [] } });
    expect(servicesViewOf('').dhcp.pool).toBeNull();
  });

  it('knows which daemons a device runs, and says so in words', () => {
    const sim = world(webLab);
    const srv = device(sim.snapshot(), 'SRV1');
    const pc = device(sim.snapshot(), 'PC1');
    expect(runsService(srv, 'http')).toBe(true);
    expect(runsService(srv, 'dns')).toBe(true);
    expect(runsService(srv, 'dhcp')).toBe(true);
    expect(runsService(pc, 'http')).toBe(false);
    expect(serviceStateText(true)).toEqual({ glyph: '●', text: 'running' });
    expect(serviceStateText(false)).toEqual({ glyph: '○', text: 'stopped' });
  });
});

describe('client-side checks', () => {
  it('names the field that is wrong before anything is sent', () => {
    expect(validatePage({ path: '/ok', text: 'text' })).toEqual({});
    expect(validatePage({ path: '/ok', text: '  ' })['page.text']).toBeDefined();
    expect(validatePage({ path: '/a b', text: 't' })['page.path']).toBeDefined();
    expect(validatePage({ path: `/${'x'.repeat(200)}`, text: 't' })['page.path']).toContain('120');

    expect(validateRecord({ name: 'a.lab.nf', type: 'A', data: '10.0.0.1', ttl: '' })).toEqual({});
    expect(validateRecord({ name: '', type: 'A', data: '10.0.0.1', ttl: '' })['record.name']).toBeDefined();
    expect(validateRecord({ name: 'a', type: 'A', data: 'not-an-address', ttl: '' })['record.data']).toBeDefined();
    expect(validateRecord({ name: 'a', type: 'CNAME', data: 'b.lab.nf', ttl: '' })['record.data']).toBeUndefined();
    expect(validateRecord({ name: 'a', type: 'A', data: '10.0.0.1', ttl: 'soon' })['record.ttl']).toBeDefined();
    expect(validateRecord({ name: 'a', type: 'A', data: '10.0.0.1', ttl: '999999' })['record.ttl']).toContain('604800');

    expect(validateHostEntry({ name: 'srv', address: '10.0.0.1' })).toEqual({});
    expect(validateHostEntry({ name: '', address: 'x' })['host.name']).toBeDefined();

    expect(validatePool({ network: '192.168.1.0', mask: '255.255.255.0', router: '' })).toEqual({});
    expect(validatePool({ network: 'x', mask: '255.255.255.0', router: '' })['pool.network']).toBeDefined();
    expect(validatePool({ network: '192.168.1.0', mask: '255.0.255.0', router: '' })['pool.mask']).toBeDefined();
    expect(validatePool({ network: '192.168.1.0', mask: '/24', router: 'nope' })['pool.router']).toBeDefined();

    expect(validateExcluded({ low: '10.0.0.1', high: '' })).toEqual({});
    expect(validateExcluded({ low: '10.0.0.1', high: 'x' })['excluded.high']).toBeDefined();
  });
});

describe('the panel', () => {
  it('shows a section per service the device runs, with labelled forms', () => {
    const sim = world(webLab);
    for (const plan of [serviceSwitchCommands('host', 'http', true), httpPageCommands('host', { path: '/index.html', text: 'A short page' })]) apply(sim, 'SRV1', plan);
    const html = renderToStaticMarkup(createElement(ServicesPanel, { device: device(sim.snapshot(), 'SRV1') }));
    const t = text(html);
    expect(t).toContain('Web service');
    expect(t).toContain('Name service');
    expect(t).toContain('Address service');
    expect(t).toContain('The web service is running');
    expect(t).toContain('The name service is stopped');
    expect(t).toContain('/index.html');
    expect(t).toContain('A short page');
    expect(t).toContain('Stop the web service');
    expect(t).toContain('Start the name service');
    // A server has no `ip host` and no excluded-address expansion, so those forms are not offered.
    expect(t).not.toContain('Names this device resolves for itself');
    expect(t).not.toContain('Addresses never handed out');
    // Every control is named (§16).
    const labelled = new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1] as string));
    for (const m of html.matchAll(/<(input|select)\b[^>]*>/g)) {
      const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
      expect(id !== undefined && labelled.has(id)).toBe(true);
    }
    // State is a glyph AND words, never colour alone.
    expect(t).toContain('●');
    expect(t).toContain('○');
  });

  it('offers the router-only forms on a device with the nfos shell', () => {
    const sim = world(dhcpLab);
    const t = text(renderToStaticMarkup(createElement(ServicesPanel, { device: device(sim.snapshot(), 'R1') })));
    expect(t).toContain('Names this device resolves for itself');
    expect(t).toContain('Addresses never handed out');
    expect(t).toContain('The address service is stopped');
  });

  it('says so when the device offers no services, and when it is not ready', () => {
    const sim = world(webLab);
    const pc = device(sim.snapshot(), 'PC1');
    expect(text(renderToStaticMarkup(createElement(ServicesPanel, { device: pc })))).toContain('offers no network services');
    const off: DeviceSnapshot = { ...device(sim.snapshot(), 'SRV1'), power: false };
    expect(text(renderToStaticMarkup(createElement(ServicesPanel, { device: off })))).toContain('powered off');
  });
});
