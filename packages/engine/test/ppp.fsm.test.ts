// protocols/ppp/fsm.ts [S19] (ARCHITECTURE-P3 D17, §3.9 step 3, §4.2; §7 W1 wan): the RFC 1661 §4.1 state transition
// table, transcribed below as the RFC prints it and compared cell by cell; the counters of §4.6 (Max-Configure,
// Max-Terminate, Max-Failure) and the Restart timer; two automata negotiating LCP to Opened as §3.9 describes.
import { describe, expect, it } from 'vitest';
import type { PppFsmState } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import {
  PPP_FSM_EVENTS,
  PPP_FSM_STATES,
  PPP_INITIAL_AUTOMATON,
  PPP_MAX_CONFIGURE,
  PPP_MAX_FAILURE,
  PPP_MAX_TERMINATE,
  PPP_RESTART_NS,
  pppFsmApply,
  pppFsmCell,
  pppNakBecomesReject,
  pppTimeoutEvent,
  pppTimerRuns,
  type PppAutomaton,
  type PppFsmAction,
  type PppFsmEvent,
} from '../src/protocols/ppp/fsm.js';

/**
 * RFC 1661 §4.1, "State Transition Table", as printed (states 0–5, then 6–9). `-` = the event cannot happen; `r`,
 * `p` and `x` mark optional behaviours (restart, passive, crossed connection) the automaton does not take.
 */
const RFC_1661_TABLE_A = `
      | State
      |    0         1         2         3         4         5
Events| Initial   Starting  Closed    Stopped   Closing   Stopping
------+-----------------------------------------------------------
 Up   |    2     irc,scr/6     -         -         -         -
 Down |    -         -         0       tls/1       0         1
 Open |  tls/1       1     irc,scr/6     3r        5r        5r
 Close|    0       tlf/0       2         2         4         4
      |
  TO+ |    -         -         -         -       str/4     str/5
  TO- |    -         -         -         -       tlf/2     tlf/3
      |
 RCR+ |    -         -       sta/2 irc,scr,sca/8   4         5
 RCR- |    -         -       sta/2 irc,scr,scn/6   4         5
 RCA  |    -         -       sta/2     sta/3       4         5
 RCN  |    -         -       sta/2     sta/3       4         5
      |
 RTR  |    -         -       sta/2     sta/3     sta/4     sta/5
 RTA  |    -         -         2         3       tlf/2     tlf/3
      |
 RUC  |    -         -       scj/2     scj/3     scj/4     scj/5
 RXJ+ |    -         -         2         3         4         5
 RXJ- |    -         -       tlf/2     tlf/3     tlf/2     tlf/3
      |
 RXR  |    -         -         2         3         4         5
`;

const RFC_1661_TABLE_B = `
      | State
      |    6         7         8           9
Events| Req-Sent  Ack-Rcvd  Ack-Sent    Opened
------+-----------------------------------------
 Up   |    -         -         -           -
 Down |    1         1         1         tld/1
 Open |    6         7         8           9r
 Close|irc,str/4 irc,str/4 irc,str/4 tld,irc,str/4
      |
  TO+ |  scr/6     scr/6     scr/8         -
  TO- |  tlf/3p    tlf/3p    tlf/3p        -
      |
 RCR+ |  sca/8   sca,tlu/9   sca/8   tld,scr,sca/8
 RCR- |  scn/6     scn/7     scn/6   tld,scr,scn/6
 RCA  |  irc/7     scr/6x  irc,tlu/9   tld,scr/6x
 RCN  |irc,scr/6   scr/6x  irc,scr/8   tld,scr/6x
      |
 RTR  |  sta/6     sta/6     sta/6   tld,zrc,sta/5
 RTA  |    6         6         8       tld,scr/6
      |
 RUC  |  scj/6     scj/7     scj/8       scj/9
 RXJ+ |    6         6         8           9
 RXJ- |  tlf/3     tlf/3     tlf/3   tld,irc,str/5
      |
 RXR  |    6         7         8         ser/9
`;

interface ExpectedCell {
  readonly actions: readonly PppFsmAction[];
  readonly next: PppFsmState;
}

