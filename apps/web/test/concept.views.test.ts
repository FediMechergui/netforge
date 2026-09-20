// Concept views (ARCHITECTURE-P1 §4.13, §7 "Concept views", §8.2 W7 web-learn): the subnetting workbench and
// the IPv6 explorer over the W2 models. The views must SHOW the model's own figures and steps (§10.2 pins the
// model vectors), label every control, and tell nothing by colour alone.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

// The workspace host is rendered here too; its two heavy children only need to be present, not to draw.
vi.mock('../src/canvas/Canvas', () => ({ Canvas: () => createElement('div', { className: 'nf-canvas' }) }));
vi.mock('../src/desktop/WindowLayer', () => ({ WindowLayer: () => null }));

import { useStore } from '../src/store/store';
import { Workspace } from '../src/app/Workspace';
import { CONCEPT_TOOLS, ConceptView, conceptToolLabel } from '../src/concept/ConceptView';
import { BitsPane, PracticePane, SUBNET_PANES, SubnetWorkbench, VlsmPane, readSubnet } from '../src/concept/subnetting/SubnetWorkbench';
import { Eui64Pane, IPV6_PANES, IdentifyPane, Ipv6Explorer, ShortenPane } from '../src/concept/ipv6/Ipv6Explorer';
import { practiceProblem } from '../src/concept/subnetting/model';

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

/** Every input and select in `html` is named by a `<label for>` or an aria-label (§16). */
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

/** `aria-controls` values that name no element in `html` — a dangling IDREF tells assistive tech nothing. */
function danglingControls(html: string): string[] {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] as string));
  return [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1] as string).filter((v) => !ids.has(v));
}

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

beforeEach(() => {
  const s = (useStore as unknown as { getState(): Record<string, unknown> }).getState();
  for (const k of Object.keys(s)) delete s[k];
});

