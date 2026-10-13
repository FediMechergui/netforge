/**
 * §10.2 "desktop.traffic" through the app's own controls (ARCHITECTURE-P3 §5.9 `desktop.traffic`, M13, D16; W7 qa).
 *
 * `desktop.traffic-app.test.ts` (W3) pins the pure pieces — `applyTrafficPreset`, `trafficFlowOf`, `startTrafficFlow`
 * — one by one. This file drives the rendered panel the way a learner does: it presses a preset button, types into
 * the labelled fields, picks the radio buttons and presses Start (the form's one submit button), and asserts that
 * exactly one `hostRequest {app: 'traffic.start', flow}` leaves with the values the form shows, nothing more; that the
 * presets fill 50 pps / 60 B / DSCP 46 (and 200 B uncompressed) and keep what was typed; that a form the device would
 * refuse sends nothing and says why; and that a running flow's Stop button sends exactly `traffic.stop`.
 *
 * There is no DOM in the web tests: the panel is called as a function under a small hook harness (its `useState` and
 * `useId` slots are kept here between calls), and the element tree it returns is searched for the controls, whose
 * own `onClick` / `onChange` / `onSubmit` handlers are then called. Only host elements are rendered by the panel, so
 * the tree is the whole form.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSnapshot } from '@netforge/engine';

const api = vi.hoisted(() => ({ hostRequest: vi.fn() }));
/** The hook harness: while `active`, `useState` reads and writes `slots` in call order, and `useId` is fixed. */
const hooks = vi.hoisted(() => ({ active: false, index: 0, slots: [] as unknown[] }));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  function useState<S>(init: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
    if (!hooks.active) return real.useState(init);
    const i = hooks.index++;
    if (i >= hooks.slots.length) hooks.slots.push(typeof init === 'function' ? (init as () => S)() : init);
    const set = (next: S | ((prev: S) => S)): void => {
      hooks.slots[i] = typeof next === 'function' ? (next as (prev: S) => S)(hooks.slots[i] as S) : next;
    };
    return [hooks.slots[i] as S, set];
  }
  const useId = (): string => (hooks.active ? ':t:' : real.useId());
  return { ...real, useState, useId };
});
vi.mock('../src/bridge/client', () => ({ engine: api }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import { DEFAULT_TRAFFIC_FORM, TrafficPanel, trafficPresets, type TrafficForm } from '../src/desktop/apps/TrafficApp';
import { device, port, snapshot } from './canvas-fixtures';

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

// ── the element tree ────────────────────────────────────────────────────────

interface El {
  readonly type: unknown;
  readonly props: Record<string, unknown> & { readonly children?: unknown };
}

function isEl(n: unknown): n is El {
  return typeof n === 'object' && n !== null && !Array.isArray(n) && 'type' in n && 'props' in n;
}

function all(n: unknown, out: El[] = []): El[] {
  if (Array.isArray(n)) for (const c of n) all(c, out);
  else if (isEl(n)) {
    out.push(n);
    all(n.props.children, out);
  }
  return out;
}

function textOf(n: unknown): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (isEl(n)) return textOf(n.props.children);
  return '';
}

function only(tree: unknown, pred: (el: El) => boolean, what: string): El {
  const found = all(tree).filter(pred);
  if (found.length !== 1) throw new Error(`expected one ${what}, found ${found.length}`);
  return found[0]!;
}

/** The control a `<label for>` with exactly this text names. */
function labelled(tree: unknown, label: string): El {
  const l = only(tree, (el) => el.type === 'label' && textOf(el).trim() === label, `label "${label}"`);
  const id = l.props['htmlFor'];
  return only(tree, (el) => (el.type === 'input' || el.type === 'select' || el.type === 'textarea') && el.props['id'] === id, `control for "${label}"`);
}

function presetButton(tree: unknown, label: string): El {
  return only(tree, (el) => el.type === 'button' && el.props['type'] === 'button' && textOf(el).startsWith(`${label} (`), `preset "${label}"`);
}

/** The panel, rendered once under the harness (the state slots persist between calls). */
function render(dev: DeviceSnapshot, initialForm?: TrafficForm): El {
  hooks.index = 0;
  hooks.active = true;
  try {
    const out = TrafficPanel(initialForm === undefined ? { device: dev } : { device: dev, initialForm }) as unknown;
    if (!isEl(out)) throw new Error('the panel rendered no element');
    return out;
  } finally {
    hooks.active = false;
  }
}

/** A learner's actions on the panel: each one re-renders, as React would. */
function panel(dev: DeviceSnapshot, initialForm?: TrafficForm) {
  let tree = render(dev, initialForm);
  const again = (): El => (tree = render(dev, initialForm));
  return {
    get tree(): El {
      return tree;
    },
    value(label: string): unknown {
      return labelled(tree, label).props['value'];
    },
    checked(label: string): unknown {
      return labelled(tree, label).props['checked'];
    },
    preset(label: string): void {
      (presetButton(tree, label).props['onClick'] as () => void)();
      again();
    },
    type(label: string, value: string): void {
      (labelled(tree, label).props['onChange'] as (e: { target: { value: string } }) => void)({ target: { value } });
      again();
    },
    pick(label: string): void {
      (labelled(tree, label).props['onChange'] as () => void)();
      again();
    },
    startButton(): El {
      const form = only(tree, (el) => el.type === 'form', 'form');
      return only(form, (el) => el.type === 'button' && el.props['type'] === 'submit', 'submit button');
    },
    /** Presses Start: the browser submits the button's form. Resolves once the panel has settled. */
    async start(): Promise<{ prevented: boolean }> {
      const form = only(tree, (el) => el.type === 'form', 'form');
      let prevented = false;
      (form.props['onSubmit'] as (e: { preventDefault(): void }) => void)({
        preventDefault: () => {
          prevented = true;
        },
      });
      await settle();
      again();
      return { prevented };
    },
    async stop(id: string): Promise<void> {
      const button = only(tree, (el) => el.type === 'button' && el.props['aria-label'] === `Stop flow ${id}`, `Stop ${id}`);
      (button.props['onClick'] as () => void)();
      await settle();
      again();
    },
    status(): string | undefined {
      const s = all(tree).filter((el) => el.props['role'] === 'status');
      return s.length === 0 ? undefined : textOf(s[0]);
    },
    alert(): string | undefined {
      const s = all(tree).filter((el) => el.props['role'] === 'alert');
      return s.length === 0 ? undefined : textOf(s[0]);
    },
    /** The error line under a field (`aria-describedby` → the `-err` span), or undefined. */
    fieldError(label: string): string | undefined {
      const control = labelled(tree, label);
      const ids = String(control.props['aria-describedby'] ?? '').split(' ').filter((x) => x.endsWith('-err'));
      if (ids.length === 0) return undefined;
      return textOf(only(tree, (el) => el.props['id'] === ids[0], 'error line'));
    },
  };
}

/** Lets the panel's async handlers run to their end (the request is a settled mock): one turn of the task queue. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** PC1 (10.0.0.1), on and booted; with the given sender flows in its `traffic` StateView. */
function pc1(flows: readonly Record<string, unknown>[] = [], extra: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return device('pc1', 0, 0, [port('eth0', { l3: { ipv4: { address: '10.0.0.1', prefixLen: 24 } } })], {
    gui: ['desktop.ip-config', 'desktop.command-prompt', 'desktop.traffic'],
    processes: flows.length === 0 ? [] : [{ process: 'traffic', state: { flows, receiving: 0, received: 0 } }],
    ...extra,
  });
}

function runningFlow(id: string): Record<string, unknown> {
  return { id, dst: '10.0.1.10', dstPort: 9, sizeBytes: 60, dscp: 46, paceNs: 20_000_000, mode: 'duration', limit: 500, sent: 120, errors: 0, state: 'running', startedAt: 0 };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
  hooks.active = false;
  api.hostRequest.mockReset();
  api.hostRequest.mockResolvedValue({ requestId: 'r_1', process: 'traffic' });
  setState({ snapshot: snapshot([]) });
});

