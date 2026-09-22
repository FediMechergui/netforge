/**
 * [S6] `show ip route` continuation lines for equal-cost paths (ARCHITECTURE-P2 §2.6 `RouteRow.paths`, §5.4; §7 W2
 * cli [S6]): a row with two or more paths prints its first path on the main line and one aligned line per further
 * path; rows without `paths` (every P1 table) render exactly as before.
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler } from '../src/contracts/cli.js';
import type { RouteRow } from '../src/contracts/tables.js';
import { HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { renderRoute, renderRoutePaths } from '../src/cli/handlers/show.js';
import { catalogModel, commandCtxFor } from './cli.p05.fixture.js';

const ROUTER = catalogModel('router.nf2911');

const ecmp: RouteRow = {
  key: '10.3.0.0/16',
  network: '10.3.0.0',
  prefixLen: 16,
  source: 'S',
  nextHop: '10.0.0.2',
  iface: 'GigabitEthernet0/0',
  ad: 1,
  metric: 0,
  updatedAt: 0,
  paths: [
    { nextHop: '10.0.0.2', iface: 'GigabitEthernet0/0', cause: 'ip route 10.3.0.0 255.255.0.0 10.0.0.2' },
    { nextHop: '10.9.0.2', iface: 'GigabitEthernet0/1', cause: 'ip route 10.3.0.0 255.255.0.0 10.9.0.2' },
    { iface: 'Serial0/0/0' },
  ],
};

describe('[S6] equal-cost paths in show ip route', () => {
  it('renders one aligned continuation line per further path', () => {
    const main = renderRoute(ecmp);
    expect(main).toBe('S    10.3.0.0/16  via 10.0.0.2 [1/0] GigabitEthernet0/0');
    const more = renderRoutePaths(ecmp);
    expect(more).toEqual([
      '                  via 10.9.0.2 [1/0] GigabitEthernet0/1',
      '                  [1/0] out Serial0/0/0',
    ]);
    // the continuation lines start exactly under the main line's "via"
    expect(more[0]?.indexOf('via')).toBe(main.indexOf('via'));
  });

  it('prints nothing extra for a single path or no paths', () => {
    expect(renderRoutePaths({ ...ecmp, paths: undefined })).toEqual([]);
    expect(renderRoutePaths({ ...ecmp, paths: [ecmp.paths![0]!] })).toEqual([]);
  });

  it('the show command places the continuation lines right after their route', () => {
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    r.ctx.tables.rib.set({ key: '10.0.0.0/24', network: '10.0.0.0', prefixLen: 24, source: 'C', iface: 'GigabitEthernet0/0', ad: 0, metric: 0, updatedAt: 0 });
    r.ctx.tables.rib.set(ecmp);
    r.ctx.tables.rib.set({ key: '192.168.1.0/24', network: '192.168.1.0', prefixLen: 24, source: 'S', nextHop: '10.0.0.2', ad: 1, metric: 0, updatedAt: 0 });
    const out = ((HANDLER_REGISTRY[HANDLERS.showIpRoute] as CommandHandler)(r.ctx, {}, false).output ?? '').split('\n').slice(4);
    expect(out).toEqual([
      'C    10.0.0.0/24  connected  GigabitEthernet0/0',
      'S    10.3.0.0/16  via 10.0.0.2 [1/0] GigabitEthernet0/0',
      '                  via 10.9.0.2 [1/0] GigabitEthernet0/1',
      '                  [1/0] out Serial0/0/0',
      'S    192.168.1.0/24  via 10.0.0.2 [1/0]',
    ]);
  });
});
