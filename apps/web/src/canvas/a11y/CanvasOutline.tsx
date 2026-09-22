/**
 * Keyboard canvas (spec §16; ARCHITECTURE-P1 §7 "Keyboard canvas", §8.1 W6 web-canvas).
 *
 * `CanvasOutline` is the single a11y mount of the topology view. Render it once inside the canvas container
 * (`.nf-canvas`); it provides:
 *  - a DOM outline tree (devices → ports, cables, wireless associations) that mirrors the canvas. It is one tab
 *    stop with a roving focus; it stays visually hidden until it holds focus, then shows as a panel over the
 *    canvas, so pointer users see no change;
 *  - spatial arrow-key navigation between devices (keyboard-nav.ts), cable-graph jumps and reading-order paging;
 *  - the keyboard cabling dialog (KeyboardCabling.tsx);
 *  - the polite live region fed by the canvas announcer (association, link, topology, collision and drop news).
 *
 * The canvas integrates through the pinned `registerCanvasA11y(api)` hook exported by canvas/Canvas.tsx: the
 * canvas calls `focusDevice` to hand keyboard focus to a device row, `screenPoint` to learn where a device is
 * drawn, and `beginCable` to continue a cable in the keyboard dialog. The focused device is mirrored to the
 * store (`setCanvasFocus`, and `hover` so the canvas highlights it).
 *
 * Keys (the tree is a roving-focus `role="tree"`):
 *  - device rows: arrows move to the nearest device in that direction; Home/End first/last device; PageDown/
 *    PageUp next/previous device in reading order; G next cabled neighbour; Space, + or - show/hide ports;
 *    Enter selects; C connects a cable; Escape goes to the Devices group;
 *  - port rows: Up/Down move; Left returns to the device; G jumps to the port at the other end; Enter selects;
 *    C connects a cable from this port;
 *  - groups, cables and associations: Up/Down move; Right/Left open/close (or go to the group); Enter selects;
 *  - everywhere: Ctrl+Up/Down jump between groups.
 *
 * @since P2 (W3 web-canvas, ARCHITECTURE-P2 §6) The topology overlays are mirrored in text: while the VLAN overlay
 * is on, a port row says its VLAN facts ("access port in VLAN 10", a trunk's list and native VLAN, a mismatch) and a
 * cable row its shared chip or the disagreement; while the spanning-tree overlay is on, a port row says its role and
 * state ("alternate port, blocking (crossed)"), a device row whether it is the root and its topology changes, and a
 * cable row its place in the tree. `decorateOutline` (pure) folds the facts of `l2.ts` / `stp.ts` into the outline
 * model, so what the canvas draws is what the tree says (every overlay fact has a text form).
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { DeviceId, LinkId, PortRef, Selection, SimSnapshot } from '@netforge/engine';
import { selectionKey } from '@netforge/engine';
import * as canvasModule from '../Canvas';
import { store, useStore } from '../../store/store';
import type { TopoOverlayState } from '../../store/types';
import { isPickablePort } from '../../app/cable/cable-compat.js';
import { l2LinkFacts, l2PortFacts, type OverlayFact } from '../l2';
import { STP_OVERLAY, TOPO_OVERLAY_DEFAULTS, VLAN_OVERLAY } from '../overlays/registry';
import { stpDeviceFacts, stpLinkFacts, stpPortFacts } from '../stp';
import { announceWith, attachCanvasAnnouncer, subscribeFallbackAnnouncements } from './announcer';
import {
  associationKey,
  buildOutline,
  deviceById,
  deviceKey,
  deviceOfItem,
  directionForKey,
  firstDevice,
  groupKey,
  lastDevice,
  linkKey,
  navPoints,
  nextPeerDevice,
  portItemKey,
  readingOrder,
  screenPointOf,
  spatialNeighbour,
  stepInOrder,
  visibleItems,
  type CanvasA11yApi,
  type CanvasOutlineModel,
  type OutlineAssociation,
  type OutlineDevice,
  type OutlineGroup,
  type OutlineItem,
  type OutlineLink,
} from './keyboard-nav.js';
import { KeyboardCabling, requestKeyboardCabling } from './KeyboardCabling';
import './a11y.css';

/**
 * The pinned canvas hook; resolved at CALL time, never at module scope: Canvas.tsx imports this module, so a
 * module-scope read of the namespace runs before the canvas module body in a bundled build and throws
 * (ReferenceError: cannot access before initialization). A function keeps the cycle harmless.
 */
