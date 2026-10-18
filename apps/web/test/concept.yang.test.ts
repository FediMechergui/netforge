/**
 * [S28] The YANG browser (ARCHITECTURE-P3C D10 "[S28]", §7 W1b web-concept (b), §10.2): the concept tool `concept:yang`
 * over the devices' own YANG model (`automation/yang/model.ts`, through `@netforge/engine/pure`).
 *
 * Under test: every node of the model is reachable in the browser (by the tree walk, by opening every branch, by the
 * search and in the rendered tool); every configuration node's sample lines parse against the grammar (pasted into a
 * real switch and router through `Simulation.configure`, the path RESTCONF writes take); every RESTCONF address the
 * detail pane shows resolves in the model; the RFC 8340 tree diagram; IETF/IANA modules and the original nf-native
 * only (rule 6); the registry entry is a lazy chunk; labelled controls only.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSimulation } from '@netforge/engine';
import type { Simulation } from '@netforge/engine';
import { YANG_MODULES, parseApiPath, resolveYangOperation, resolveYangPath, yangNode, yangNodes } from '@netforge/engine/pure';
import type { YangNode } from '@netforge/engine/pure';
import {
  visibleYangRows,
  yangAccess,
  yangBranchPaths,
  yangBrowserChildren,
  yangBrowserRoots,
  yangNodeDetail,
  yangNodeMatches,
  yangRestconfRequest,
  yangSampleJson,
  yangSampleLines,
  yangTreeDiagram,
  yangTreeLine,
} from '../src/concept/yang/model';
import { BrowsePane, DEFAULT_YANG_NODE, NodeDetail, TreeDiagramPane, YANG_PANES, YangBrowser, defaultOpenYangNodes, type YangBrowserProps } from '../src/concept/yang/YangBrowser';
import { CONCEPT_TOOLS, CONCEPT_TOOL_VIEWS, ConceptView, isConceptToolBuilt, type ConceptViewProps } from '../src/concept/ConceptView';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** Every input in `html` is named by a `<label for>` or an aria-label. */
function unlabelledControls(html: string): string[] {
  const labelled = new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1] as string));
  const out: string[] = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    if (/aria-label="/.test(tag)) continue;
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (id === undefined || !labelled.has(id)) out.push(tag);
  }
  return out;
}

const unescape = (s: string): string => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// ── every node reachable ─────────────────────────────────────────────────────

describe('every node is reachable', () => {
  it('the tree walk from the roots reaches every node of the model exactly once', () => {
    const seen: string[] = [];
    const walk = (n: YangNode): void => {
      seen.push(n.path);
      for (const c of yangBrowserChildren(n.path)) walk(c);
    };
    for (const r of yangBrowserRoots()) walk(r);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(yangNodes().map((n) => n.path).sort());
    expect(yangNodes().length).toBeGreaterThanOrEqual(40);
    // the roots: the four top-level data nodes, then the one operation
    expect(yangBrowserRoots().map((n) => n.path)).toEqual([
      'ietf-interfaces:interfaces',
      'ietf-interfaces:interfaces-state',
      'ietf-yang-library:modules-state',
      'nf-native:native',
      'nf-native:save-config',
    ]);
  });

  it('opening every branch shows every node as a row, children right below their parent', () => {
    const rows = visibleYangRows(new Set(yangBranchPaths()));
    expect(new Set(rows.map((r) => r.path)).size).toBe(rows.length);
    expect([...rows.map((r) => r.path)].sort()).toEqual(yangNodes().map((n) => n.path).sort());
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const node = yangNode(r.path)!;
      if (node.parent === undefined) expect(r.depth, r.path).toBe(0);
      else {
        const parentRow = rows.findIndex((x) => x.path === node.parent);
        expect(parentRow, r.path).toBeGreaterThanOrEqual(0);
        expect(parentRow, r.path).toBeLessThan(i);
        expect(r.depth, r.path).toBe(rows[parentRow]!.depth + 1);
      }
      expect(r.hasChildren, r.path).toBe(node.children.length > 0);
      expect(r.open, r.path).toBe(node.children.length > 0);
      expect(r.match).toBe(true);
    }
  });

  it('closed branches hide their children; the default view opens the way to the default node', () => {
    expect(visibleYangRows(new Set()).map((r) => r.path)).toEqual(yangBrowserRoots().map((n) => n.path));
    const rows = visibleYangRows(defaultOpenYangNodes());
    expect(rows.some((r) => r.path === DEFAULT_YANG_NODE)).toBe(true);
    expect(rows.find((r) => r.path === 'ietf-interfaces:interfaces')).toMatchObject({ open: true, label: 'ietf-interfaces:interfaces', access: 'config' });
    expect(rows.find((r) => r.path === 'ietf-interfaces:interfaces/interface')).toMatchObject({ open: false, label: 'interface', kind: 'list', summary: '[name]' });
    expect(rows.find((r) => r.path === 'nf-native:native/vlan/vlan-list/id')).toMatchObject({ summary: 'uint16 (1..4094)', access: 'config' });
  });

  it('every node can be found by its own name, with its ancestors kept and opened', () => {
    for (const n of yangNodes()) {
      const rows = visibleYangRows(new Set(), n.name);
      const hit = rows.find((r) => r.path === n.path);
      expect(hit?.match, n.path).toBe(true);
      for (let p = n.parent; p !== undefined; p = yangNode(p)?.parent) {
        expect(rows.find((r) => r.path === p), `${n.path} keeps ${p}`).toMatchObject({ open: true });
      }
    }
    // a search narrows: "counter" finds the statistics leaves only (plus their ancestors)
    const counters = visibleYangRows(new Set(), 'octets').filter((r) => r.match).map((r) => r.label);
    expect(counters).toEqual(['in-octets', 'out-octets']);
    expect(visibleYangRows(new Set(), 'no-such-node-anywhere')).toEqual([]);
    expect(yangNodeMatches(yangNode('nf-native:native/hostname')!, '  HOSTNAME ')).toBe(true);
  });

  it('every node has a detail, and the rendered tool shows a button for every node with every branch open', () => {
    for (const n of yangNodes()) {
      const d = yangNodeDetail(n.path);
      expect(d?.path, n.path).toBe(n.path);
      expect(d?.breadcrumb.at(-1)?.path).toBe(n.path);
      expect(d?.children.map((c) => c.path)).toEqual(n.children);
      expect(d?.description).toBe(n.description);
    }
    expect(yangNodeDetail('nf-native:no-such')).toBeUndefined();
    const html = renderToStaticMarkup(createElement<YangBrowserProps>(YangBrowser, { allOpen: true }));
    const shown = new Set([...html.matchAll(/data-yang-path="([^"]+)"/g)].map((m) => unescape(m[1] as string)));
    expect([...shown].sort()).toEqual(yangNodes().map((n) => n.path).sort());
  });
});