/** Parse the printed rows: `{event → [cell per state column]}`; a cell is undefined for `-`. */
function parseTable(text: string, firstState: number): Map<PppFsmEvent, (ExpectedCell | undefined)[]> {
  const out = new Map<PppFsmEvent, (ExpectedCell | undefined)[]>();
  for (const line of text.split('\n')) {
    const bar = line.indexOf('|');
    if (bar < 0) continue;
    const label = line.slice(0, bar).trim();
    if (label === '' || label === 'Events' || label.startsWith('-')) continue;
    const event = label.toLowerCase() as PppFsmEvent;
    const cells = line
      .slice(bar + 1)
      .trim()
      .split(/\s+/)
      .map((tok): ExpectedCell | undefined => {
        if (tok === '-') return undefined;
        const clean = tok.replace(/[rpx]$/, '');
        const slash = clean.lastIndexOf('/');
        const next = PPP_FSM_STATES[Number(slash < 0 ? clean : clean.slice(slash + 1))]!;
        const actions = slash < 0 ? [] : (clean.slice(0, slash).split(',') as PppFsmAction[]);
        return { actions, next };
      });
    out.set(event, cells);
    expect(cells.length, `${event} row, from state ${firstState}`).toBe(firstState === 0 ? 6 : 4);
  }
  return out;
}

describe('ppp fsm: the RFC 1661 §4.1 table', () => {
  const a = parseTable(RFC_1661_TABLE_A, 0);
  const b = parseTable(RFC_1661_TABLE_B, 6);

  it('the transcription has every event row and every state column', () => {
    expect([...a.keys()]).toEqual(PPP_FSM_EVENTS);
    expect([...b.keys()]).toEqual(PPP_FSM_EVENTS);
    expect(PPP_FSM_STATES).toEqual([
      'initial', 'starting', 'closed', 'stopped', 'closing', 'stopping', 'req-sent', 'ack-rcvd', 'ack-sent', 'opened',
    ]);
  });

  it('every one of the 160 cells equals the RFC (actions in order, next state; `-` cells are illegal)', () => {
    let checked = 0;
    for (const event of PPP_FSM_EVENTS) {
      const row = [...a.get(event)!, ...b.get(event)!];
      PPP_FSM_STATES.forEach((state, i) => {
        const want = row[i];
        const got = pppFsmCell(state, event);
        if (want === undefined) expect(got, `${event} in ${state}`).toBeUndefined();
        else expect(got === undefined ? undefined : { actions: [...got.actions], next: got.next }, `${event} in ${state}`).toEqual({ actions: [...want.actions], next: want.next });
        checked++;
      });
    }
    expect(checked).toBe(160);
  });

  it('pppFsmApply follows the table in every legal cell and changes nothing in a `-` cell', () => {
    for (const state of PPP_FSM_STATES) {
      for (const event of PPP_FSM_EVENTS) {
        const start: PppAutomaton = { state, restart: 3, failures: 1 };
        const r = pppFsmApply(start, event);
        const cell = pppFsmCell(state, event);
        expect(r.from).toBe(state);
        if (cell === undefined) {
          expect(r).toEqual({ automaton: start, actions: [], timer: 'keep', from: state, illegal: true });
        } else {
          expect(r.illegal).toBe(false);
          expect(r.automaton.state).toBe(cell.next);
          expect(r.actions).toEqual(cell.actions);
        }
      }
    }
  });
});

