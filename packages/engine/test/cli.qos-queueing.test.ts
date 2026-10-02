/**
 * cli.qos-queueing — [S20]/[S21] the queueing actions of a policy-map class and interface WFQ (ARCHITECTURE-P3 §5.4,
 * D16; §7 W2 cli, approved items): grammar forms (keyword forms before rates), the canonical stored lines, the class
 * rules (priority or bandwidth, no priority in class-default, fair-queue in class-default only), the policer's full
 * stored form, and interface `fair-queue` on routed physical ports and serial lines only.
 */
import { describe, expect, it } from 'vitest';
import { QOS_QUEUEING_HANDLERS as H, QUEUEING_CLASS_MODE, RATE_FORM_ARG, MSG_FAIR_QUEUE_PORT } from '../src/cli/grammar/qos-queueing.js';
import {
  MSG_FAIR_QUEUE_DEFAULT_ONLY,
  MSG_NO_POLICY_CLASS,
  MSG_POLICE_SYNTAX,
  MSG_PRIORITY_NOT_DEFAULT,
  MSG_PRIORITY_OR_BANDWIDTH,
  policeTail,
} from '../src/cli/handlers/qos-queueing.js';
import { approvedCtx, body, handlerOf, parse, run } from './cli.p3-approved.fixture.js';
import type { RecordingCtx } from './cli.p05.fixture.js';

const R = 'router.nf2911';

/** A recording context inside `policy-map P` / `class <cls>`, the policy stored. */
function inClass(cls: string, running?: RecordingCtx['running']): RecordingCtx {
  const g = approvedCtx(R, running === undefined ? {} : { running });
  g.ctx.config(['policy-map', 'P'], false, []);
  g.ctx.config(['class', cls], false, [['policy-map', 'P']]);
  return approvedCtx(R, { mode: QUEUEING_CLASS_MODE, context: [['policy-map', 'P'], ['class', cls]], running: g.running });
}

describe('cli.qos-queueing grammar', () => {
  it('parses the class actions with the keyword forms first', () => {
    const m = (line: string) => parse(R, QUEUEING_CLASS_MODE, line);
    const ok = (line: string) => {
      const r = m(line);
      if (!r.ok) throw new Error(`${line}: ${r.error.message}`);
      return r;
    };
    expect(ok('priority percent 30').args).toMatchObject({ percent: '30', [RATE_FORM_ARG]: 'percent' });
    expect(ok('priority 256').args).toMatchObject({ kbps: '256', [RATE_FORM_ARG]: 'kbps' });
    expect(ok('bandwidth remaining percent 40').args).toMatchObject({ percent: '40', [RATE_FORM_ARG]: 'remaining' });
    expect(ok('bandwidth percent 20').args).toMatchObject({ percent: '20', [RATE_FORM_ARG]: 'percent' });
    expect(ok('bandwidth 512').args).toMatchObject({ kbps: '512', [RATE_FORM_ARG]: 'kbps' });
    expect(ok('queue-limit 64').spec.handler).toBe(H.pmapClassQueueLimit);
    expect(ok('fair-queue').spec.handler).toBe(H.pmapClassFairQueue);
    expect(ok('police 64000').spec.handler).toBe(H.pmapClassPolice);
    expect(ok('police 64000 8000 conform-action transmit exceed-action set-dscp-transmit af11').args['actions']).toBe(
      '8000 conform-action transmit exceed-action set-dscp-transmit af11',
    );
    expect(ok('shape average 512000').spec.handler).toBe(H.pmapClassShape);
    expect(ok('shape average 512000 6400').args['burst']).toBe('6400');
    expect(m('priority percent 101').ok).toBe(false);
    expect(m('queue-limit 0').ok).toBe(false);
  });

  it('interface fair-queue exists on routed physical ports and serial lines only', () => {
    expect(handlerOf(R, 'config-if', 'fair-queue', { iface: 'GigabitEthernet0/0' })).toBe(H.ifFairQueue);
    expect(handlerOf(R, 'config-if', 'fair-queue', { iface: 'Serial0/0/0' })).toBe(H.ifFairQueue);
    const sw = parse('switch.nfc2960', 'config-if', 'fair-queue', { iface: 'FastEthernet0/1' });
    expect(sw.ok).toBe(false);
    const svi = parse('mlswitch.nfc3650-24', 'config-if', 'fair-queue', { iface: 'Vlan1' });
    expect(svi.ok).toBe(false);
    if (!svi.ok) expect(svi.error.message).toBe(MSG_FAIR_QUEUE_PORT);
  });
});