// ── every config node's sample lines parse against the grammar ──────────────

/** A P3 world with the managed switch and the router the RESTCONF service runs on. */
function world(): Simulation {
  const sim = createSimulation({ seed: 28, profile: 'P3' });
  sim.addDevice({ id: 'sw', type: 'switch.nfc2960', name: 'SW1', position: { x: 0, y: 0 } });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', position: { x: 200, y: 0 } });
  sim.runToIdle();
  return sim;
}

describe('every config node\'s sample lines parse against the grammar', () => {
  it('pastes every sample set into a switch or a router, as configuration mode takes it, with no error', () => {
    const sim = world();
    const wrong: string[] = [];
    let sets = 0;
    let lines = 0;
    for (const n of yangNodes()) {
      const samples = yangSampleLines(n);
      if (n.config || n.kind === 'rpc') {
        // every writable leaf and entry has lines (keys, containers and the hardware type excepted)
        const parent = n.parent !== undefined ? yangNode(n.parent) : undefined;
        const isKey = parent?.kind === 'list' && (parent.keys ?? []).includes(n.name);
        if (n.kind !== 'container' && !isKey && !n.path.endsWith('/type')) expect(samples.length, n.path).toBeGreaterThan(0);
      } else {
        expect(samples, `${n.path} is state data`).toEqual([]);
      }
      for (const s of samples) {
        sets += 1;
        lines += s.lines.length;
        for (const l of s.lines) expect(l, `${n.path}: an unfilled placeholder`).not.toMatch(/<[a-z-]+>/);
        const results = (['sw', 'r1'] as const).map((dev) => sim.configure(dev, s.lines, { indentation: true }));
        if (!results.some((r) => r.ok)) {
          const why = results.map((r) => r.lines.find((x) => !x.ok && x.skipped !== true)?.error?.message ?? '?').join(' | ');
          wrong.push(`${n.path} [${s.caption}]: ${s.lines.join(' / ')} -> ${why}`);
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(sets).toBeGreaterThanOrEqual(15);
    expect(lines).toBeGreaterThanOrEqual(25);
  });

  it('fills the samples from the model\'s examples, the list keys of the ancestors included', () => {
    expect(yangSampleLines(yangNode(DEFAULT_YANG_NODE)!)).toEqual([
      { op: 'set', caption: 'Writing it', lines: ['vlan 30', ' name VOICE'] },
      { op: 'unset', caption: 'Removing it', lines: ['vlan 30', ' no name'] },
    ]);
    expect(yangSampleLines(yangNode('ietf-interfaces:interfaces/interface/enabled')!).map((s) => [s.caption, s.lines])).toEqual([
      ['Writing it as true', ['interface Vlan99', ' no shutdown']],
      ['Writing it as false', ['interface Vlan99', ' shutdown']],
      ['Removing it', ['interface Vlan99', ' no shutdown']],
    ]);
    expect(yangSampleLines(yangNode('ietf-interfaces:interfaces/interface/ietf-ip:ipv4/address')!)[0]?.lines).toEqual(['interface Vlan99', ' ip address 10.0.99.11 255.255.255.0']);
    expect(yangSampleLines(yangNode('nf-native:save-config')!)).toEqual([{ op: 'exec', caption: 'Running it', lines: ['do copy running-config startup-config'] }]);
  });
});

// ── the detail pane ──────────────────────────────────────────────────────────

describe('the detail of a node', () => {
  it('gives every data node a RESTCONF address that resolves to that node, and every operation its POST', () => {
    for (const n of yangNodes()) {
      const req = yangRestconfRequest(n);
      expect(req.url, n.path).not.toMatch(/<[a-z-]+>/);
      if (n.kind === 'rpc') {
        expect(req.method).toBe('POST');
        const p = parseApiPath(req.url.slice('/restconf/operations'.length));
        expect(p.ok && resolveYangOperation(p.path), n.path).toMatchObject({ ok: true, node: { path: n.path } });
        continue;
      }
      expect(req.method).toBe('GET');
      expect(req.url.startsWith('/restconf/data/'), n.path).toBe(true);
      const p = parseApiPath(req.url.slice('/restconf/data'.length));
      expect(p.ok, `${n.path}: ${req.url}`).toBe(true);
      const r = p.ok ? resolveYangPath(p.path) : undefined;
      expect(r?.ok, `${n.path}: ${req.url}`).toBe(true);
      if (r?.ok === true) expect(r.steps.at(-1)?.node.path).toBe(n.path);
    }
    expect(yangRestconfRequest(yangNode('ietf-interfaces:interfaces/interface/ietf-ip:ipv4/address/prefix-length')!).url).toBe(
      '/restconf/data/ietf-interfaces:interfaces/interface=Vlan99/ietf-ip:ipv4/address=10.0.99.11/prefix-length',
    );
    expect(yangRestconfRequest(yangNode('ietf-interfaces:interfaces-state/interface/statistics/in-octets')!).url).toBe(
      '/restconf/data/ietf-interfaces:interfaces-state/interface=GigabitEthernet0%2F1/statistics/in-octets',
    );
    expect(yangRestconfRequest(yangNode('ietf-yang-library:modules-state/module')!).url).toBe('/restconf/data/ietf-yang-library:modules-state/module=ietf-interfaces,2018-02-20');
    expect(yangRestconfRequest(yangNode('nf-native:save-config')!)).toEqual({ method: 'POST', url: '/restconf/operations/nf-native:save-config' });
  });

  it('states kind, access, module and type facts from the model', () => {
    const id = yangNodeDetail('nf-native:native/vlan/vlan-list/id')!;
    expect(id).toMatchObject({ label: 'id', kind: 'leaf', access: 'config', module: { name: 'nf-native', prefix: 'nf' } });
    expect(id.facts).toEqual([
      ['Type', 'uint16'],
      ['Range', '1 to 4094'],
    ]);
    expect(id.samples).toEqual([]); // a key: written by its list entry's lines
    expect(id.sampleJson).toBe('{ "id": 30 }');
    const oper = yangNodeDetail('ietf-interfaces:interfaces-state/interface/oper-status')!;
    expect(oper.access).toBe('state');
    expect(oper.facts[1]?.[0]).toBe('Values');
    expect(oper.samples).toEqual([]);
    expect(yangNodeDetail('ietf-interfaces:interfaces/interface')!.facts).toEqual([['Keys', 'name']]);
    expect(yangNodeDetail('ietf-interfaces:interfaces/interface/ietf-ip:ipv4')!.breadcrumb.map((b) => b.label)).toEqual(['ietf-interfaces:interfaces', 'interface', 'ietf-ip:ipv4']);
    expect(yangSampleJson(yangNode('ietf-interfaces:interfaces/interface/enabled')!)).toBe('{ "enabled": true }');
    expect(yangSampleJson(yangNode('nf-native:native/hostname')!)).toBe('{ "hostname": "SW1" }');
    expect(yangSampleJson(yangNode('nf-native:native')!)).toBeUndefined();
    expect(yangAccess(yangNode('nf-native:save-config')!)).toBe('operation');
  });

  it('renders the detail: description, access, request, sample value and lines', () => {
    const t = text(renderToStaticMarkup(createElement(NodeDetail, { path: DEFAULT_YANG_NODE, onChoose: () => undefined })));
    expect(t).toContain(yangNode(DEFAULT_YANG_NODE)!.description);
    expect(t).toContain('GET /restconf/data/nf-native:native/vlan/vlan-list=30/name');
    expect(t).toContain('{ "name": "VOICE" }');
    expect(t).toContain('vlan 30 name VOICE');
    expect(t).toContain('Configuration (config true)');
    const state = text(renderToStaticMarkup(createElement(NodeDetail, { path: 'ietf-interfaces:interfaces-state/interface/speed', onChoose: () => undefined })));
    expect(state).toContain('State (config false)');
    expect(state).toContain('bits/second');
    expect(state).toContain('None: state data is reported by the device, not configured.');
  });
});

// ── the tree diagram ─────────────────────────────────────────────────────────

describe('the tree diagram (RFC 8340 notation)', () => {
  it('writes one line per node, rw/ro/-x, lists with keys, optional leaves', () => {
    const diagram = yangTreeDiagram();
    for (const n of yangNodes()) expect(diagram, n.path).toContain(yangTreeLine(n));
    expect(yangTreeLine(yangNode('ietf-interfaces:interfaces/interface')!)).toBe('+--rw interface* [name]');
    expect(yangTreeLine(yangNode('ietf-interfaces:interfaces/interface/name')!)).toBe('+--rw name   string');
    expect(yangTreeLine(yangNode('ietf-interfaces:interfaces/interface/description')!)).toBe('+--rw description?   string');
    expect(yangTreeLine(yangNode('ietf-interfaces:interfaces-state/interface/speed')!)).toBe('+--ro speed?   gauge64');
    expect(yangTreeLine(yangNode('nf-native:save-config')!)).toBe('+---x save-config');
    expect(yangTreeLine(yangNode('ietf-interfaces:interfaces')!)).toBe('+--rw interfaces');
    expect(yangTreeLine(yangNode('ietf-interfaces:interfaces/interface/ietf-ip:ipv4')!)).toBe('+--rw ip:ipv4');
    expect(diagram).toContain(['  +--rw interfaces', '  |  +--rw interface* [name]', '  |     +--rw name   string', '  |     +--rw description?   string'].join('\n'));
    expect(diagram.split('\n').filter((l) => l.startsWith('module: '))).toEqual(['module: ietf-interfaces', 'module: ietf-yang-library', 'module: nf-native']);
    expect(diagram).toContain('  rpcs:');
    expect(text(renderToStaticMarkup(createElement(TreeDiagramPane)))).toContain('module: nf-native');
  });
});

// ── legal, the tool and the registry ────────────────────────────────────────

describe('the tool', () => {
  it('shows IETF/IANA modules and the original nf-native only (rule 6: IETF YANG only)', () => {
    for (const n of yangNodes()) expect(/^(?:ietf|iana)-[a-z0-9-]+$/.test(n.module) || n.module === 'nf-native', n.path).toBe(true);
    for (const m of YANG_MODULES) expect(/^(?:ietf|iana)-[a-z0-9-]+$/.test(m.name) || m.name === 'nf-native', m.name).toBe(true);
  });

  it('opens on the default node with two labelled panes and labelled controls only', () => {
    const html = renderToStaticMarkup(createElement(YangBrowser));
    expect(YANG_PANES.map((p) => p.id)).toEqual(['browse', 'diagram']);
    expect(text(html)).toContain('Browse');
    expect(text(html)).toContain('Tree diagram');
    expect(text(html)).toContain('GET /restconf/data/nf-native:native/vlan/vlan-list=30/name');
    expect(html).toContain('role="tree"');
    expect(unlabelledControls(html)).toEqual([]);
    // the chosen node is marked selected in the tree
    expect(html).toMatch(/aria-selected="true"[^>]*>[\s\S]*?data-yang-path="nf-native:native\/vlan\/vlan-list\/name"/);
    const browse = renderToStaticMarkup(createElement(BrowsePane, { initialNode: 'nf-native:save-config' }));
    expect(text(browse)).toContain('POST /restconf/operations/nf-native:save-config');
    expect(text(browse)).toContain('do copy running-config startup-config');
  });

  it('is registered as a built concept tool and renders as a lazy chunk', () => {
    expect(isConceptToolBuilt('yang')).toBe(true);
    expect(CONCEPT_TOOL_VIEWS.yang).not.toBeNull();
    expect(CONCEPT_TOOLS.find((t) => t.id === 'yang')?.label).toBe('YANG browser');
    const html = renderToStaticMarkup(createElement<ConceptViewProps>(ConceptView, { tool: 'yang' }));
    expect(html).toContain('Loading the tool…');
    expect(html).not.toContain('This concept tool is not available in this build.');
  });
});