describe('ppp fsm: counters and the Restart timer (RFC 1661 §4.6)', () => {
  it('constants: Max-Configure 10, Max-Terminate 2, Max-Failure 5, restart 2 s (§4.2)', () => {
    expect([PPP_MAX_CONFIGURE, PPP_MAX_TERMINATE, PPP_MAX_FAILURE]).toEqual([10, 2, 5]);
    expect(PPP_RESTART_NS).toBe(2 * SEC);
    expect(PPP_INITIAL_AUTOMATON).toEqual({ state: 'initial', restart: 0, failures: 0 });
  });

  it('irc before scr sets Max-Configure, the first request counts, and the tenth timeout is TO-', () => {
    let m = pppFsmApply(PPP_INITIAL_AUTOMATON, 'up').automaton;
    const opened = pppFsmApply(m, 'open');
    expect(opened.actions).toEqual(['irc', 'scr']);
    expect(opened.timer).toBe('start');
    m = opened.automaton;
    expect(m).toEqual({ state: 'req-sent', restart: PPP_MAX_CONFIGURE - 1, failures: 0 });
    let sent = 1;
    while (pppTimeoutEvent(m) === 'to+') {
      const r = pppFsmApply(m, 'to+');
      expect(r.actions).toEqual(['scr']);
      expect(r.timer).toBe('start');
      m = r.automaton;
      sent++;
    }
    expect(sent).toBe(PPP_MAX_CONFIGURE);
    expect(m.restart).toBe(0);
    const last = pppFsmApply(m, pppTimeoutEvent(m));
    expect(last.actions).toEqual(['tlf']);
    expect(last.automaton.state).toBe('stopped');
    expect(last.timer).toBe('stop');
  });

  it('irc before str sets Max-Terminate: Close from Opened sends two Terminate-Requests, then Closed', () => {
    let m: PppAutomaton = { state: 'opened', restart: 0, failures: 0 };
    const close = pppFsmApply(m, 'close');
    expect(close.actions).toEqual(['tld', 'irc', 'str']);
    expect(close.timer).toBe('start');
    m = close.automaton;
    expect(m).toEqual({ state: 'closing', restart: PPP_MAX_TERMINATE - 1, failures: 0 });
    const again = pppFsmApply(m, pppTimeoutEvent(m));
    expect(again.actions).toEqual(['str']);
    m = again.automaton;
    expect(m.restart).toBe(0);
    const done = pppFsmApply(m, pppTimeoutEvent(m));
    expect(done.actions).toEqual(['tlf']);
    expect(done.automaton.state).toBe('closed');
    expect(done.timer).toBe('stop');
  });

  it('a Terminate-Request in Opened zeroes the counter and starts the timer, whose expiry finishes the layer', () => {
    const r = pppFsmApply({ state: 'opened', restart: 7, failures: 0 }, 'rtr');
    expect(r.actions).toEqual(['tld', 'zrc', 'sta']);
    expect(r.automaton).toEqual({ state: 'stopping', restart: 0, failures: 0 });
    expect(r.timer).toBe('start');
    expect(pppTimeoutEvent(r.automaton)).toBe('to-');
    const f = pppFsmApply(r.automaton, 'to-');
    expect(f.actions).toEqual(['tlf']);
    expect(f.automaton.state).toBe('stopped');
  });

  it('the timer runs only in Closing, Stopping, Req-Sent, Ack-Rcvd and Ack-Sent', () => {
    expect(PPP_FSM_STATES.filter(pppTimerRuns)).toEqual(['closing', 'stopping', 'req-sent', 'ack-rcvd', 'ack-sent']);
    // Req-Sent → Ack-Rcvd on RCA keeps the running timer (no request is sent); Ack-Sent → Opened stops it.
    expect(pppFsmApply({ state: 'req-sent', restart: 9, failures: 0 }, 'rca').timer).toBe('keep');
    expect(pppFsmApply({ state: 'ack-sent', restart: 9, failures: 0 }, 'rca').timer).toBe('stop');
    expect(pppFsmApply({ state: 'closed', restart: 0, failures: 0 }, 'rcr+').timer).toBe('stop');
  });

  it('naks sent count toward Max-Failure; an ack sent or a fresh negotiation resets the count, a received Ack or Nak (irc) does not', () => {
    let m: PppAutomaton = { state: 'req-sent', restart: 9, failures: 0 };
    for (let i = 0; i < PPP_MAX_FAILURE; i++) {
      expect(pppNakBecomesReject(m)).toBe(false);
      m = pppFsmApply(m, 'rcr-').automaton;
    }
    expect(m.failures).toBe(PPP_MAX_FAILURE);
    expect(pppNakBecomesReject(m)).toBe(true);
    expect(pppFsmApply(m, 'rcr+').automaton.failures).toBe(0);
    // RFC 1661 §4.6: Max-Failure counts naks sent without a Configure-Ack SENT; `irc` on a received Ack or Nak keeps it
    expect(pppFsmApply(m, 'rcn').automaton.failures).toBe(PPP_MAX_FAILURE);
    expect(pppFsmApply(m, 'rca').automaton).toMatchObject({ state: 'ack-rcvd', failures: PPP_MAX_FAILURE });
    expect(pppFsmApply({ state: 'ack-sent', restart: 9, failures: 2 }, 'rcn').automaton.failures).toBe(2);
    // a fresh negotiation (a Configure-Request from a state that was not negotiating) starts from zero
    expect(pppFsmApply({ state: 'stopped', restart: 0, failures: 3 }, 'rcr-').automaton.failures).toBe(1);
    expect(pppFsmApply({ state: 'stopped', restart: 0, failures: 3 }, 'rcr+').automaton.failures).toBe(0);
    expect(pppFsmApply({ state: 'closed', restart: 0, failures: 3 }, 'open').automaton.failures).toBe(0);
    expect(pppFsmApply({ state: 'starting', restart: 0, failures: 3 }, 'up').automaton.failures).toBe(0);
    expect(pppFsmApply({ state: 'opened', restart: 0, failures: 3 }, 'rcr-').automaton.failures).toBe(1);
  });
});

