/**
 * device.remote-cli-action — [S13] the remote terminal's runtime seam (ARCHITECTURE-P3 D14, §2.4, §2.7; §7 W1
 * device): the vty daemon's `remoteCli` action and the vty-client's `cliRemote` action only schedule SimEvent
 * `remoteCli {device, from, act}` at now through `deps.scheduler` (zero delay, non-periodic, a copy of the action with
 * only its set members); the runtime applies nothing inline (no CLI output, no trace event). No DeviceRuntimeDeps
 * member exists for it (the harness's deps are the P2 set).
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/contracts/events.js';
import type { CliRemoteAction, RemoteCliAction } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import { boot, harness } from './device.harness.js';

type RemoteEvent = Extract<SimEvent, { kind: 'remoteCli' }>;

describe('remoteCli and cliRemote actions (D14)', () => {
  it('vty: open, line and close each schedule one remoteCli event at now, in order, applying nothing', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const now = 90 * SEC;
    const traced = h.events.length;
    const open: RemoteCliAction = { type: 'remoteCli', op: 'open', conn: 'vty0', peer: '10.0.0.10', proto: 'ssh', user: 'admin' };
    const line: RemoteCliAction = { type: 'remoteCli', op: 'line', conn: 'vty0', text: 'show ip interface brief' };
    const close: RemoteCliAction = { type: 'remoteCli', op: 'close', conn: 'vty0' };
    h.device.applyActions('vty', [open, line, close], now);
    expect(h.events.length).toBe(traced);
    expect(h.cli.output).toEqual([]);
    expect(h.cli.done).toEqual([]);
    open.user = 'mallory';
    const evs: RemoteEvent[] = [];
    while (h.scheduler.peekTime() === now) evs.push(h.scheduler.next() as RemoteEvent);
    expect(evs.map(({ at, kind, device, from, act }) => ({ at, kind, device, from, act }))).toEqual([
      { at: now, kind: 'remoteCli', device: 'd_1', from: 'vty', act: { type: 'remoteCli', op: 'open', conn: 'vty0', peer: '10.0.0.10', proto: 'ssh', user: 'admin' } },
      { at: now, kind: 'remoteCli', device: 'd_1', from: 'vty', act: { type: 'remoteCli', op: 'line', conn: 'vty0', text: 'show ip interface brief' } },
      { at: now, kind: 'remoteCli', device: 'd_1', from: 'vty', act: { type: 'remoteCli', op: 'close', conn: 'vty0' } },
    ]);
    for (const e of evs) expect(e).not.toHaveProperty('periodic');
    expect(Object.keys(evs[2]!.act)).toEqual(['type', 'op', 'conn']);
  });

  it('vty-client: cliRemote schedules a remoteCli event carrying the session view', () => {
    const h = harness({ type: 'pc.nfpc', name: 'PC1' });
    boot(h);
    const now = 5 * SEC;
    const act: CliRemoteAction = { type: 'cliRemote', session: 's_3', prompt: 'Password: ', input: 'secret', remote: 'R1 via SSH' };
    h.device.applyActions('vty-client', [act, { type: 'cliRemote', session: 's_3' }], now);
    const a = h.scheduler.next() as RemoteEvent;
    const b = h.scheduler.next() as RemoteEvent;
    expect(a).toEqual({ at: now, seq: a.seq, kind: 'remoteCli', device: 'd_1', from: 'vty-client', act });
    expect(a.act).not.toBe(act);
    expect(b.act).toEqual({ type: 'cliRemote', session: 's_3' });
    expect(Object.keys(b.act)).toEqual(['type', 'session']);
    expect(h.cli.output).toEqual([]);
  });

  it('a remote action inside a longer action list keeps its place: later actions still run in the same call', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const now = 100 * SEC;
    h.device.applyActions('vty', [
      { type: 'remoteCli', op: 'open', conn: 'vty1', proto: 'telnet' },
      { type: 'log', severity: 6, facility: 'TEST', message: 'after the remote action' },
    ], now);
    expect(h.kinds('log').at(-1)).toMatchObject({ t: now, message: 'after the remote action' });
    expect((h.scheduler.next() as RemoteEvent).act).toEqual({ type: 'remoteCli', op: 'open', conn: 'vty1', proto: 'telnet' });
  });
});
