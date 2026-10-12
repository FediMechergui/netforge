/**
 * [S32] The automation workspace on a real world (ARCHITECTURE-P3 §3.8 step 8, §6, D21; §7 W6 web-desktop): the
 * staged test-only NF-DEVHOST (`staged.world`, stage P3, the script host passed through the registry overlay until
 * the W6 flip registers it) cabled to a router that serves RESTCONF, driven by exactly the `hostRequest`s the
 * workspace sends, and read back through the workspace's own model from `sim.snapshot()` and `exportTopology()`.
 *
 * Under test: a saved script is listed from `DeviceSnapshot.storage` and its text found in the export; a run started
 * with `script.run` is the StateView run whose token is the ticket, with its output, its requests (strictly in order)
 * and its one `script-runs` row; each request's NetScope filter, applied to a capture of DEV1's port, finds the
 * request's own HTTP message; a run that fails names the line the workspace flags; a syntax error is marked by the
 * editor exactly as the run reports it, and sends nothing; Stop ends a running run; the workspace renders the real
 * snapshot.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createScriptHost } from '@netforge/engine';
import type { DeviceSnapshot, Simulation } from '@netforge/engine';
import { createStagedSimulation, NF_DEVHOST_TYPE } from '../../../packages/engine/test/staged.world';

vi.mock('../src/bridge/client', () => ({ engine: {} }));
vi.mock('../src/terminal/TerminalTab', () => ({ TerminalTab: () => null }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore, DESKTOP_WINDOW_DEFAULT: Object.freeze({ w: 520, h: 380 }) };
});

import { AutomationWorkspace } from '../src/automation/AutomationWorkspace';
import { firstSyntaxError, pySyntaxMarks } from '../src/automation/py-highlight';
import { chooseRun, fileContentOf, hostFiles, requestCaptureFilter, scriptHostView, scriptRunRows } from '../src/automation/workspace-model';

const SEC = 1_000_000_000;
const PASSWORD = 'Lab-Pass1';
const DEV = '10.0.99.20';
const R1 = '10.0.99.1';

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/** DEV1 (NF-DEVHOST) cabled to R1, an NF-2911 serving RESTCONF on 10.0.99.1; booted at 60 s. */
function world(seed = 3_240): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: { 'script-host': createScriptHost } });
  sim.addDevice({ id: 'dev1', type: NF_DEVHOST_TYPE, name: 'DEV1', startupConfig: startup([['hostname DEV1'], ['interface GigabitEthernet0', ` ip address ${DEV} 255.255.255.0`]]) });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      [`username admin privilege 15 secret ${PASSWORD}`],
      ['ip http secure-server'],
      ['ip http authentication local'],
      ['restconf'],
      ['interface GigabitEthernet0/0', ` ip address ${R1} 255.255.255.0`, ' no shutdown'],
    ]),
  });
  sim.addLink({ a: { device: 'dev1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.runUntil(60 * SEC);
  return sim;
}

const INVENTORY = [
  'import requests',
  '',
  `URL = "https://${R1}/restconf/data/ietf-interfaces:interfaces"`,
  'for n in range(2):',
  `    r = requests.get(URL, auth=("admin", "${PASSWORD}"), verify=False)`,
  '    print(n, r.status_code)',
  '',
].join('\n');

const dev1Of = (sim: Simulation): DeviceSnapshot => sim.snapshot().devices.find((d) => d.id === 'dev1')!;

/** Save `content` as `path` the way the workspace does, and let the host apply it. */
function save(sim: Simulation, path: string, content: string): void {
  sim.hostRequest('dev1', { app: 'file.write', path, content });
  sim.runUntil(sim.now + SEC);
}

describe('the automation workspace on the staged NF-DEVHOST', () => {
  it('lists a saved script, runs it, and reads its output, requests and row back through its model', () => {
    const sim = world();
    const cap = sim.startCapture({ ports: [{ device: 'dev1', port: 'GigabitEthernet0' }], name: 'DEV1' });
    save(sim, 'inventory.py', INVENTORY);
    expect(pySyntaxMarks(INVENTORY)).toEqual([]);

    // the files list and the text the editor opens
    const listed = hostFiles(dev1Of(sim));
    expect(listed.map((f) => [f.path, f.size])).toEqual([['inventory.py', INVENTORY.length]]);
    expect(fileContentOf(sim.exportTopology(), 'dev1', 'inventory.py')).toBe(INVENTORY);

    // Run: the ticket is the token the workspace follows
    const ticket = sim.hostRequest('dev1', { app: 'script.run', file: 'inventory.py' });
    expect(ticket.process).toBe('script-host');
    sim.runUntil(sim.now + 10 * SEC);

    const dev = dev1Of(sim);
    const view = scriptHostView(dev)!;
    const run = chooseRun(view, { token: ticket.requestId })!;
    expect(run).toBeDefined();
    expect(run.file).toBe('inventory.py');
    expect(run.state).toBe('completed');
    expect(run.output).toBe('0 200\n1 200\n');
    expect(run.requests.map((q) => [q.n, q.method, q.url, q.state, q.status])).toEqual([
      [1, 'GET', `https://${R1}/restconf/data/ietf-interfaces:interfaces`, 'done', 200],
      [2, 'GET', `https://${R1}/restconf/data/ietf-interfaces:interfaces`, 'done', 200],
    ]);
    // strictly one after another
    expect(run.requests[1]!.startedAt).toBeGreaterThanOrEqual(run.requests[0]!.endedAt!);
    expect(chooseRun(view, { file: 'inventory.py' })?.run).toBe(run.run);
    expect(scriptRunRows(dev).map((r) => [r.run, r.file, r.state, r.requests])).toEqual([[run.run, 'inventory.py', 'completed', 2]]);

    // the request's NetScope filter finds its HTTP messages in a capture of DEV1's port
    const filter = requestCaptureFilter(run.requests[0]!.url)!;
    expect(filter).toBe(`ip.addr == ${R1} && tcp.port == 443`);
    const q = sim.queryCapture(cap, { filter, from: 0, limit: 1000 });
    expect(q.filterError).toBeUndefined();
    expect(q.rows.length).toBeGreaterThan(0);
    expect(q.rows.some((r) => r.proto === 'http' && r.info.includes('GET /restconf/data/ietf-interfaces:interfaces'))).toBe(true);
    expect(sim.queryCapture(cap, { filter: `ip.addr == 10.9.9.9 && tcp.port == 443`, from: 0, limit: 10 }).rows).toEqual([]);

    // the workspace renders the real snapshot
    const html = renderToStaticMarkup(createElement(AutomationWorkspace, { device: dev, initialLoaded: { 'inventory.py': INVENTORY }, initialToken: ticket.requestId }));
    expect(html).toContain(`Run ${run.run} of inventory.py: ✓ completed.`);
    expect(html).toContain('0 200\n1 200\n');
    expect(html.match(/>Show in NetScope</g)).toHaveLength(2);
    expect(html).toMatch(/class="auto-syntax is-ok"><span aria-hidden="true">✓ <\/span>No syntax errors\.<\/p>/);
  });

  it('flags the line a run failed on, and marks a syntax error exactly as the run reports it, sending nothing', () => {
    const sim = world(3_241);
    const failing = ['data = {"a": 1}', 'print("before")', 'print(data["b"])', ''].join('\n');
    save(sim, 'fail.py', failing);
    const t1 = sim.hostRequest('dev1', { app: 'script.run', file: 'fail.py' });
    sim.runUntil(sim.now + SEC);
    const failed = chooseRun(scriptHostView(dev1Of(sim)), { token: t1.requestId })!;
    expect(failed.state).toBe('failed');
    expect(failed.output).toBe('before\n');
    expect(failed.error?.type).toBe('KeyError');
    expect(failed.error?.line).toBe(3);
    const html = renderToStaticMarkup(createElement(AutomationWorkspace, { device: dev1Of(sim), initialLoaded: { 'fail.py': failing }, initialToken: t1.requestId }));
    expect(html).toContain('auto-gutter-line is-failed');
    expect(html).toContain('Show line 3 in the editor');
    expect(html).toContain(`Run ${failed.run} of fail.py: ✕ failed.`);
    expect(scriptRunRows(dev1Of(sim))[0]).toMatchObject({ run: failed.run, state: 'failed', error: failed.error?.last });

    const broken = ['import requests', `r = requests.get("https://${R1}/"`, 'print(r)', ''].join('\n');
    save(sim, 'broken.py', broken);
    const cap = sim.startCapture({ ports: [{ device: 'dev1', port: 'GigabitEthernet0' }] });
    const t2 = sim.hostRequest('dev1', { app: 'script.run', file: 'broken.py' });
    sim.runUntil(sim.now + SEC);
    const bad = chooseRun(scriptHostView(dev1Of(sim)), { token: t2.requestId })!;
    expect(bad.state).toBe('failed');
    expect(bad.requests).toEqual([]);
    expect(sim.queryCapture(cap, { from: 0, limit: 100 }).rows.filter((r) => r.layers.includes('tcp'))).toEqual([]);
    const mark = firstSyntaxError(broken)!;
    expect(bad.error?.type).toBe(mark.type);
    expect(bad.error?.message).toBe(mark.message);
    expect(bad.error?.line).toBe(mark.line);
  });

  it('Stop ends a running run, and the workspace shows it stopped', () => {
    const sim = world(3_242);
    save(sim, 'wait.py', ['import time', 'print("waiting")', 'time.sleep(60)', 'print("never")', ''].join('\n'));
    const t = sim.hostRequest('dev1', { app: 'script.run', file: 'wait.py' });
    sim.runUntil(sim.now + SEC);
    const running = chooseRun(scriptHostView(dev1Of(sim)), { token: t.requestId })!;
    expect(running.state).toBe('running');
    expect(running.waiting).toBe('sleep');
    const live = renderToStaticMarkup(createElement(AutomationWorkspace, { device: dev1Of(sim), initialLoaded: { 'wait.py': 'x' }, initialToken: t.requestId }));
    expect(live).toContain(`Run ${running.run} of wait.py: ▶ running.`);
    expect(live).toContain('sleeping');

    sim.hostRequest('dev1', { app: 'script.stop', run: t.requestId });
    sim.runUntil(sim.now + SEC);
    const stopped = chooseRun(scriptHostView(dev1Of(sim)), { token: t.requestId })!;
    expect(stopped.state).toBe('stopped');
    expect(stopped.output).toBe('waiting\n');
    expect(scriptRunRows(dev1Of(sim))[0]).toMatchObject({ run: stopped.run, state: 'stopped' });
  });
});