type RegisterCanvasA11y = (api: CanvasA11yApi) => () => void;
const canvasHooks = (): typeof canvasModule & { registerCanvasA11y?: RegisterCanvasA11y } =>
  canvasModule as typeof canvasModule & { registerCanvasA11y?: RegisterCanvasA11y };

const DIRECTION_WORDS = Object.freeze({ up: 'above', down: 'below', left: 'to the left', right: 'to the right' });

// ── overlay facts in text (P2) ───────────────────────────────────────────────

/** The text facts of the topology overlays that are on, keyed like the outline items. */
export interface OutlineFacts {
  /** By `portKey` (`device/port`). */
  readonly ports: ReadonlyMap<string, readonly OverlayFact[]>;
  readonly devices: ReadonlyMap<DeviceId, readonly OverlayFact[]>;
  readonly links: ReadonlyMap<LinkId, readonly OverlayFact[]>;
}

const NO_FACTS: OutlineFacts = Object.freeze({ ports: new Map(), devices: new Map(), links: new Map() });

function merge<K>(into: Map<K, OverlayFact[]>, from: ReadonlyMap<K, OverlayFact>): void {
  for (const [k, fact] of from) into.set(k, [...(into.get(k) ?? []), fact]);
}

/** Facts of the overlays the slice switches on, from the same registry models the canvas draws (pure). */
export function outlineFacts(snapshot: SimSnapshot | null, topo: TopoOverlayState | undefined): OutlineFacts {
  const state = topo ?? TOPO_OVERLAY_DEFAULTS;
  if (snapshot === null || (!state.vlan && !state.stp)) return NO_FACTS;
  const now = snapshot.now;
  const ports = new Map<string, OverlayFact[]>();
  const devices = new Map<DeviceId, OverlayFact[]>();
  const links = new Map<LinkId, OverlayFact[]>();
  const l2 = VLAN_OVERLAY.sync({ state, snapshot, now });
  merge(ports, l2PortFacts(l2));
  merge(links, l2LinkFacts(l2));
  const stp = STP_OVERLAY.sync({ state, snapshot, now });
  merge(ports, stpPortFacts(stp));
  merge(devices, stpDeviceFacts(stp));
  merge(links, stpLinkFacts(stp));
  return { ports, devices, links };
}

function withFacts(description: string, facts: readonly OverlayFact[] | undefined): string {
  if (facts === undefined || facts.length === 0) return description;
  return `${description.replace(/\.$/, '')}; ${facts.map((f) => f.text).join('; ')}.`;
}

function withShort(label: string, facts: readonly OverlayFact[] | undefined): string {
  if (facts === undefined || facts.length === 0) return label;
  return `${label} · ${facts.map((f) => f.short).join(' · ')}`;
}

/** The outline model with the overlay facts folded into its labels and descriptions (the same model when there are none). */
export function decorateOutline(model: CanvasOutlineModel, facts: OutlineFacts): CanvasOutlineModel {
  if (facts.ports.size === 0 && facts.devices.size === 0 && facts.links.size === 0) return model;
  const devices = model.devices.map((d) => {
    const own = facts.devices.get(d.id);
    const ports = d.ports.map((p) => {
      const pf = facts.ports.get(p.key);
      if (pf === undefined) return p;
      return Object.freeze({ ...p, label: withShort(p.label, pf), description: withFacts(p.description, pf) });
    });
    const changed = own !== undefined || ports.some((p, i) => p !== d.ports[i]);
    if (!changed) return d;
    return Object.freeze({ ...d, label: withShort(d.label, own), description: withFacts(d.description, own), ports: Object.freeze(ports) });
  });
  const links = model.links.map((l) => {
    const lf = facts.links.get(l.id);
    return lf === undefined ? l : Object.freeze({ ...l, label: withShort(l.label, lf), description: withFacts(l.description, lf) });
  });
  return Object.freeze({ devices: Object.freeze(devices), links: Object.freeze(links), associations: model.associations });
}

