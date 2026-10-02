/**
 * The host-shell traffic generator (ARCHITECTURE-P3 §5.4, §5.9, D16, M13; §7 W2 cli part 1, cli/grammar/qos.ts and
 * cli/handlers/qos.ts): `flow start <dst> (rate <kbps>|pps <n>) size <bytes> [dscp <v>] [port <p>] [count <n>|for
 * <s>]`, `flow voice <dst> [g711] [dscp <v>]`, `flow stop <id>` — short jobs on the traffic daemon (`traffic.start` /
 * `traffic.stop` with the session; the daemon prints one line and ends the job) — the 5-minute cap refused with
 * `trafficFlowCap` before any job starts, and `flow show` over the traffic StateView. The traffic daemon itself is the
 * W2 svc item's (app.traffic.test.ts); here it is a recording fake.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CliJob, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import { TRAFFIC_MAX_DURATION_MS, type ProcessRequest, type StateView } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { flowBeyondCap, flowPacingNs, FLOW_JOB_LABEL, MSG_NO_FLOW, paceText } from '../src/cli/handlers/qos.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const PC = catalogModel('pc.nfpc');
const SERVER = catalogModel('server.nfserver');
const ROUTER = catalogModel('router.nf2911');
const CAP = CLI_MESSAGES.trafficFlowCap.replace('{minutes}', String(TRAFFIC_MAX_DURATION_MS / 60_000));
const JOB: CliJob = { process: 'traffic', abort: { kind: 'job.abort', session: 's_1' }, label: FLOW_JOB_LABEL };

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, negate);
}

/** A host command context that records the jobs it blocks on. */
function host(states: Record<string, StateView> = {}): { rec: RecordingCtx; jobs: (CliJob | undefined)[] } {
  const rec = commandCtxFor(PC, { mode: 'user-exec', processStates: states });
  const jobs: (CliJob | undefined)[] = [];
  (rec.ctx as { block: (job?: CliJob) => void }).block = (job) => { jobs.push(job); };
  return { rec, jobs };
}

function typed(rec: RecordingCtx, line: string): CommandOutcome {
  const m = matchCommand(GRAMMAR, matchContextFor(rec.ctx.model, 'user-exec'), line);
  if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
  return run(rec, m.spec.handler, { ...m.args }, m.negated);
}

const ok = (line: string, model = PC) => matchCommand(GRAMMAR, matchContextFor(model, 'user-exec'), line);
const startOf = (rec: RecordingCtx, i = 0) => (rec.requests[i]?.req as Extract<ProcessRequest, { kind: 'traffic.start' }>).flow;

describe('parsing and scope', () => {
  it('parses every form on hosts, in the fixed keyword order', () => {
    for (const model of [PC, SERVER]) {
      expect(ok('flow start 10.0.0.2 rate 512 size 200', model)).toMatchObject({ ok: true, spec: { handler: HANDLERS.hostFlowStart, job: true }, args: { dst: '10.0.0.2', form: 'rate', kbps: '512', bytes: '200' } });
    }
    expect(ok('flow start 10.0.0.2 pps 50 size 60 dscp ef port 5000 count 100')).toMatchObject({ ok: true, args: { form: 'pps', pps: '50', dscp: 'ef', port: '5000', count: '100' } });
    expect(ok('flow start 10.0.0.2 rate 64 size 1500 dscp 34 for 30')).toMatchObject({ ok: true, args: { dscp: '34', seconds: '30' } });
    expect(ok('flow voice 10.0.0.2')).toMatchObject({ ok: true, spec: { handler: HANDLERS.hostFlowVoice, job: true }, args: { form: 'voice-g729' } });
    expect(ok('flow voice 10.0.0.2 g711 dscp af41')).toMatchObject({ ok: true, args: { form: 'voice-g711', dscp: 'af41' } });
    expect(ok('flow stop f1')).toMatchObject({ ok: true, spec: { handler: HANDLERS.hostFlowStop, job: true }, args: { id: 'f1' } });
    expect(ok('flow show')).toMatchObject({ ok: true, spec: { handler: HANDLERS.hostFlowShow } });
    // the per-flow caps of §2.4 are the grammar's bounds
    for (const bad of [
      'flow start 10.0.0.2 rate 2001 size 200',
      'flow start 10.0.0.2 pps 1001 size 200',
      'flow start 10.0.0.2 rate 64 size 59',
      'flow start 10.0.0.2 rate 64 size 1501',
      'flow start 10.0.0.2 rate 64 size 200 dscp 64',
      'flow start 10.0.0.2 rate 64 size 200 count 5 for 3',
      'flow start 10.0.0.2 rate 64 size 200 port 5000 dscp ef',
    ]) {
      expect(ok(bad).ok, bad).toBe(false);
    }
    expect(ok('flow show', ROUTER).ok).toBe(false);
  });
});