describe('subnetting workbench', () => {
  it('reads an address the three ways the model accepts, and reports a refusal', () => {
    const ok = readSubnet('192.168.1.130/26');
    expect('info' in ok && ok.info.network).toBe('192.168.1.128');
    expect('info' in readSubnet('192.168.1.130 255.255.255.192')).toBe(true);
    const bad = readSubnet('not an address/26');
    expect('error' in bad && bad.error.length > 0).toBe(true);
  });

  it('shows the §10.2 figures of 192.168.1.130/26, with the bits lettered and the boundary barred', () => {
    const html = renderToStaticMarkup(createElement(BitsPane));
    const t = text(html);
    expect(t).toContain('192.168.1.128'); // network
    expect(t).toContain('192.168.1.191'); // broadcast
    expect(t).toContain('192.168.1.129'); // first usable
    expect(t).toContain('192.168.1.190'); // last usable
    expect(t).toContain('255.255.255.192'); // mask
    expect(t).toContain('0.0.0.63'); // wildcard
    expect(t).toContain('11111111.11111111.11111111.11|000000'); // the mask boundary, as a bar
    expect(t).toContain('octet 4, mask 192, block size 64');
    expect(t).toContain('2 → 4 subnets'); // borrowed bits
    // Non-colour channel: each of the 32 bits carries an N (network) or an H (host) letter.
    expect((html.match(/>N</g) ?? []).length).toBe(26);
    expect((html.match(/>H</g) ?? []).length).toBe(6);
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('carves a block into VLSM subnets, largest first, and names the free space', () => {
    const t = text(renderToStaticMarkup(createElement(VlsmPane)));
    expect(t).toContain('192.168.10.0/26'); // 60 hosts
    expect(t).toContain('192.168.10.64/27'); // 28 hosts
    expect(t).toContain('192.168.10.96/30'); // 2 hosts
    expect(t).toContain('192.168.10.100/30, 192.168.10.104/29'); // the free blocks, aligned
    expect(t).toContain('Offices');
    expect(t).toContain('Router link');
    expect(unlabelledControls(renderToStaticMarkup(createElement(VlsmPane)))).toEqual([]);
  });

  it('asks the seeded practice question of the model, not one of its own', () => {
    const html = renderToStaticMarkup(createElement(PracticePane));
    expect(text(html)).toContain(practiceProblem(1, 0).prompt);
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('offers its three panes as a labelled button group', () => {
    const html = renderToStaticMarkup(createElement(SubnetWorkbench));
    expect(SUBNET_PANES.map((p) => p.id)).toEqual(['bits', 'vlsm', 'practice']);
    expect(html).toContain('role="group" aria-label="Subnetting panes"');
    expect((html.match(/aria-pressed="/g) ?? []).length).toBe(3);
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(text(html)).toContain('Bits and mask');
    // Only the open pane is in the DOM, so every button points at the one pane wrapper (§16).
    expect(danglingControls(html)).toEqual([]);
  });

  it('keeps the practice verdict in a live region that exists before there is a verdict', () => {
    const html = renderToStaticMarkup(createElement(PracticePane));
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('is-empty');
  });
});

describe('IPv6 explorer', () => {
  it('walks the §10.2 compression vector step by step', () => {
    const t = text(renderToStaticMarkup(createElement(ShortenPane)));
    expect(t).toContain('2001:0db8:0000:0000:0000:ff00:0042:8329'); // as typed / written out
    expect(t).toContain('2001:db8:0:0:0:ff00:42:8329'); // after the leading zeros go
    expect(t).toContain('2001:db8::ff00:42:8329'); // after the zero run is replaced
    expect(t).toContain('3 groups from position 3'); // the run that :: replaced
    expect(t).toContain('✓'); // each step says whether it changed anything
    expect(unlabelledControls(renderToStaticMarkup(createElement(ShortenPane)))).toEqual([]);
  });

  it('walks a MAC to a link-local address and shows the flipped bit', () => {
    const html = renderToStaticMarkup(createElement(Eui64Pane));
    const t = text(html);
    expect(t).toContain('fe80::4e:59ff:fee8:af01'); // the EUI-64 vector
    expect(t).toContain('4e:59ff:fee8:af01'); // the interface id
    expect(t).toContain('00000010'); // the first byte before the flip
    expect(t).toContain('00000000'); // and after it
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('names an address type, its block and its interface id', () => {
    const html = renderToStaticMarkup(createElement(IdentifyPane));
    const t = text(html);
    expect(t).toContain('link-local');
    expect(t).toContain('fe80::/10');
    expect(t).toContain('built from a MAC');
    expect(t).toContain('/64'); // where the prefix splits it
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('offers its three panes as a labelled button group', () => {
    const html = renderToStaticMarkup(createElement(Ipv6Explorer));
    expect(IPV6_PANES.map((p) => p.id)).toEqual(['shorten', 'eui64', 'identify']);
    expect((html.match(/aria-pressed="/g) ?? []).length).toBe(3);
    expect(text(html)).toContain('Shorten or write out');
    expect(danglingControls(html)).toEqual([]);
  });
});

describe('concept view host', () => {
  it('opens the subnetting workbench by default and names both tools', () => {
    const t = text(renderToStaticMarkup(createElement(ConceptView)));
    expect(CONCEPT_TOOLS.map((c) => c.id)).toEqual(['subnetting', 'ipv6']);
    expect(conceptToolLabel('ipv6')).toBe('IPv6');
    expect(t).toContain('Subnetting');
    expect(t).toContain('IPv6');
    expect(t).toContain('Bits and mask'); // the workbench, not the explorer
    expect(t).not.toContain('Back to the topology'); // the store offers no view switch yet
  });

  it('follows the store when it carries the P1 view state, and the prop over both', () => {
    setState({ conceptTool: 'ipv6', setView: () => undefined });
    const stored = text(renderToStaticMarkup(createElement(ConceptView)));
    expect(stored).toContain('Shorten or write out');
    expect(stored).toContain('Back to the topology');
    const forced = text(renderToStaticMarkup(createElement(ConceptView, { tool: 'subnetting' })));
    expect(forced).toContain('Bits and mask');
  });
});

// §4.13: "The Canvas stays mounted and hidden" — the workspace must reach the tools, and come back.
describe('the workspace host', () => {
  it('shows only the topology while the view is the topology', () => {
    const html = renderToStaticMarkup(createElement(Workspace, { view: 'topology' }));
    expect(html).toContain('class="app-canvas"');
    expect(html).not.toContain('app-concept');
    expect(html).not.toContain('hidden');
  });

  it('mounts the chosen concept tool and keeps the canvas mounted but hidden', () => {
    setState({ conceptTool: 'ipv6', setView: () => undefined });
    const html = renderToStaticMarkup(createElement(Workspace, { view: 'concept' }));
    expect(html).toContain('app-concept');
    expect(html).toContain('aria-label="Concept tools"');
    expect(text(html)).toContain('Shorten or write out'); // the IPv6 explorer, not the workbench
    // The canvas is still in the document, so the scene, the camera and the desktop windows survive.
    expect(html).toContain('class="nf-canvas"');
    expect(/<main class="app-canvas"[^>]*hidden/.test(html)).toBe(true);
  });
});