describe('the presets fill the form (§10.2: 50 pps / 60 B / DSCP 46)', () => {
  it('a new form shows the defaults: 64 kb/s of 500-byte packets for ten seconds, unmarked, to port 9', () => {
    const p = panel(pc1());
    expect(p.value('Destination address')).toBe('');
    expect(p.value('UDP port')).toBe('9');
    expect(p.checked('kb/s')).toBe(true);
    expect(p.value('Rate (kb/s)')).toBe('64');
    expect(p.value('Packet size (bytes)')).toBe('500');
    expect(p.value('DSCP marking')).toBe('0');
    expect(p.checked('a number of seconds')).toBe(true);
    expect(p.value('Seconds')).toBe('10');
    expect(p.value('Flow name (optional)')).toBe('');
    expect(DEFAULT_TRAFFIC_FORM.rateKind).toBe('kbps');
  });

  it('"Voice call, compressed" sets packets per second, 50, 60 B and DSCP 46, and keeps what was typed', () => {
    const p = panel(pc1());
    p.type('Destination address', '10.0.1.10');
    p.type('Seconds', '30');
    p.type('Flow name (optional)', 'call1');
    p.preset('Voice call, compressed');
    expect(p.checked('packets per second')).toBe(true);
    expect(p.checked('kb/s')).toBe(false);
    expect(p.value('Packets per second')).toBe('50');
    expect(p.value('Packet size (bytes)')).toBe('60');
    expect(p.value('DSCP marking')).toBe('46');
    // kept
    expect(p.value('Destination address')).toBe('10.0.1.10');
    expect(p.value('Seconds')).toBe('30');
    expect(p.value('Flow name (optional)')).toBe('call1');
    expect(p.value('UDP port')).toBe('9');
  });

  it('"Voice call, uncompressed" is the same call at 200 B; each button says what it fills', () => {
    const p = panel(pc1());
    p.preset('Voice call, uncompressed');
    expect([p.value('Packets per second'), p.value('Packet size (bytes)'), p.value('DSCP marking')]).toEqual(['50', '200', '46']);
    expect(textOf(presetButton(p.tree, 'Voice call, compressed'))).toBe('Voice call, compressed (50 pps × 60 B, DSCP 46)');
    expect(textOf(presetButton(p.tree, 'Voice call, uncompressed'))).toBe('Voice call, uncompressed (50 pps × 200 B, DSCP 46)');
    expect(trafficPresets()).toHaveLength(2);
  });
});

