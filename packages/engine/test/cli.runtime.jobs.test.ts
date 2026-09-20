/**
 * cli/runtime.ts — jobs and asynchronous output: ping blocks the session,
 * onOutput/onDone routing, interrupt → icmp.abort, debug categories and
 * onDebugEvent fan-out to the right sessions.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/cli/handlers/index.js', async () => {
  const exec = await import('../src/cli/handlers/exec.js');
  const config = await import('../src/cli/handlers/config.js');
  return { HANDLER_REGISTRY: { ...exec.execHandlers, ...config.configHandlers } };
});

import type { CommandHandler } from '../src/contracts/cli.js';
import type { DebugEvent } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import { execHandlers, MSG_NO_IP_STACK, MSG_BAD_PING_TARGET } from '../src/cli/handlers/exec.js';
import { configHandlers } from '../src/cli/handlers/config.js';
import { CLI_PROCESS_NAME, createCliRuntime } from '../src/cli/runtime.js';
import { harness } from './cli.runtime.fake.js';

const REGISTRY: Record<string, CommandHandler> = { ...execHandlers, ...configHandlers };

function pcSession() {
  const h = harness();
  const dev = h.add('d_pc', 'pc', 'PC1');
  const cli = createCliRuntime(h.deps, REGISTRY);
  const id = cli.open('d_pc', 'console');
  h.trace.clear();
  return { h, dev, cli, id };
}

describe('cli/runtime ping job', () => {
  it('requests icmp.ping with the P0 parameters and blocks the session', () => {
    const { h, dev, cli, id } = pcSession();
    h.clock.now = 5 * SEC;
    const r = cli.exec(id, 'ping 10.0.0.2');
    expect(r.busy).toBe(true);
    expect(r.error).toBeUndefined();
    // the header is printed once, by the icmpv4 job (asynchronous cliOutput), not by the exec handler
    expect(r.output ?? '').not.toMatch(/echo requests/);
    expect(dev.actionCalls).toEqual([
      {
        process: CLI_PROCESS_NAME,
        now: 5 * SEC,
        actions: [
          {
            type: 'request',
            to: 'icmpv4',
            req: { kind: 'icmp.ping', session: id, target: '10.0.0.2', count: 5, timeoutNs: 2 * SEC, sizeBytes: 100 },
          },
        ],
      },
    ]);
    expect(cli.session(id)!.busy).toBe(true);
    expect(h.trace.of('cliPrompt')).toEqual([{ t: 5 * SEC, kind: 'cliPrompt', session: id, prompt: 'PC1>', busy: true }]);
  });

  it('ignores lines while busy, streams onOutput, and onDone unblocks with a cliPrompt', () => {
    const { h, dev, cli, id } = pcSession();
    cli.exec(id, 'ping 10.0.0.2');
    h.trace.clear();
    const ignored = cli.exec(id, 'ping 10.0.0.3');
    expect(ignored).toMatchObject({ output: '', busy: true });
    expect(dev.actionCalls).toHaveLength(1);
    expect(cli.session(id)!.history).toEqual(['ping 10.0.0.2']);

    cli.onOutput(id, '!', 1 * SEC);
    cli.onOutput('s_none', '!', 1 * SEC);
    cli.onDone(id, 6 * SEC);
    expect(h.trace.events).toEqual([
      { t: 1 * SEC, kind: 'cliOutput', session: id, text: '!' },
      { t: 6 * SEC, kind: 'cliPrompt', session: id, prompt: 'PC1>', busy: false },
    ]);
    expect(cli.session(id)!.busy).toBe(false);
    expect(cli.exec(id, 'ping 10.0.0.3').busy).toBe(true);
  });

  it('a job that finishes during the request leaves the session free with a single prompt', () => {
    const { h, dev, cli, id } = pcSession();
    dev.onRequest = (a, now) => {
      if (a.req.kind === 'icmp.ping') {
        cli.onOutput(id, 'No route to 10.0.0.2 from this host.', now);
        cli.onDone(id, now);
      }
    };
    const r = cli.exec(id, 'ping 10.0.0.2');
    expect(r.busy).toBe(false);
    expect(cli.session(id)!.busy).toBe(false);
    expect(h.trace.of('cliPrompt')).toEqual([{ t: 0, kind: 'cliPrompt', session: id, prompt: 'PC1>', busy: false }]);
    expect(h.trace.of('cliOutput')).toHaveLength(1);
  });

  it('rejects hopeless targets; a switch now pings from its management SVI', () => {
    const { cli, id } = pcSession();
    expect(cli.exec(id, 'ping 0.0.0.0').error?.message).toBe(MSG_BAD_PING_TARGET);
    expect(cli.exec(id, 'ping 224.0.0.1').error?.message).toBe(MSG_BAD_PING_TARGET);
    expect(cli.exec(id, 'ping 255.255.255.255').error?.message).toBe(MSG_BAD_PING_TARGET);
    // ARCHITECTURE-P1 §9.2 (P1 W5): L2 switches gain icmpv4 for their SVI, so the switch no longer answers
    // MSG_NO_IP_STACK — it starts the job. A device that runs no icmpv4 at all still does.
    const h = harness();
    h.add('d_sw', 'switch', 'SW1');
    const sw = createCliRuntime(h.deps, REGISTRY);
    const sid = sw.open('d_sw', 'console');
    const r = sw.exec(sid, 'ping 10.0.0.1');
    expect(r.error).toBeUndefined();
    expect(r.busy).toBe(true);
    const bare = harness();
    bare.add('d_pc2', 'pc', 'PC2').processes.clear();
    const hub = createCliRuntime(bare.deps, REGISTRY);
    const hid = hub.open('d_pc2', 'console');
    const none = hub.exec(hid, 'ping 10.0.0.1');
    expect(none.error?.message).toBe(MSG_NO_IP_STACK);
    expect(none.busy).toBe(false);
  });

  it('interrupt sends icmp.abort and unblocks even if the job never answers', () => {
    const { h, dev, cli, id } = pcSession();
    cli.exec(id, 'ping 10.0.0.2');
    h.trace.clear();
    h.clock.now = 3 * SEC;
    cli.interrupt(id);
    expect(dev.actionCalls[1]).toEqual({
      process: CLI_PROCESS_NAME,
      now: 3 * SEC,
      actions: [{ type: 'request', to: 'icmpv4', req: { kind: 'icmp.abort', session: id } }],
    });
    expect(cli.session(id)!.busy).toBe(false);
    expect(h.trace.of('cliPrompt')).toEqual([{ t: 3 * SEC, kind: 'cliPrompt', session: id, prompt: 'PC1>', busy: false }]);
  });

  it('interrupt lets the job answer with cliDone and does not double the prompt', () => {
    const { h, dev, cli, id } = pcSession();
    cli.exec(id, 'ping 10.0.0.2');
    dev.onRequest = (a, now) => {
      if (a.req.kind === 'icmp.abort') cli.onDone(id, now);
    };
    h.trace.clear();
    cli.interrupt(id);
    expect(h.trace.of('cliPrompt')).toHaveLength(1);
    expect(cli.session(id)!.busy).toBe(false);
    // Idle interrupt (^C on an empty line) simply re-issues the prompt.
    h.trace.clear();
    cli.interrupt(id);
    expect(dev.actionCalls).toHaveLength(2);
    expect(h.trace.of('cliPrompt')).toHaveLength(1);
  });
});

describe('cli/runtime debug', () => {
  function ev(device: string, category: string, message: string, at = 1_500_000): DebugEvent {
    return { at, device, process: 'arp', category, message };
  }

  function twoRouters() {
    const h = harness();
    h.add('d_r1', 'router', 'R1');
    h.add('d_r2', 'router', 'R2');
    const cli = createCliRuntime(h.deps, REGISTRY);
    const s1 = cli.open('d_r1', 'console');
    const s2 = cli.open('d_r1', 'vty');
    const s3 = cli.open('d_r2', 'console');
    for (const s of [s1, s2, s3]) cli.exec(s, 'enable');
    h.trace.clear();
    return { h, cli, s1, s2, s3 };
  }

  it('prints matching categories to every session of the device only', () => {
    const { h, cli, s1, s2, s3 } = twoRouters();
    expect(cli.exec(s1, 'debug arp').output).toBe('Debugging enabled for arp.');
    h.trace.clear();
    cli.onDebugEvent(ev('d_r1', 'arp', 'request who-has 10.0.0.2'));
    cli.onDebugEvent(ev('d_r1', 'ip icmp', 'echo request'));
    cli.onDebugEvent(ev('d_r2', 'arp', 'request who-has 10.0.0.9'));
    const line = '*00:00:00.001500: arp: request who-has 10.0.0.2';
    expect(h.trace.of('cliOutput')).toEqual([
      { t: 1_500_000, kind: 'cliOutput', session: s1, text: line },
      { t: 1_500_000, kind: 'cliOutput', session: s2, text: line },
    ]);
    expect(h.trace.of('cliOutput').some((e) => e.session === s3)).toBe(false);
  });

  it('matches categories exactly, all matches everything, and undebug all / no debug all stop it', () => {
    const { h, cli, s1 } = twoRouters();
    cli.exec(s1, 'debug ip');
    expect(cli.exec(s1, 'debug ip').error?.message).toBeDefined();
    cli.exec(s1, 'debug ip icmp');
    h.trace.clear();
    cli.onDebugEvent(ev('d_r1', 'ip packet', 'forwarded'));
    expect(h.trace.of('cliOutput')).toEqual([]);
    cli.onDebugEvent(ev('d_r1', 'ip icmp', 'echo reply'));
    expect(h.trace.of('cliOutput')).toHaveLength(2);

    expect(cli.exec(s1, 'debug all').output).toBe('Debugging enabled for all categories.');
    h.trace.clear();
    cli.onDebugEvent(ev('d_r1', 'ethernet switching', 'learned'));
    expect(h.trace.of('cliOutput')).toHaveLength(2);

    expect(cli.exec(s1, 'undebug all').output).toMatch(/turned off/);
    h.trace.clear();
    cli.onDebugEvent(ev('d_r1', 'ip icmp', 'echo reply'));
    cli.onDebugEvent(ev('d_r1', 'arp', 'reply'));
    expect(h.trace.of('cliOutput')).toEqual([]);

    cli.exec(s1, 'debug arp');
    expect(cli.exec(s1, 'no debug arp').output).toBe('Debugging disabled for arp.');
    cli.exec(s1, 'debug arp');
    expect(cli.exec(s1, 'no debug all').output).toMatch(/turned off/);
    h.trace.clear();
    cli.onDebugEvent(ev('d_r1', 'arp', 'reply'));
    expect(h.trace.of('cliOutput')).toEqual([]);
  });

  it('debug is privileged-exec only', () => {
    const h = harness();
    h.add('d_r1', 'router', 'R1');
    const cli = createCliRuntime(h.deps, REGISTRY);
    const id = cli.open('d_r1', 'console');
    expect(cli.exec(id, 'debug arp').error?.column).toBe(0);
  });
});