describe('flow start and flow voice', () => {
  it('block on the traffic daemon, then send traffic.start with the flow and the session', () => {
    const { rec, jobs } = host();
    expect(typed(rec, 'flow start 10.0.0.2 pps 50 size 60 dscp ef port 5000 count 100')).toEqual({});
    expect(jobs).toEqual([JOB]);
    expect(rec.requests).toEqual([
      { to: 'traffic', req: { kind: 'traffic.start', flow: { dst: '10.0.0.2', sizeBytes: 60, pps: 50, dscp: 46, dstPort: 5000, count: 100 }, session: 's_1' } },
    ]);
    typed(rec, 'flow start 10.0.0.3 rate 512 size 200');
    expect(startOf(rec, 1)).toEqual({ dst: '10.0.0.3', sizeBytes: 200, rateKbps: 512 });
    typed(rec, 'flow start 10.0.0.3 rate 64 size 1500 dscp af41 for 30');
    expect(startOf(rec, 2)).toEqual({ dst: '10.0.0.3', sizeBytes: 1500, rateKbps: 64, dscp: 34, durationMs: 30_000 });
    expect(jobs).toHaveLength(3);
  });

  it('voice presets: 50 pps, 60 or 200 bytes, DSCP ef unless given', () => {
    const { rec } = host();
    typed(rec, 'flow voice 10.0.0.2');
    typed(rec, 'flow voice 10.0.0.2 g711');
    typed(rec, 'flow voice 10.0.0.2 g711 dscp cs3');
    expect(startOf(rec, 0)).toEqual({ dst: '10.0.0.2', sizeBytes: 60, pps: 50, dscp: 46, preset: 'voice-g729' });
    expect(startOf(rec, 1)).toEqual({ dst: '10.0.0.2', sizeBytes: 200, pps: 50, dscp: 46, preset: 'voice-g711' });
    expect(startOf(rec, 2)).toMatchObject({ dscp: 24, preset: 'voice-g711' });
  });

  it('refuse a count or a duration beyond the 5-minute cap before any job starts (trafficFlowCap)', () => {
    const { rec, jobs } = host();
    expect(typed(rec, 'flow start 10.0.0.2 rate 64 size 200 for 301')).toEqual({ error: CAP });
    expect(typed(rec, 'flow start 10.0.0.2 pps 1 size 60 count 301')).toEqual({ error: CAP });
    // 1500 bytes at 64 kb/s leave every 187.5 ms: 1600 datagrams take exactly 300 s, 1601 do not fit
    expect(typed(rec, 'flow start 10.0.0.2 rate 64 size 1500 count 1601')).toEqual({ error: CAP });
    expect(jobs).toEqual([]);
    expect(rec.requests).toEqual([]);
    expect(typed(rec, 'flow start 10.0.0.2 rate 64 size 1500 count 1600')).toEqual({});
    expect(typed(rec, 'flow start 10.0.0.2 pps 1 size 60 count 300')).toEqual({});
    expect(typed(rec, 'flow start 10.0.0.2 rate 64 size 200 for 300')).toEqual({});
    expect(typed(rec, 'flow start 10.0.0.2 rate 64 size 200')).toEqual({});
    expect(jobs).toHaveLength(4);
  });

  it('the pacing and cap helpers follow §2.4', () => {
    expect(flowPacingNs({ sizeBytes: 1500, rateKbps: 64 })).toBe(187_500_000);
    expect(flowPacingNs({ sizeBytes: 60, pps: 50 })).toBe(20_000_000);
    expect(flowPacingNs({ sizeBytes: 100, pps: 3 })).toBe(333_333_333);
    expect(flowBeyondCap({ dst: '10.0.0.2', sizeBytes: 60, pps: 50 })).toBe(false);
    expect(flowBeyondCap({ dst: '10.0.0.2', sizeBytes: 60, pps: 50, count: 15_000 })).toBe(false);
    expect(flowBeyondCap({ dst: '10.0.0.2', sizeBytes: 60, pps: 50, count: 15_001 })).toBe(true);
    expect(flowBeyondCap({ dst: '10.0.0.2', sizeBytes: 60, pps: 50, durationMs: TRAFFIC_MAX_DURATION_MS })).toBe(false);
    expect(paceText(20_000_000)).toBe('20 ms');
    expect(paceText(187_500_000)).toBe('187.5 ms');
    expect(paceText(333_333_333)).toBe('333.333333 ms');
  });
});

