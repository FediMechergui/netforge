/**
 * protocols/ppp/fsm.ts — the RFC 1661 option-negotiation automaton [S19] (ARCHITECTURE-P3 D17, §3.9, §4.2; §7 W1 wan).
 *
 * One pure automaton serves LCP and the network control protocols (IPCP, IPV6CP): the W3 `ppp` daemon keeps one
 * `PppAutomaton` per protocol per port, feeds it the RFC 1661 §4.1 events and performs the actions it returns (send a
 * Configure-Request, report This-Layer-Up, …). The table below is RFC 1661 §4.1 cell for cell, without the optional
 * behaviours the RFC marks `r` (restart), `p` (passive) and `x` (crossed connection): those cells take the base
 * transition. `ppp.fsm.test.ts` transcribes the RFC table as text and compares all 160 cells with it.
 *
 * Counters (RFC 1661 §4.6):
 *   - `irc` sets the Restart counter to Max-Terminate (2) when the action list goes on to send a Terminate-Request
 *     (`str`), otherwise to Max-Configure (10); every Configure-Request or Terminate-Request sent (`scr`, `str`)
 *     decrements it, the first one included, so a Req-Sent automaton sends at most Max-Configure requests before its
 *     next timeout is TO− (`pppTimeoutEvent`); `zrc` sets it to zero.
 *   - The Restart timer (`lcp-restart:<p>` / `ipcp-restart:<p>`, 2 s, never periodic, §4.2) is (re)started by every
 *     `scr`, `str` and `zrc`, and stopped on entering a state in which it does not run (RFC 1661 §4.1: it runs only in
 *     Closing, Stopping, Req-Sent, Ack-Rcvd and Ack-Sent); `PppFsmResult.timer` says which.
 *   - The failure counter counts Configure-Naks sent (`scn`) without a Configure-Ack sent in between (RFC 1661 §4.6
 *     Max-Failure): it is zeroed by `sca` and when a fresh negotiation starts (an `scr` sent from a state that was
 *     not negotiating: Starting, Closed, Stopped or Opened), never by `irc` itself (a received Configure-Ack or Nak in
 *     Req-Sent keeps it, as pppd's `nakloops`); at Max-Failure (5) the daemon rejects the options it would have naked
 *     (`pppNakBecomesReject`).
 *
 * An event in a cell the RFC marks `-` cannot happen in that state (for example a packet before the lower layer is
 * up): `pppFsmApply` changes nothing, returns no action and sets `illegal`, and the daemon writes a debug line.
 *
 * Pure: no module state, no randomness, no clock.
 */
import type { PppFsmState } from '../../contracts/tables.js';
import { SEC } from '../../contracts/time.js';
import type { SimTime } from '../../contracts/time.js';

/** RFC 1661 §4.1 events, lower-case (`to+` = TO+, `rcr+` = RCR+, …). */
export type PppFsmEvent =
  | 'up'
  | 'down'
  | 'open'
  | 'close'
  | 'to+'
  | 'to-'
  | 'rcr+'
  | 'rcr-'
  | 'rca'
  | 'rcn'
  | 'rtr'
  | 'rta'
  | 'ruc'
  | 'rxj+'
  | 'rxj-'
  | 'rxr';

/** RFC 1661 §4.1 actions: layer up / down / started / finished, counters, and the packets to send. */
export type PppFsmAction = 'tlu' | 'tld' | 'tls' | 'tlf' | 'irc' | 'zrc' | 'scr' | 'sca' | 'scn' | 'str' | 'sta' | 'scj' | 'ser';

/** Every event, in the RFC table's row order. */
export const PPP_FSM_EVENTS: readonly PppFsmEvent[] = Object.freeze([
  'up', 'down', 'open', 'close', 'to+', 'to-', 'rcr+', 'rcr-', 'rca', 'rcn', 'rtr', 'rta', 'ruc', 'rxj+', 'rxj-', 'rxr',
]);

