/**
 * cli/handlers/api.ts, `show restconf` (ARCHITECTURE-P3 §5.6, §5.8, D21; §7 W3 cli part 2; rule 20): whether the API
 * answers (the daemon's own reader: `restconf` and `ip http secure-server` both stored, each missing line named), the
 * login rule and the privilege-15 users, the restconf StateView's counters (display only), and the newest
 * `restconf-log` rows. Against a fake table and the StateView the daemon documents (protocols/restconf.ts).
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import type { RestconfLogRow, Table, TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createTable } from '../src/core/table.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { SHOW_RESTCONF_RECENT } from '../src/cli/handlers/api.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';

const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const PC = catalogModel('pc.nfpc');
const NOW = 600 * SEC;

function run(rec: RecordingCtx): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[HANDLERS.showRestconf];
  if (h === undefined) throw new Error('no show.restconf handler');
  return h(rec.ctx, {}, false);
}

const lines = (o: CommandOutcome): string[] => (o.output ?? '').split('\n');

function logRow(seq: number, over: Partial<RestconfLogRow> = {}): RestconfLogRow {
  return {
    key: String(seq), seq, method: 'GET', path: '/restconf/data/ietf-interfaces:interfaces', status: 200, client: '10.0.99.10', user: 'admin',
    at: NOW - (20 - seq) * SEC, updatedAt: 0, ...over,
  };
}

/** SW1 serving the API, with `admin` (privilege 15) and `guest` (privilege 1). */
function sw1(rows: number): RecordingCtx {
  const r = commandCtxFor(SWITCH, {
    mode: 'priv-exec',
    hostname: 'SW1',
    processStates: { restconf: { process: 'restconf', state: { enabled: true, authentication: 'local', open: ['restconf#443/7'], pending: [], requests: 5, refused: 1 } } },
  });
  (r.ctx as { now: number }).now = NOW;
  r.running.set([], ['ip', 'http', 'secure-server']);
  r.running.set([], ['ip', 'http', 'authentication', 'local']);
  r.running.set([], ['restconf']);
  r.running.set([], ['username', 'admin', 'privilege', '15', 'secret', 'nf1$0123456789abcdef']);
  r.running.set([], ['username', 'guest', 'secret', 'nf1$fedcba9876543210']);
  const t = createTable<RestconfLogRow>({ name: 'restconf-log', device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  r.extra.set('restconf-log' as never, t as unknown as Table<TableRow>);
  for (let seq = 1; seq <= rows; seq++) t.set(logRow(seq, seq === rows ? { method: 'PATCH', status: 401, user: undefined } : {}));
  return r;
}

describe('show restconf', () => {
  it('is offered where restconf runs (routers and managed switches), at user level', () => {
    for (const model of [ROUTER, SWITCH]) {
      const m = matchCommand(GRAMMAR, matchContextFor(model, 'user-exec'), 'show restconf');
      expect(m.ok && m.spec.handler, model.type).toBe(HANDLERS.showRestconf);
    }
    expect(matchCommand(GRAMMAR, matchContextFor(PC, 'user-exec'), 'show restconf').ok).toBe(false);
  });

  it('off: names each missing service line, and the login rule', () => {
    const none = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    expect(lines(run(none))).toEqual([
      'RESTCONF API: off (it needs "restconf" and "ip http secure-server"; missing: restconf, ip http secure-server)',
      '  Logins: none accepted until "ip http authentication local" is configured',
      '  Requests answered: 0, refused: 0; connections open: 0',
      '  No request has been logged yet.',
    ]);
    none.running.set([], ['restconf']);
    expect(lines(run(none))[0]).toBe('RESTCONF API: off (it needs "restconf" and "ip http secure-server"; missing: ip http secure-server)');
  });

  it('on: the privilege-15 users, the StateView counters and the newest log rows, oldest first', () => {
    const out = lines(run(sw1(12)));
    expect(out.slice(0, 4)).toEqual([
      'RESTCONF API: on, answering on TCP port 443 (HTTPS, simulated TLS)',
      '  Logins: HTTP Basic, checked against the local users of privilege 15 (admin)',
      '  Requests answered: 5, refused: 1; connections open: 1',
      `  Latest requests (oldest first, ${SHOW_RESTCONF_RECENT} of 12 kept):`,
    ]);
    expect(out[4]).toMatch(/^ {4}Seq +Method +Path +Status +Client +User +Age$/);
    const rows = out.slice(5);
    expect(rows).toHaveLength(SHOW_RESTCONF_RECENT);
    expect(rows[0]).toMatch(/^ {4}3 +GET +\/restconf\/data\/ietf-interfaces:interfaces +200 +10\.0\.99\.10 +admin +00:00:17$/);
    expect(rows[SHOW_RESTCONF_RECENT - 1]).toMatch(/^ {4}12 +PATCH +\S+ +401 +10\.0\.99\.10 +- +00:00:08$/);
  });

  it('a short log is shown whole; no privilege-15 user is named as none', () => {
    const r = sw1(2);
    r.running.unset([], ['username', 'admin', 'privilege', '15', 'secret', 'nf1$0123456789abcdef']);
    const out = lines(run(r));
    expect(out[1]).toBe('  Logins: HTTP Basic, checked against the local users of privilege 15 (none configured)');
    expect(out[3]).toBe('  Latest requests (oldest first, 2 of 2 kept):');
    expect(out).toHaveLength(7);
  });
});