describe('cli.qos-queueing handlers', () => {
  it('stores an LLQ class and a CBWFQ class in canonical form', () => {
    const voice = inClass('VOICE');
    expect(run(voice, H.pmapClassPriority, { percent: '30', [RATE_FORM_ARG]: 'percent' })).toEqual({});
    expect(run(voice, H.pmapClassBandwidth, { kbps: '512', [RATE_FORM_ARG]: 'kbps' })).toEqual({ error: MSG_PRIORITY_OR_BANDWIDTH });
    const data = inClass('DATA', voice.running);
    expect(run(data, H.pmapClassBandwidth, { percent: '40', [RATE_FORM_ARG]: 'remaining' })).toEqual({});
    expect(run(data, H.pmapClassPriority, { kbps: '64', [RATE_FORM_ARG]: 'kbps' })).toEqual({ error: MSG_PRIORITY_OR_BANDWIDTH });
    expect(run(data, H.pmapClassQueueLimit, { packets: '64' })).toEqual({});
    expect(run(data, H.pmapClassShape, { bps: '512000' })).toEqual({});
    expect(run(data, H.pmapClassPolice, { bps: '128000', actions: 'conform-action set-dscp-transmit 10' })).toEqual({});
    expect(run(data, H.pmapClassPolice, { bps: '128000', actions: 'conform-action resend' })).toEqual({ error: MSG_POLICE_SYNTAX });
    const dflt = inClass('class-default', voice.running);
    expect(run(dflt, H.pmapClassPriority, { kbps: '64', [RATE_FORM_ARG]: 'kbps' })).toEqual({ error: MSG_PRIORITY_NOT_DEFAULT });
    expect(run(dflt, H.pmapClassFairQueue, {})).toEqual({});
    expect(run(data, H.pmapClassFairQueue, {})).toEqual({ error: MSG_FAIR_QUEUE_DEFAULT_ONLY });
    expect(body(voice)).toEqual([
      'policy-map P',
      ' class VOICE',
      '  priority percent 30',
      ' class DATA',
      '  bandwidth remaining percent 40',
      '  shape average 512000',
      '  police 128000 conform-action set-dscp-transmit 10 exceed-action drop',
      '  queue-limit 64',
      ' class class-default',
      '  fair-queue',
    ]);
    for (const id of [H.pmapClassBandwidth, H.pmapClassShape, H.pmapClassPolice, H.pmapClassQueueLimit]) run(data, id, {}, true);
    run(voice, H.pmapClassPriority, {}, true);
    run(dflt, H.pmapClassFairQueue, {}, true);
    expect(body(voice)).toEqual(['policy-map P', ' class VOICE', ' class DATA', ' class class-default']);
  });

  it('refuses class actions outside a policy-map class', () => {
    expect(run(approvedCtx(R), H.pmapClassQueueLimit, { packets: '10' })).toEqual({ error: MSG_NO_POLICY_CLASS });
  });

  it('reads a policer tail into its full stored form', () => {
    expect(policeTail('')).toEqual(['conform-action', 'transmit', 'exceed-action', 'drop']);
    expect(policeTail('8000')).toEqual(['8000', 'conform-action', 'transmit', 'exceed-action', 'drop']);
    expect(policeTail('conform-action transmit exceed-action set-dscp-transmit af11')).toEqual([
      'conform-action', 'transmit', 'exceed-action', 'set-dscp-transmit', 'af11',
    ]);
    expect(policeTail('8000 exceed-action transmit')).toEqual(['8000', 'conform-action', 'transmit', 'exceed-action', 'transmit']);
    expect(policeTail('exceed-action drop conform-action drop')).toBeUndefined();
    expect(policeTail('conform-action set-dscp-transmit 64')).toBeUndefined();
    expect(policeTail('10')).toBeUndefined(); // a burst below the minimum
  });

  it('writes interface fair-queue', () => {
    const r = approvedCtx(R, { iface: 'Serial0/0/0' });
    expect(run(r, H.ifFairQueue, {})).toEqual({});
    expect(r.running.render()).toContain('interface Serial0/0/0\n fair-queue');
    run(r, H.ifFairQueue, {}, true);
    expect(r.running.render()).not.toContain('fair-queue');
  });
});