/** Every state, in the RFC's numbering (0 Initial … 9 Opened). */
export const PPP_FSM_STATES: readonly PppFsmState[] = Object.freeze([
  'initial', 'starting', 'closed', 'stopped', 'closing', 'stopping', 'req-sent', 'ack-rcvd', 'ack-sent', 'opened',
]);

/** Max-Configure (RFC 1661 §4.6): Configure-Requests sent before giving up. */
export const PPP_MAX_CONFIGURE = 10;
/** Max-Terminate (RFC 1661 §4.6): Terminate-Requests sent before giving up. */
export const PPP_MAX_TERMINATE = 2;
/** Max-Failure (RFC 1661 §4.6): Configure-Naks sent before naked options are rejected instead. */
export const PPP_MAX_FAILURE = 5;
/** The Restart timer (§4.2: `lcp-restart:<p>`, `ipcp-restart:<p>`). */
export const PPP_RESTART_NS: SimTime = 2 * SEC;

/** States in which the Restart timer runs (RFC 1661 §4.1). */
const TIMER_STATES: ReadonlySet<PppFsmState> = new Set<PppFsmState>(['closing', 'stopping', 'req-sent', 'ack-rcvd', 'ack-sent']);

/** States in which a negotiation is under way: a Configure-Request sent from any other state starts a fresh one. */
const NEGOTIATING_STATES: ReadonlySet<PppFsmState> = new Set<PppFsmState>(['req-sent', 'ack-rcvd', 'ack-sent']);

/** One cell of the table: the actions in order, then the next state. */
export interface PppFsmCell {
  readonly actions: readonly PppFsmAction[];
  readonly next: PppFsmState;
}

type Row = Readonly<Partial<Record<PppFsmState, PppFsmCell>>>;

const c = (next: PppFsmState, ...actions: PppFsmAction[]): PppFsmCell => Object.freeze({ actions: Object.freeze(actions), next });

/**
 * RFC 1661 §4.1, one row per event; a state missing from a row is a `-` cell. The optional `r`, `p` and `x`
 * behaviours are not taken (their cells hold the base transition).
 */
