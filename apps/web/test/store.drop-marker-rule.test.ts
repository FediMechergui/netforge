// DropMarker.rule (ARCHITECTURE-P3 §9.2 ruling R42, deferred to W4 web-shell; §6 "Drop markers read `rule` when
// present"): the store copies a drop event's policy rule onto the marker it spawns (absent for a drop without one, so a
// P1/P2 marker is unchanged), and the marker layer names the rule from the marker itself — it no longer looks the rule
// up in the store's event ring.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DropRule, TraceEvent } from '@netforge/engine';

// The marker layer draws with pixi: recording stand-ins for its containers, graphics and texts (no renderer in node).
vi.mock('pixi.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  class FakeContainer {
    children: unknown[] = [];
    position = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
    scale = { set() {} };
    alpha = 1;
    visible = true;
    addChild(...cs: unknown[]) {
      this.children.push(...cs);
      return cs[0];
    }
    destroy() {}
  }
  class FakeGraphics extends FakeContainer {
    clear() { return this; }
    roundRect() { return this; }
    fill() { return this; }
    stroke() { return this; }
    poly() { return this; }
    circle() { return this; }
    moveTo() { return this; }
    lineTo() { return this; }
  }
  return { ...real, Container: FakeContainer, Graphics: FakeGraphics };
});
vi.mock('../src/canvas/scene', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  interface FakeText { text: string; width: number; visible: boolean; position: { set(): void }; anchor: { set(): void } }
  return {
    ...real,
    makeText: (text: string): FakeText => ({ text, width: text.length * 6, visible: true, position: { set() {} }, anchor: { set() {} } }),
    setText: (t: FakeText, text: string) => {
      t.text = text;
      t.width = text.length * 6;
    },
  };
});

import { Container } from 'pixi.js';
import type { EngineBatch } from '../src/bridge/protocol';
import { MarkerLayer, dropReasonText } from '../src/canvas/markers';
import type { ThemeColors } from '../src/canvas/scene';
import { store } from '../src/store/store';
import type { DropMarker } from '../src/store/types';

const SEC = 1_000_000_000;

const ACL_10: DropRule = {
  kind: 'acl',
  text: 'denied by access list NO-WEB-PC1 line 10 (deny tcp host 192.168.10.10 host 192.168.20.100 eq www), inbound on GigabitEthernet0/0',
  table: 'acl',
  key: '4|NO-WEB-PC1|10',
  iface: 'GigabitEthernet0/0',
  dir: 'in',
  list: 'NO-WEB-PC1',
  seq: 10,
  family: 4,
};

let pduSeq = 1;
function drop(t: number, rule?: DropRule, detail = 'denied by NO-WEB-PC1'): TraceEvent {
  return {
    t,
    kind: 'drop',
    pdu: { id: pduSeq++, proto: 'tcp', size: 58, summary: 'TCP 192.168.10.10:49152 > 192.168.20.100:80 [SYN]' },
    device: 'r1',
    port: 'GigabitEthernet0/0',
    reason: rule === undefined ? 'no-route' : 'acl-deny',
    detail,
    ...(rule === undefined ? {} : { rule }),
  } as TraceEvent;
}

let epoch = 3100;
function batch(events: TraceEvent[]): EngineBatch {
  return { epoch, now: events[events.length - 1]?.t ?? 0, events, playing: false, rate: 1, effectiveRate: 1, dropped: 0 } as EngineBatch;
}

afterEach(() => {
  epoch += 1;
  store.getState().applyBatch(batch([]));
});

describe('the store copies the rule onto the marker', () => {
  it('a drop with a rule spawns a marker carrying that rule', () => {
    const ev = drop(5 * SEC, ACL_10);
    store.getState().applyBatch(batch([ev]));
    const [m] = store.getState().dropMarkers;
    expect(m?.rule).toEqual(ACL_10);
    expect(m).toMatchObject({ reason: 'acl-deny', detail: 'denied by NO-WEB-PC1', simTime: 5 * SEC, at: { device: 'r1' } });
  });

  it('a drop without a rule spawns the marker it always did, with no rule member', () => {
    store.getState().applyBatch(batch([drop(6 * SEC)]));
    const [m] = store.getState().dropMarkers;
    expect(m).toBeDefined();
    expect(m).not.toHaveProperty('rule');
    expect(Object.keys(m!).sort()).toEqual(['at', 'detail', 'id', 'pdu', 'reason', 'simTime', 'wallCreated']);
  });
});

// ── the layer reads the marker, not the ring ────────────────────────────────

const THEME = { text: 1, textDim: 2, textFaint: 3, panel: 4, err: 5, bg: 6, warn: 7, sans: 'sans', mono: 'mono', stamp: 1 } as unknown as ThemeColors;

interface Drawn { children: { text?: string }[] }

/** Place `markers` with an R1 on the canvas; the title and detail texts of each drawn marker, in order. */
function drawn(layer: MarkerLayer, root: Container, markers: readonly DropMarker[]): { title: string; detail: string }[] {
  layer.update({
    markers,
    wallNow: 100,
    theme: THEME,
    zoom: 1,
    reducedMotion: true,
    selectedPdu: null,
    textResolution: 1,
    layout: { devices: new Map([['r1', { x: 0, y: 0, halfH: 10 }]]) } as never,
    linkGeometry: () => undefined,
    assocGeometry: () => undefined,
    linkEnds: () => undefined,
  });
  return (root as unknown as Drawn).children.map((v) => {
    const kids = (v as unknown as Drawn).children;
    return { title: kids[1]?.text ?? '', detail: kids[2]?.text ?? '' };
  });
}

function marker(id: number, over: Partial<DropMarker> = {}): DropMarker {
  return { id, pdu: id, at: { device: 'r1' }, reason: 'acl-deny', detail: 'denied by NO-WEB-PC1', simTime: id * SEC, wallCreated: 90, ...over };
}

describe('the marker layer names the rule from the marker', () => {
  it('with an empty event ring, a marker carrying a rule shows the rule on its detail line', () => {
    const root = new Container();
    const layer = new MarkerLayer(root);
    layer.ingest([], 0);
    expect(drawn(layer, root, [marker(1, { rule: ACL_10 })])).toEqual([{ title: dropReasonText('acl-deny').title, detail: 'ACL NO-WEB-PC1 #10' }]);
  });

  it('never takes a rule from the ring: a marker without one keeps the engine detail even when the ring holds its drop', () => {
    const root = new Container();
    const layer = new MarkerLayer(root);
    const ev = drop(2 * SEC, ACL_10);
    const pdu = (ev as Extract<TraceEvent, { kind: 'drop' }>).pdu.id;
    // primed with a ring that already holds the drop, then a later batch with it again
    layer.ingest([ev], 0);
    layer.ingest([ev, drop(3 * SEC, ACL_10)], 10);
    const bare = marker(pdu, { simTime: 2 * SEC });
    expect(drawn(layer, root, [bare])).toEqual([dropReasonText('acl-deny', 'denied by NO-WEB-PC1')]);
  });

  it('a P1/P2 drop (no rule) reads exactly as before', () => {
    const root = new Container();
    const layer = new MarkerLayer(root);
    layer.ingest([], 0);
    const m = marker(4, { reason: 'ttl-exceeded', detail: 'TTL reached 0' });
    expect(drawn(layer, root, [m])).toEqual([dropReasonText('ttl-exceeded', 'TTL reached 0')]);
  });
});