describe('the Start button (§10.2: exactly hostRequest {app: "traffic.start", flow} with the form’s values)', () => {
  it('is the form’s one submit button, labelled Start and enabled on a running device', () => {
    const b = panel(pc1()).startButton();
    expect(textOf(b)).toBe('Start');
    expect(b.props['disabled']).toBe(false);
  });

  it('after the compressed preset: one request, with exactly the preset’s rate, size and marking and the typed destination', async () => {
    const p = panel(pc1());
    p.preset('Voice call, compressed');
    p.type('Destination address', '10.0.1.10');
    const { prevented } = await p.start();
    expect(prevented).toBe(true); // the page does not navigate
    expect(api.hostRequest.mock.calls).toStrictEqual([
      ['pc1', { app: 'traffic.start', flow: { dst: '10.0.1.10', dstPort: 9, sizeBytes: 60, dscp: 46, pps: 50, durationMs: 10_000 } }],
    ]);
    expect(p.status()).toBe('✓ Asked PC1 to start a flow to 10.0.1.10.');
    expect(p.alert()).toBeUndefined();
  });

  it('every field the learner changed reaches the request: name, port, kb/s rate, size, marking, a packet count', async () => {
    const p = panel(pc1());
    p.type('Destination address', ' 192.168.2.10 ');
    p.type('UDP port', '5004');
    p.type('Rate (kb/s)', '128');
    p.type('Packet size (bytes)', '1000');
    p.type('DSCP marking', '34');
    p.pick('a number of packets');
    expect(p.value('Packets')).toBe('100');
    p.type('Packets', '250');
    p.type('Flow name (optional)', 'video');
    await p.start();
    expect(api.hostRequest.mock.calls).toStrictEqual([
      ['pc1', { app: 'traffic.start', flow: { id: 'video', dst: '192.168.2.10', dstPort: 5004, sizeBytes: 1000, dscp: 34, rateKbps: 128, count: 250 } }],
    ]);
    expect(p.status()).toBe('✓ Asked PC1 to start flow video to 192.168.2.10.');
  });

  it('"until stopped" sends neither a count nor a duration; a duration in seconds is sent in milliseconds', async () => {
    const p = panel(pc1());
    p.type('Destination address', '10.0.1.10');
    p.pick('until stopped');
    await p.start();
    p.pick('a number of seconds');
    p.type('Seconds', '2.5');
    await p.start();
    expect(api.hostRequest.mock.calls).toStrictEqual([
      ['pc1', { app: 'traffic.start', flow: { dst: '10.0.1.10', dstPort: 9, sizeBytes: 500, dscp: 0, rateKbps: 64 } }],
      ['pc1', { app: 'traffic.start', flow: { dst: '10.0.1.10', dstPort: 9, sizeBytes: 500, dscp: 0, rateKbps: 64, durationMs: 2500 } }],
    ]);
  });

  it('sends nothing for a form it cannot read, and names the field under it', async () => {
    const p = panel(pc1());
    await p.start();
    expect(api.hostRequest).not.toHaveBeenCalled();
    expect(p.fieldError('Destination address')).toBe('⚠ Enter the address of the device that receives the flow.');
    // typing again clears the mark
    p.type('Destination address', '10.0.1.10');
    expect(p.fieldError('Destination address')).toBeUndefined();
    p.type('DSCP marking', 'ef');
    await p.start();
    expect(api.hostRequest).not.toHaveBeenCalled();
    expect(p.fieldError('DSCP marking')).toBe('⚠ DSCP is a whole number from 0 to 63.');
  });

  it('sends nothing the daemon would refuse, and says why in an alert', async () => {
    const p = panel(pc1());
    p.type('Destination address', '10.0.1.10');
    p.type('Packet size (bytes)', '20');
    await p.start();
    expect(api.hostRequest).not.toHaveBeenCalled();
    expect(p.alert()).toBe("⚠ A flow's packets are 60 to 1500 bytes long.");
    p.type('Packet size (bytes)', '500');
    p.type('Destination address', '10.0.0.1');
    await p.start();
    expect(api.hostRequest).not.toHaveBeenCalled();
    expect(p.alert()).toBe('⚠ 10.0.0.1 is this device; a flow goes to another device.');
    // a device that already sends eight flows
    const busy = panel(pc1(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'].map(runningFlow)), { ...DEFAULT_TRAFFIC_FORM, dst: '10.0.1.10' });
    await busy.start();
    expect(api.hostRequest).not.toHaveBeenCalled();
    expect(busy.alert()).toBe('⚠ This device already sends 8 flows. Stop one first.');
  });

  it('is disabled on a device that is off or still starting, and its form then sends nothing', async () => {
    for (const extra of [{ power: false }, { booted: false }]) {
      const p = panel(pc1([], extra), { ...DEFAULT_TRAFFIC_FORM, dst: '10.0.1.10' });
      expect(p.startButton().props['disabled']).toBe(true);
      await p.start();
    }
    expect(api.hostRequest).not.toHaveBeenCalled();
  });

  it('shows the engine’s refusal of the request in an alert', async () => {
    api.hostRequest.mockRejectedValueOnce(new Error('The device is busy.'));
    const p = panel(pc1(), { ...DEFAULT_TRAFFIC_FORM, dst: '10.0.1.10' });
    await p.start();
    expect(api.hostRequest).toHaveBeenCalledTimes(1);
    expect(p.alert()).toContain('The device is busy.');
    expect(p.status()).toBeUndefined();
    expect(p.startButton().props['disabled']).toBe(false); // ready again
  });
});

describe('the Stop button of a running flow', () => {
  it('sends exactly hostRequest {app: "traffic.stop", id}, and only a running flow has one', async () => {
    const ended = { ...runningFlow('f2'), state: 'ended', sent: 500, endedAt: 1 };
    const p = panel(pc1([runningFlow('f1'), ended]));
    expect(all(p.tree).filter((el) => el.type === 'button' && String(el.props['aria-label'] ?? '').startsWith('Stop flow ')).map((el) => el.props['aria-label'])).toEqual([
      'Stop flow f1',
    ]);
    await p.stop('f1');
    expect(api.hostRequest.mock.calls).toStrictEqual([['pc1', { app: 'traffic.stop', id: 'f1' }]]);
    expect(p.status()).toBe('✓ Asked PC1 to stop flow f1.');
  });
});