const TABLE: Readonly<Record<PppFsmEvent, Row>> = Object.freeze({
  up: { initial: c('closed'), starting: c('req-sent', 'irc', 'scr') },
  down: {
    closed: c('initial'),
    stopped: c('starting', 'tls'),
    closing: c('initial'),
    stopping: c('starting'),
    'req-sent': c('starting'),
    'ack-rcvd': c('starting'),
    'ack-sent': c('starting'),
    opened: c('starting', 'tld'),
  },
  open: {
    initial: c('starting', 'tls'),
    starting: c('starting'),
    closed: c('req-sent', 'irc', 'scr'),
    stopped: c('stopped'),
    closing: c('stopping'),
    stopping: c('stopping'),
    'req-sent': c('req-sent'),
    'ack-rcvd': c('ack-rcvd'),
    'ack-sent': c('ack-sent'),
    opened: c('opened'),
  },
  close: {
    initial: c('initial'),
    starting: c('initial', 'tlf'),
    closed: c('closed'),
    stopped: c('closed'),
    closing: c('closing'),
    stopping: c('closing'),
    'req-sent': c('closing', 'irc', 'str'),
    'ack-rcvd': c('closing', 'irc', 'str'),
    'ack-sent': c('closing', 'irc', 'str'),
    opened: c('closing', 'tld', 'irc', 'str'),
  },
  'to+': {
    closing: c('closing', 'str'),
    stopping: c('stopping', 'str'),
    'req-sent': c('req-sent', 'scr'),
    'ack-rcvd': c('req-sent', 'scr'),
    'ack-sent': c('ack-sent', 'scr'),
  },
  'to-': {
    closing: c('closed', 'tlf'),
    stopping: c('stopped', 'tlf'),
    'req-sent': c('stopped', 'tlf'),
    'ack-rcvd': c('stopped', 'tlf'),
    'ack-sent': c('stopped', 'tlf'),
  },
  'rcr+': {
    closed: c('closed', 'sta'),
    stopped: c('ack-sent', 'irc', 'scr', 'sca'),
    closing: c('closing'),
    stopping: c('stopping'),
    'req-sent': c('ack-sent', 'sca'),
    'ack-rcvd': c('opened', 'sca', 'tlu'),
    'ack-sent': c('ack-sent', 'sca'),
    opened: c('ack-sent', 'tld', 'scr', 'sca'),
  },
  'rcr-': {
    closed: c('closed', 'sta'),
    stopped: c('req-sent', 'irc', 'scr', 'scn'),
    closing: c('closing'),
    stopping: c('stopping'),
    'req-sent': c('req-sent', 'scn'),
    'ack-rcvd': c('ack-rcvd', 'scn'),
    'ack-sent': c('req-sent', 'scn'),
    opened: c('req-sent', 'tld', 'scr', 'scn'),
  },
  rca: {
    closed: c('closed', 'sta'),
    stopped: c('stopped', 'sta'),
    closing: c('closing'),
    stopping: c('stopping'),
    'req-sent': c('ack-rcvd', 'irc'),
    'ack-rcvd': c('req-sent', 'scr'),
    'ack-sent': c('opened', 'irc', 'tlu'),
    opened: c('req-sent', 'tld', 'scr'),
  },
  rcn: {
    closed: c('closed', 'sta'),
    stopped: c('stopped', 'sta'),
    closing: c('closing'),
    stopping: c('stopping'),
    'req-sent': c('req-sent', 'irc', 'scr'),
    'ack-rcvd': c('req-sent', 'scr'),
    'ack-sent': c('ack-sent', 'irc', 'scr'),
    opened: c('req-sent', 'tld', 'scr'),
  },
  rtr: {
    closed: c('closed', 'sta'),
    stopped: c('stopped', 'sta'),
    closing: c('closing', 'sta'),
    stopping: c('stopping', 'sta'),
    'req-sent': c('req-sent', 'sta'),
    'ack-rcvd': c('req-sent', 'sta'),
    'ack-sent': c('req-sent', 'sta'),
    opened: c('stopping', 'tld', 'zrc', 'sta'),
  },
  rta: {
    closed: c('closed'),
    stopped: c('stopped'),
    closing: c('closed', 'tlf'),
    stopping: c('stopped', 'tlf'),
    'req-sent': c('req-sent'),
    'ack-rcvd': c('req-sent'),
    'ack-sent': c('ack-sent'),
    opened: c('req-sent', 'tld', 'scr'),
  },
  ruc: {
    closed: c('closed', 'scj'),
    stopped: c('stopped', 'scj'),
    closing: c('closing', 'scj'),
    stopping: c('stopping', 'scj'),
    'req-sent': c('req-sent', 'scj'),
    'ack-rcvd': c('ack-rcvd', 'scj'),
    'ack-sent': c('ack-sent', 'scj'),
    opened: c('opened', 'scj'),
  },
  'rxj+': {
    closed: c('closed'),
    stopped: c('stopped'),
    closing: c('closing'),
    stopping: c('stopping'),
    'req-sent': c('req-sent'),
    'ack-rcvd': c('req-sent'),
    'ack-sent': c('ack-sent'),
    opened: c('opened'),
  },
  'rxj-': {
    closed: c('closed', 'tlf'),
    stopped: c('stopped', 'tlf'),
    closing: c('closed', 'tlf'),
    stopping: c('stopped', 'tlf'),
    'req-sent': c('stopped', 'tlf'),
    'ack-rcvd': c('stopped', 'tlf'),
    'ack-sent': c('stopped', 'tlf'),
    opened: c('stopping', 'tld', 'irc', 'str'),
  },
  rxr: {
    closed: c('closed'),
    stopped: c('stopped'),
    closing: c('closing'),
    stopping: c('stopping'),
    'req-sent': c('req-sent'),
    'ack-rcvd': c('ack-rcvd'),
    'ack-sent': c('ack-sent'),
    opened: c('opened', 'ser'),
  },
});