/** Screen-reader item id of an outline key (keys contain `/` and `:`, which ids tolerate). */
const itemDomId = (base: string, key: string): string => `${base}-${key}`;

// ── live region ──────────────────────────────────────────────────────────────

/** Polite live region showing the latest canvas announcement (store `a11y.announcement`, else the fallback channel). */
export function LiveRegion() {
  const fromStore = useStore((s) => s.a11y?.announcement ?? null);
  const [fallback, setFallback] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => subscribeFallbackAnnouncements(setFallback), []);
  const current = fromStore ?? fallback;
  return (
    <div className="nf-a11y-sr" role="status" aria-live="polite" aria-atomic="true">
      {current !== null && <span key={current.id}>{current.text}</span>}
    </div>
  );
}

// ── tree rows ────────────────────────────────────────────────────────────────

interface RowCommon {
  base: string;
  activeKey: string;
  selectedKey: string | null;
  register(key: string, el: HTMLElement | null): void;
}

const DeviceRow = memo(function DeviceRow({
  device,
  expanded,
  base,
  activeKey,
  selectedKey,
  register,
}: DeviceRowProps) {
  const key = deviceKey(device.id);
  const groupId = itemDomId(base, `${key}-ports`);
  return (
    <li
      ref={(el) => register(key, el)}
      id={itemDomId(base, key)}
      role="treeitem"
      aria-level={2}
      aria-expanded={device.ports.length > 0 ? expanded : undefined}
      aria-selected={selectedKey === `device:${device.id}`}
      aria-label={device.description}
      tabIndex={activeKey === key ? 0 : -1}
      data-key={key}
      className="nf-a11y-item is-device"
    >
      <span className="nf-a11y-text" aria-hidden="true">
        <span className="nf-a11y-twisty">{device.ports.length === 0 ? '·' : expanded ? '▾' : '▸'}</span>
        {device.label}
      </span>
      {expanded && (
        <ul role="group" id={groupId}>
          {device.ports.map((p) => {
            const pk = portItemKey(p.ref);
            return (
              <li
                key={pk}
                ref={(el) => register(pk, el)}
                id={itemDomId(base, pk)}
                role="treeitem"
                aria-level={3}
                aria-selected={selectedKey === `port:${p.ref.device}/${p.ref.port}`}
                aria-label={p.description}
                tabIndex={activeKey === pk ? 0 : -1}
                data-key={pk}
                className="nf-a11y-item is-port"
              >
                <span className="nf-a11y-text" aria-hidden="true">
                  <span className="nf-a11y-status">{p.status}</span> {p.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}, sameDeviceRow);

type DeviceRowProps = RowCommon & { device: OutlineDevice; expanded: boolean };

/** Whether an active or selected key concerns this device row (the device itself or one of its ports). */
function concerns(id: DeviceId, key: string | null): boolean {
  if (key === null) return false;
  return key === deviceKey(id) || key.startsWith(`p:${id}/`) || key === `device:${id}` || key.startsWith(`port:${id}/`);
}

/** Re-render a device row only when its text, expansion, focus or selection changed. */
function sameDeviceRow(a: DeviceRowProps, b: DeviceRowProps): boolean {
  if (a.expanded !== b.expanded || a.base !== b.base || a.register !== b.register) return false;
  const id = a.device.id;
  if (id !== b.device.id || a.device.description !== b.device.description || a.device.label !== b.device.label) return false;
  if (a.activeKey !== b.activeKey && (concerns(id, a.activeKey) || concerns(id, b.activeKey))) return false;
  if (a.selectedKey !== b.selectedKey && (concerns(id, a.selectedKey) || concerns(id, b.selectedKey))) return false;
  if (!a.expanded) return true;
  const pa = a.device.ports;
  const pb = b.device.ports;
  if (pa.length !== pb.length) return false;
  for (let i = 0; i < pa.length; i += 1) {
    if (pa[i]?.key !== pb[i]?.key || pa[i]?.description !== pb[i]?.description || pa[i]?.status !== pb[i]?.status) return false;
  }
  return true;
}

function LeafRow({ itemKey, label, description, selected, base, activeKey, register }: Omit<RowCommon, 'selectedKey'> & { itemKey: string; label: string; description: string; selected: boolean }) {
  return (
    <li
      ref={(el) => register(itemKey, el)}
      id={itemDomId(base, itemKey)}
      role="treeitem"
      aria-level={2}
      aria-selected={selected}
      aria-label={description}
      tabIndex={activeKey === itemKey ? 0 : -1}
      data-key={itemKey}
      className="nf-a11y-item is-leaf"
    >
      <span className="nf-a11y-text" aria-hidden="true">
        {label}
      </span>
    </li>
  );
}

function GroupRow({
  group,
  title,
  count,
  expanded,
  base,
  activeKey,
  register,
  children,
}: Omit<RowCommon, 'selectedKey'> & { group: OutlineGroup; title: string; count: number; expanded: boolean; children: ReactNode }) {
  const key = groupKey(group);
  return (
    <li
      ref={(el) => register(key, el)}
      id={itemDomId(base, key)}
      role="treeitem"
      aria-level={1}
      aria-expanded={expanded}
      aria-selected={false}
      aria-label={`${title}, ${count}`}
      tabIndex={activeKey === key ? 0 : -1}
      data-key={key}
      className="nf-a11y-item is-group"
    >
      <span className="nf-a11y-text" aria-hidden="true">
        <span className="nf-a11y-twisty">{expanded ? '▾' : '▸'}</span>
        {title} ({count})
      </span>
      {expanded && <ul role="group">{children}</ul>}
    </li>
  );
}

// ── outline ──────────────────────────────────────────────────────────────────

function toggled<T>(set: ReadonlySet<T>, value: T, on?: boolean): ReadonlySet<T> {
  const has = set.has(value);
  const want = on ?? !has;
  if (want === has) return set;
  const next = new Set(set);
  if (want) next.add(value);
  else next.delete(value);
  return next;
}

function selectionFor(item: OutlineItem): Selection | null {
  switch (item.kind) {
    case 'device':
      return { kind: 'device', id: item.id };
    case 'port':
      return { kind: 'port', ref: item.ref };
    case 'link':
      return { kind: 'link', id: item.id };
    case 'association':
      return { kind: 'association', id: item.id };
    default:
      return null;
  }
}

function groupOf(item: OutlineItem): OutlineGroup {
  switch (item.kind) {
    case 'group':
      return item.group;
    case 'device':
    case 'port':
      return 'devices';
    case 'link':
      return 'links';
    default:
      return 'associations';
  }
}

/** The keyboard canvas: outline tree, keyboard cabling dialog and live region. Mount once per canvas. */
export function CanvasOutline() {
  const base = useId().replace(/:/g, '');
  const helpId = `${base}-help`;
  const snapshot = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const topo = useStore((s) => s.topoOverlays);
  const selectedKey = selection === null ? null : selectionKey(selection);

  const bare = useMemo(() => buildOutline(snapshot), [snapshot]);
  const facts = useMemo(() => outlineFacts(snapshot, topo), [snapshot, topo]);
  const model = useMemo(() => decorateOutline(bare, facts), [bare, facts]);
  const [groups, setGroups] = useState<ReadonlySet<OutlineGroup>>(() => new Set<OutlineGroup>(['devices']));
  const [devices, setDevices] = useState<ReadonlySet<DeviceId>>(() => new Set<DeviceId>());
  const [activeKey, setActiveKey] = useState<string>(groupKey('devices'));

  const items = useMemo(() => visibleItems(model, { groups, devices }), [model, groups, devices]);
  const itemIndex = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((it, i) => m.set(it.key, i));
    return m;
  }, [items]);
  const points = useMemo(() => navPoints(model.devices.map((d) => ({ id: d.id, position: d.position }))), [model]);
  const order = useMemo(() => readingOrder(points).map((p) => p.id), [points]);

  const elements = useRef(new Map<string, HTMLElement>());
  const treeRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const lastPeer = useRef<{ from: DeviceId; peer: DeviceId } | null>(null);
  const ownHover = useRef<string | null>(null);

  const register = useCallback((key: string, el: HTMLElement | null) => {
    if (el === null) elements.current.delete(key);
    else elements.current.set(key, el);
  }, []);

  // The roving key falls back to the Devices group when its item disappears (device removed, group closed).
  const effectiveActive = itemIndex.has(activeKey) ? activeKey : groupKey('devices');

  // Move DOM focus after the render that made the target visible.
  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    const el = elements.current.get(key);
    if (el !== undefined) {
      pendingFocus.current = null;
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
    }
  });

  const focusKey = useCallback((key: string) => {
    setActiveKey(key);
    pendingFocus.current = key;
    const el = elements.current.get(key);
    if (el !== undefined) {
      pendingFocus.current = null;
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  const focusDevice = useCallback(
    (id: DeviceId) => {
      setGroups((g) => toggled(g, 'devices', true));
      focusKey(deviceKey(id));
    },
    [focusKey],
  );

  const focusPort = useCallback(
    (ref: PortRef) => {
      setGroups((g) => toggled(g, 'devices', true));
      setDevices((d) => toggled(d, ref.device, true));
      focusKey(portItemKey(ref));
    },
    [focusKey],
  );

  // Announcer and canvas registration live as long as the outline.
  useEffect(() => attachCanvasAnnouncer(store), []);

  const focusDeviceRef = useRef(focusDevice);
  focusDeviceRef.current = focusDevice;
  useEffect(() => {
    const register = canvasHooks().registerCanvasA11y;
    if (typeof register !== 'function') return undefined;
    const api: CanvasA11yApi = {
      focusDevice: (id) => focusDeviceRef.current(id),
      screenPoint: (id) => {
        const st = store.getState();
        const d = deviceById(st.snapshot, st.snapshotIndex, id);
        return d === undefined ? null : screenPointOf(d.position, st.camera);
      },
      beginCable: (from) => {
        requestKeyboardCabling({ from });
      },
    };
    return register(api);
  }, []);

  const pointFor = useCallback((id: DeviceId) => {
    const st = store.getState();
    const d = deviceById(st.snapshot, st.snapshotIndex, id);
    return d === undefined ? null : screenPointOf(d.position, st.camera);
  }, []);

  // ── focus mirroring ──
  const onFocus = (e: ReactFocusEvent<HTMLUListElement>): void => {
    const key = (e.target as HTMLElement).dataset.key;
    if (key === undefined) return;
    if (key !== activeKey) setActiveKey(key);
    const item = items[itemIndex.get(key) ?? -1];
    if (item === undefined) return;
    const st = store.getState();
    const device = deviceOfItem(item);
    st.setCanvasFocus?.(device);
    const hover = selectionFor(item);
    if (hover !== null) {
      ownHover.current = selectionKey(hover);
      st.setHover(hover);
    } else if (ownHover.current !== null) {
      ownHover.current = null;
      st.setHover(null);
    }
  };

  const onBlur = (e: ReactFocusEvent<HTMLUListElement>): void => {
    const next = e.relatedTarget;
    if (next instanceof Node && treeRef.current?.contains(next)) return;
    const st = store.getState();
    st.setCanvasFocus?.(null);
    if (ownHover.current !== null && st.hover !== null && selectionKey(st.hover) === ownHover.current) st.setHover(null);
    ownHover.current = null;
  };

  // ── keyboard ──
  const say = (text: string): void => announceWith(store, text);

  const moveLinear = (from: number, delta: number): void => {
    const next = items[Math.max(0, Math.min(items.length - 1, from + delta))];
    if (next !== undefined) focusKey(next.key);
  };

  const jumpGroup = (item: OutlineItem, delta: number): void => {
    const groupItems = items.filter((i): i is Extract<OutlineItem, { kind: 'group' }> => i.kind === 'group');
    const keys = groupItems.map((g) => g.key);
    const next = stepInOrder(keys, groupKey(groupOf(item)), delta);
    if (next !== null) focusKey(next);
  };

  const startCable = (item: OutlineItem): void => {
    if (item.kind === 'device') {
      if (!requestKeyboardCabling({ device: item.id })) say('Keyboard cabling is not available right now.');
      return;
    }
    if (item.kind !== 'port') return;
    const st = store.getState();
    const d = deviceById(st.snapshot, st.snapshotIndex, item.ref.device);
    const p = d?.ports.find((x) => x.id === item.ref.port);
    if (p === undefined || d === undefined) return;
    if (!isPickablePort(p)) {
      say(`${d.name} ${p.id} does not take a cable.`);
      return;
    }
    if (p.link !== undefined) {
      say(`${d.name} ${p.id} already has a connection.`);
      return;
    }
    if (!requestKeyboardCabling({ from: item.ref })) say('Keyboard cabling is not available right now.');
  };

  const selectItem = (item: OutlineItem): void => {
    const sel = selectionFor(item);
    if (sel !== null) store.getState().select(sel);
  };

  const onDeviceKey = (e: ReactKeyboardEvent, item: Extract<OutlineItem, { kind: 'device' }>, device: OutlineDevice | undefined): boolean => {
    const dir = directionForKey(e.key);
    if (dir !== null) {
      const next = spatialNeighbour(points, item.id, dir);
      if (next !== null) focusDevice(next);
      else say(`No device ${DIRECTION_WORDS[dir]}.`);
      return true;
    }
    switch (e.key) {
      case 'Home': {
        const id = firstDevice(points);
        if (id !== null) focusDevice(id);
        return true;
      }
      case 'End': {
        const id = lastDevice(points);
        if (id !== null) focusDevice(id);
        return true;
      }
      case 'PageDown':
      case 'PageUp': {
        const id = stepInOrder(order, item.id, e.key === 'PageDown' ? 1 : -1);
        if (id !== null) focusDevice(id);
        return true;
      }
      case ' ':
      case '+':
      case '-': {
        if (device === undefined || device.ports.length === 0) return true;
        const on = e.key === ' ' ? undefined : e.key === '+';
        setDevices((d) => toggled(d, item.id, on));
        return true;
      }
      case 'g':
      case 'G': {
        const links = store.getState().snapshot?.links ?? [];
        const prev = lastPeer.current !== null && lastPeer.current.from === item.id ? lastPeer.current.peer : null;
        const peer = nextPeerDevice(links, item.id, prev);
        if (peer === null) {
          say(`${device?.name ?? item.id} has no cabled neighbour.`);
          return true;
        }
        lastPeer.current = { from: peer, peer: item.id };
        focusDevice(peer);
        return true;
      }
      case 'Enter':
        selectItem(item);
        return true;
      case 'c':
      case 'C':
        startCable(item);
        return true;
      case 'Escape':
        focusKey(groupKey('devices'));
        return true;
      default:
        return false;
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>): void => {
    if (e.altKey || e.metaKey || e.nativeEvent.isComposing) return;
    const key = (e.target as HTMLElement).dataset.key;
    if (key === undefined) return;
    const index = itemIndex.get(key);
    const item = index === undefined ? undefined : items[index];
    if (item === undefined || index === undefined) return;

    let handled = false;
    if (e.ctrlKey) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        jumpGroup(item, e.key === 'ArrowDown' ? 1 : -1);
        handled = true;
      }
    } else if (item.kind === 'device') {
      handled = onDeviceKey(e, item, model.devices.find((d) => d.id === item.id));
    } else {
      switch (e.key) {
        case 'ArrowDown':
          moveLinear(index, 1);
          handled = true;
          break;
        case 'ArrowUp':
          moveLinear(index, -1);
          handled = true;
          break;
        case 'Home':
          moveLinear(index, -items.length);
          handled = true;
          break;
        case 'End':
          moveLinear(index, items.length);
          handled = true;
          break;
        case 'ArrowRight':
          if (item.kind === 'group') {
            if (!groups.has(item.group)) setGroups((g) => toggled(g, item.group, true));
            else moveLinear(index, 1);
          }
          handled = true;
          break;
        case 'ArrowLeft':
          if (item.kind === 'group') setGroups((g) => toggled(g, item.group, false));
          else if (item.kind === 'port') focusKey(deviceKey(item.ref.device));
          else focusKey(groupKey(groupOf(item)));
          handled = true;
          break;
        case 'Enter':
        case ' ':
          if (item.kind === 'group') setGroups((g) => toggled(g, item.group));
          else if (e.key === 'Enter') selectItem(item);
          handled = true;
          break;
        case 'g':
        case 'G':
          if (item.kind === 'port') {
            const port = model.devices.find((d) => d.id === item.ref.device)?.ports.find((p) => p.ref.port === item.ref.port);
            if (port?.peer !== undefined) focusPort(port.peer);
            else say(`${item.ref.port} is not connected.`);
            handled = true;
          } else if (item.kind === 'link') {
            const link = model.links.find((l) => l.id === item.id);
            if (link !== undefined) focusPort(link.a);
            handled = true;
          }
          break;
        case 'c':
        case 'C':
          if (item.kind === 'port') {
            startCable(item);
            handled = true;
          }
          break;
        default:
          break;
      }
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Space activates rows here; the global play/pause hotkey fires on keyup, so keep that keyup inside the tree.
  const onKeyUp = (e: ReactKeyboardEvent<HTMLUListElement>): void => {
    if (e.key === ' ' || e.key === 'c' || e.key === 'C') e.stopPropagation();
  };

  const deviceCount = model.devices.length;
  const linksOpen = groups.has('links');
  const assocOpen = groups.has('associations');

  return (
    <div className="nf-a11y">
      <section className="nf-a11y-outline" aria-label="Topology outline">
        <h2 className="nf-a11y-title">Topology outline</h2>
        <p id={helpId} className="nf-a11y-help">
          Arrow keys move between devices by position. Space shows ports, G follows a cable, C connects a cable, Enter
          selects. Ctrl+Up or Ctrl+Down switches between devices, cables and wireless links.
        </p>
        <ul
          ref={treeRef}
          role="tree"
          aria-label="Devices, cables and wireless links"
          aria-describedby={helpId}
          className="nf-a11y-tree"
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          <GroupRow group="devices" title="Devices" count={deviceCount} expanded={groups.has('devices')} base={base} activeKey={effectiveActive} register={register}>
            {deviceCount === 0 ? (
              <li role="none" className="nf-a11y-empty">
                The workspace is empty.
              </li>
            ) : (
              model.devices.map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  expanded={devices.has(d.id)}
                  base={base}
                  activeKey={effectiveActive}
                  selectedKey={selectedKey}
                  register={register}
                />
              ))
            )}
          </GroupRow>
          <GroupRow group="links" title="Cables" count={model.links.length} expanded={linksOpen} base={base} activeKey={effectiveActive} register={register}>
            {model.links.map((l: OutlineLink) => (
              <LeafRow
                key={l.id}
                itemKey={linkKey(l.id)}
                label={l.label}
                description={l.description}
                selected={selectedKey === `link:${l.id}`}
                base={base}
                activeKey={effectiveActive}
                register={register}
              />
            ))}
          </GroupRow>
          {model.associations.length > 0 && (
            <GroupRow
              group="associations"
              title="Wireless links"
              count={model.associations.length}
              expanded={assocOpen}
              base={base}
              activeKey={effectiveActive}
              register={register}
            >
              {model.associations.map((a: OutlineAssociation) => (
                <LeafRow
                  key={a.id}
                  itemKey={associationKey(a.id)}
                  label={a.label}
                  description={a.description}
                  selected={selectedKey === `association:${a.id}`}
                  base={base}
                  activeKey={effectiveActive}
                  register={register}
                />
              ))}
            </GroupRow>
          )}
        </ul>
      </section>
      <LiveRegion />
      <KeyboardCabling pointFor={pointFor} />
    </div>
  );
}