describe('ppp fsm: two ends negotiate (§3.9 step 3)', () => {
  it('both ends Up and Open, exchange Configure-Request and Configure-Ack, and reach Opened with tlu', () => {
    // Each end: Initial → (Up) Closed → (Open) Req-Sent, sending its Configure-Request.
    let r1 = pppFsmApply(pppFsmApply(PPP_INITIAL_AUTOMATON, 'up').automaton, 'open');
    let r2 = pppFsmApply(pppFsmApply(PPP_INITIAL_AUTOMATON, 'up').automaton, 'open');
    expect([r1.automaton.state, r2.automaton.state]).toEqual(['req-sent', 'req-sent']);
    expect(r1.actions).toContain('scr');
    // Each receives the other's acceptable request: Ack-Sent.
    r1 = pppFsmApply(r1.automaton, 'rcr+');
    r2 = pppFsmApply(r2.automaton, 'rcr+');
    expect(r1.actions).toEqual(['sca']);
    expect([r1.automaton.state, r2.automaton.state]).toEqual(['ack-sent', 'ack-sent']);
    // Each receives the ack of its own request: Opened, This-Layer-Up.
    r1 = pppFsmApply(r1.automaton, 'rca');
    r2 = pppFsmApply(r2.automaton, 'rca');
    expect(r1.actions).toEqual(['irc', 'tlu']);
    expect([r1.automaton.state, r2.automaton.state]).toEqual(['opened', 'opened']);
    expect(r1.timer).toBe('stop');
  });

  it('the other order (ack first) also opens: Req-Sent → Ack-Rcvd → Opened', () => {
    let m = pppFsmApply(pppFsmApply(PPP_INITIAL_AUTOMATON, 'open').automaton, 'up');
    expect(m.automaton.state).toBe('req-sent');
    expect(m.actions).toEqual(['irc', 'scr']);
    m = pppFsmApply(m.automaton, 'rca');
    expect(m.automaton.state).toBe('ack-rcvd');
    m = pppFsmApply(m.automaton, 'rcr+');
    expect(m.actions).toEqual(['sca', 'tlu']);
    expect(m.automaton.state).toBe('opened');
  });

  it('lower layer down in Opened: tld and Starting; up again renegotiates', () => {
    const down = pppFsmApply({ state: 'opened', restart: 0, failures: 0 }, 'down');
    expect(down.actions).toEqual(['tld']);
    expect(down.automaton.state).toBe('starting');
    const up = pppFsmApply(down.automaton, 'up');
    expect(up.actions).toEqual(['irc', 'scr']);
    expect(up.automaton.state).toBe('req-sent');
  });

  it('a packet before the lower layer is up is illegal and ignored', () => {
    const r = pppFsmApply(PPP_INITIAL_AUTOMATON, 'rcr+');
    expect(r.illegal).toBe(true);
    expect(r.automaton).toBe(PPP_INITIAL_AUTOMATON);
    expect(r.actions).toEqual([]);
  });
});