/** The table cell for `event` in `state`; undefined for a `-` cell (the event cannot happen in that state). */
export function pppFsmCell(state: PppFsmState, event: PppFsmEvent): PppFsmCell | undefined {
  return TABLE[event][state];
}

/** An automaton: its state and its two counters. */
export interface PppAutomaton {
  readonly state: PppFsmState;
  /** The Restart counter (RFC 1661 §4.6). */
  readonly restart: number;
  /** Configure-Naks sent since the last Configure-Ack sent or the start of the negotiation (Max-Failure). */
  readonly failures: number;
}

/** A fresh automaton: Initial, counters zero. */
export const PPP_INITIAL_AUTOMATON: PppAutomaton = Object.freeze({ state: 'initial', restart: 0, failures: 0 });

/** What one event does. */
export interface PppFsmResult {
  readonly automaton: PppAutomaton;
  /** The actions to perform, in the RFC's order (`irc` and `zrc` are already applied to the counter). */
  readonly actions: readonly PppFsmAction[];
  /** The Restart timer: (re)start it, stop it, or leave it as it is. */
  readonly timer: 'start' | 'stop' | 'keep';
  /** The previous state (equal to `automaton.state` when the event did not move the automaton). */
  readonly from: PppFsmState;
  /** The event cannot happen in this state (a `-` cell): nothing changed. */
  readonly illegal: boolean;
}

/** Apply one event. */
export function pppFsmApply(a: PppAutomaton, event: PppFsmEvent): PppFsmResult {
  const cell = pppFsmCell(a.state, event);
  if (cell === undefined) return { automaton: a, actions: [], timer: 'keep', from: a.state, illegal: true };
  let restart = a.restart;
  let failures = a.failures;
  let startTimer = false;
  cell.actions.forEach((act, i) => {
    switch (act) {
      case 'irc':
        restart = cell.actions.slice(i + 1).includes('str') ? PPP_MAX_TERMINATE : PPP_MAX_CONFIGURE;
        break;
      case 'zrc':
        restart = 0;
        startTimer = true;
        break;
      case 'scr':
        // RFC 1661 §4.6: a Configure-Request from a state that was not negotiating starts a fresh negotiation
        if (!NEGOTIATING_STATES.has(a.state)) failures = 0;
        restart = restart > 0 ? restart - 1 : 0;
        startTimer = true;
        break;
      case 'str':
        restart = restart > 0 ? restart - 1 : 0;
        startTimer = true;
        break;
      case 'scn':
        failures += 1;
        break;
      case 'sca':
        failures = 0;
        break;
      default:
        break;
    }
  });
  const timer: PppFsmResult['timer'] = startTimer ? 'start' : TIMER_STATES.has(cell.next) ? 'keep' : 'stop';
  return {
    automaton: { state: cell.next, restart, failures },
    actions: cell.actions,
    timer,
    from: a.state,
    illegal: false,
  };
}

/** The event a Restart timer expiry is (RFC 1661 §4.1): TO+ while the counter is above zero, else TO−. */
export function pppTimeoutEvent(a: PppAutomaton): 'to+' | 'to-' {
  return a.restart > 0 ? 'to+' : 'to-';
}

/** Whether the Restart timer runs in `state`. */
export function pppTimerRuns(state: PppFsmState): boolean {
  return TIMER_STATES.has(state);
}

/** At Max-Failure the daemon rejects (Configure-Reject) the options it would otherwise nak (RFC 1661 §4.6). */
export function pppNakBecomesReject(a: PppAutomaton): boolean {
  return a.failures >= PPP_MAX_FAILURE;
}