describe('flow stop and flow show', () => {
  it('flow stop is a job sending traffic.stop', () => {
    const { rec, jobs } = host();
    expect(typed(rec, 'flow stop f2')).toEqual({});
    expect(jobs).toEqual([JOB]);
    expect(rec.requests).toEqual([{ to: 'traffic', req: { kind: 'traffic.stop', id: 'f2', session: 's_1' } }]);
  });

  it('flow show lists the traffic StateView flows; none without a flow', () => {
    expect(typed(host().rec, 'flow show')).toEqual({ output: MSG_NO_FLOW });
    const sv: StateView = {
      process: 'traffic',
      state: {
        flows: [
          { id: 'f1', dst: '10.0.0.2', dstPort: 9, sizeBytes: 60, dscp: 46, paceNs: 20_000_000, mode: 'continuous', limit: 15_000, sent: 120, errors: 0, state: 'running', startedAt: 0 },
          { id: 'f2', dst: '10.0.0.3', dstPort: 5000, sizeBytes: 1500, dscp: 0, paceNs: 187_500_000, mode: 'count', limit: 10, sent: 10, errors: 0, state: 'ended', startedAt: 0, endedAt: 2 * SEC },
        ],
        receiving: 0,
        received: 0,
      },
    };
    const { rec, jobs } = host({ traffic: sv });
    expect(typed(rec, 'flow show').output!.split('\n').map((l) => l.replace(/\s+$/, ''))).toEqual([
      'Flow  Destination  Port  Size  Every     DSCP  Sent  State',
      'f1    10.0.0.2     9     60    20 ms     46    120   running',
      'f2    10.0.0.3     5000  1500  187.5 ms  0     10    ended',
    ]);
    expect(jobs).toEqual([]);
  });
});

describe('on a real P3-stage PC', () => {
  it('a flow job holds the terminal until the daemon ends it; Ctrl+C frees it', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3' });
    const pc = sim.addDevice({ type: 'pc.nfpc', name: 'PC1' });
    sim.runFor(30 * SEC);
    const s = sim.cli.open(pc, 'console');
    expect(sim.cli.exec(s, 'flow start 10.0.0.2 rate 64 size 200 for 301').output).toContain(CAP);
    expect(sim.cli.session(s)?.busy).toBe(false);
    const started = sim.cli.exec(s, 'flow start 10.0.0.2 rate 64 size 200 count 10');
    expect(started.error).toBeUndefined();
    // this stage's catalog registers no traffic daemon before the W4 flip, so nothing ends the job
    expect(started.busy).toBe(true);
    expect(sim.cli.session(s)?.job).toEqual({ process: 'traffic', label: FLOW_JOB_LABEL });
    sim.cli.interrupt(s);
    expect(sim.cli.session(s)?.busy).toBe(false);
  });
});
