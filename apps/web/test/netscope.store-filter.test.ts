// NetScope adopts the store's filter (ARCHITECTURE-P3 §9.2 ruling R42, deferred to W4 web-shell; §6 [S2] "show the
// packets that carried it"): the link-state browser writes `netscope.filterText` / `netscope.applied`
// (routing/LinkStatePanel `showPackets`) and opens the NetScope tab; NetScope takes the text, applies the filter and
// opens the Frames view, so the link is one click. NetScope's own typing and applying go back to the slice and are
// never adopted back (`filterAdoption` decides); a panel mounted after the slice was written starts from it.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ snapshot: null, epoch: 0, dockTab: 'netscope', netscope: undefined as undefined | Record<string, unknown> }));

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => String(t) }));
vi.mock('../src/store/store', () => {
  const useStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Partial<typeof state>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { NetScope, filterAdoption, type NetScopeFilter } from '../src/netscope/NetScope';
import { NETSCOPE_NO_CAPTURE } from '../src/netscope/netscope-client';

const LSA_FILTER = 'ospf.lsa.advRouter == 2.2.2.2';
const EMPTY: NetScopeFilter = { filterText: '', applied: '' };

describe('what NetScope takes from the store', () => {
  it('nothing while the slice holds what it last saw', () => {
    expect(filterAdoption(EMPTY, EMPTY)).toBeNull();
    expect(filterAdoption({ filterText: 'icmp', applied: 'icmp' }, { filterText: 'icmp', applied: 'icmp' })).toBeNull();
  });

  it('the text, the applied filter and the Frames view when another view wrote both ("show the packets")', () => {
    expect(filterAdoption(EMPTY, { filterText: LSA_FILTER, applied: LSA_FILTER })).toEqual({ text: LSA_FILTER, applied: LSA_FILTER, showFrames: true });
    // the learner had filtered something else since: the same link is adopted again
    expect(filterAdoption({ filterText: 'icmp', applied: 'icmp' }, { filterText: LSA_FILTER, applied: LSA_FILTER })).toEqual({
      text: LSA_FILTER,
      applied: LSA_FILTER,
      showFrames: true,
    });
  });

  it('only the text when only the text moved, and only the filter when only the filter moved', () => {
    expect(filterAdoption({ filterText: 'ic', applied: '' }, { filterText: 'icm', applied: '' })).toEqual({ text: 'icm', showFrames: false });
    expect(filterAdoption({ filterText: 'arp', applied: 'icmp' }, { filterText: 'arp', applied: 'arp' })).toEqual({ applied: 'arp', showFrames: true });
    // clearing the applied filter from elsewhere is adopted too (every frame again)
    expect(filterAdoption({ filterText: 'arp', applied: 'arp' }, { filterText: 'arp', applied: '' })).toEqual({ applied: '', showFrames: true });
  });
});

describe('a NetScope panel mounted after the slice was written', () => {
  it('starts on the Frames view with the filter in the box', () => {
    state.netscope = { filterText: LSA_FILTER, applied: LSA_FILTER, heads: {} };
    const html = renderToStaticMarkup(createElement(NetScope));
    expect(html).toContain(`value="${LSA_FILTER}"`);
    expect(html).toMatch(/id="ns-view-packets"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/id="ns-view-captures"[^>]*aria-pressed="false"/);
    expect(html).toContain(NETSCOPE_NO_CAPTURE);
  });

  it('opens on the capture controls with an empty box while the slice holds no filter (as before P3)', () => {
    state.netscope = { filterText: '', applied: '', heads: {} };
    const html = renderToStaticMarkup(createElement(NetScope));
    expect(html).toMatch(/id="ns-view-captures"[^>]*aria-pressed="true"/);
    expect(html).toContain('value=""');
    state.netscope = undefined;
    expect(renderToStaticMarkup(createElement(NetScope))).toMatch(/id="ns-view-captures"[^>]*aria-pressed="true"/);
  });
});
