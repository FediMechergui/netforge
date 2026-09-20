// Lab instructions markdown (ARCHITECTURE-P1 §4.13, §10.2 "Web P1" `markdown.test.ts`): the allowlisted subset,
// and the security boundary — lab text is data, never markup. Every construct the parser does not know stays
// text, the only link targets are `concept:subnetting`, `concept:ipv6` and https, and no node kind exists that a
// renderer could turn into raw HTML.
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@netforge/engine';
import {
  MARKDOWN_MAX_CHARS,
  inlineText,
  markdownLinkTarget,
  markdownText,
  parseInline,
  parseMarkdown,
  type MdBlock,
  type MdInline,
} from '../src/labs/markdown';

/** Every node kind the parser may ever produce (there is deliberately no 'html'). */
const BLOCK_KINDS = ['heading', 'paragraph', 'list', 'code'];
const INLINE_KINDS = ['text', 'code', 'em', 'strong', 'link'];

function walkInline(nodes: readonly MdInline[], visit: (n: MdInline) => void): void {
  for (const n of nodes) {
    visit(n);
    if (n.kind === 'em' || n.kind === 'strong' || n.kind === 'link') walkInline(n.children, visit);
  }
}

function walkBlocks(blocks: readonly MdBlock[], visit: (n: MdInline) => void): void {
  for (const b of blocks) {
    expect(BLOCK_KINDS).toContain(b.kind);
    if (b.kind === 'heading' || b.kind === 'paragraph') walkInline(b.children, visit);
    if (b.kind === 'list') for (const item of b.items) walkInline(item, visit);
  }
}

describe('markdown subset', () => {
  it('reads headings, paragraphs, lists and fenced code', () => {
    const blocks = parseMarkdown(
      ['## What to do', '', 'Give R1 an address', 'on its LAN side.', '', '- first', '* second', '', '1. one', '2) two', '', '```', 'ip address 10.0.0.1 255.0.0.0', '```'].join('\n'),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'list', 'code']);
    const heading = blocks[0]!;
    expect(heading.kind === 'heading' && heading.level).toBe(2);
    expect(inlineText(heading.kind === 'heading' ? heading.children : [])).toBe('What to do');
    // Consecutive lines are one paragraph, joined with a space.
    expect(markdownText([blocks[1]!])).toBe('Give R1 an address on its LAN side.');
    const bullets = blocks[2]!;
    expect(bullets.kind === 'list' && bullets.ordered).toBe(false);
    expect(bullets.kind === 'list' && bullets.items.map((i) => inlineText(i))).toEqual(['first', 'second']);
    const ordered = blocks[3]!;
    expect(ordered.kind === 'list' && ordered.ordered).toBe(true);
    expect(ordered.kind === 'list' && ordered.items.map((i) => inlineText(i))).toEqual(['one', 'two']);
    expect(blocks[4]).toEqual({ kind: 'code', text: 'ip address 10.0.0.1 255.0.0.0' });
  });

  it('reads code spans, emphasis and strong emphasis', () => {
    expect(parseInline('type `show ip route` twice')).toEqual([
      { kind: 'text', text: 'type ' },
      { kind: 'code', text: 'show ip route' },
      { kind: 'text', text: ' twice' },
    ]);
    expect(parseInline('**both** *ends* _now_')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'both' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'ends' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'now' }] },
    ]);
    // A code span wins over the emphasis markers inside it.
    expect(parseInline('`a * b`')).toEqual([{ kind: 'code', text: 'a * b' }]);
    // An unclosed marker is just text.
    expect(parseInline('2 * 3 = 6')).toEqual([{ kind: 'text', text: '2 * 3 = 6' }]);
  });

  it('allows only concept and https link targets', () => {
    expect(markdownLinkTarget('concept:subnetting')).toEqual({ kind: 'concept', tool: 'subnetting' });
    expect(markdownLinkTarget(' concept:ipv6 ')).toEqual({ kind: 'concept', tool: 'ipv6' });
    expect(markdownLinkTarget('https://example.org/a?b=1')).toEqual({ kind: 'external', href: 'https://example.org/a?b=1' });
    for (const bad of [
      'concept:vlans',
      'concept:',
      'http://example.org',
      'javascript:alert(1)',
      'JavaScript:alert',
      'data:text/html,hi',
      'vbscript:x',
      '/labs/1',
      '#top',
      'https://exa mple.org',
      'https://example.org/"onmouseover="x',
      '',
    ]) {
      expect(markdownLinkTarget(bad)).toBeNull();
    }
  });

  it('turns an allowed link into a link node and leaves every other one as text', () => {
    expect(parseInline('open the [subnetting view](concept:subnetting) now')).toEqual([
      { kind: 'text', text: 'open the ' },
      { kind: 'link', target: { kind: 'concept', tool: 'subnetting' }, children: [{ kind: 'text', text: 'subnetting view' }] },
      { kind: 'text', text: ' now' },
    ]);
    for (const source of ['[click](javascript:alert)', '[click](data:text/html,x)', '[click](http://plain.example)', '[click](concept:vlans)']) {
      expect(parseInline(source)).toEqual([{ kind: 'text', text: source }]);
    }
  });

  it('never produces markup: angle brackets, quotes and ampersands stay characters in text nodes', () => {
    const source = ['# <script>alert("x")</script>', '', '<img src=x onerror="steal()">', '', '- a & b <b>bold</b>', '', '`<iframe src="x">`'].join('\n');
    const blocks = parseMarkdown(source);
    const kinds: string[] = [];
    walkBlocks(blocks, (n) => kinds.push(n.kind));
    for (const k of kinds) expect(INLINE_KINDS).toContain(k);
    // The dangerous characters survive as characters — React escapes them when it renders a text node.
    const flat = markdownText(blocks);
    expect(flat).toContain('<script>alert("x")</script>');
    expect(flat).toContain('<img src=x onerror="steal()">');
    expect(flat).toContain('a & b <b>bold</b>');
    // …and nothing ever became a link or an attribute carrier.
    let links = 0;
    walkBlocks(blocks, (n) => {
      if (n.kind === 'link') links++;
    });
    expect(links).toBe(0);
    expect(JSON.stringify(blocks)).not.toContain('"html"');
  });

  it('is total: odd input parses without throwing and never loses the text', () => {
    for (const odd of ['', '   ', '#', '#no space', '```unclosed\nbody', '- ', '****', '[](concept:ipv6)', '\n\n\n', 'a\r\nb']) {
      expect(() => parseMarkdown(odd)).not.toThrow();
    }
    expect(parseMarkdown('#no space').map((b) => b.kind)).toEqual(['paragraph']);
    expect(parseMarkdown('```unclosed\nbody')).toEqual([{ kind: 'code', text: 'body' }]);
    expect(parseMarkdown('a\r\nb')[0]).toEqual({ kind: 'paragraph', children: [{ kind: 'text', text: 'a b' }] });
    // Very long text is cut, never walked forever.
    const huge = 'x'.repeat(MARKDOWN_MAX_CHARS + 500);
    expect(markdownText(parseMarkdown(huge)).length).toBe(MARKDOWN_MAX_CHARS);
  });

  it('parses the instructions of every shipped lab into known nodes only', () => {
    const withInstructions = SCENARIOS.filter((s) => s.instructions !== undefined);
    expect(withInstructions.length).toBeGreaterThan(0);
    for (const s of withInstructions) {
      const blocks = parseMarkdown(s.instructions as string);
      expect(blocks.length).toBeGreaterThan(0);
      walkBlocks(blocks, (n) => expect(INLINE_KINDS).toContain(n.kind));
    }
    const subnetting = SCENARIOS.find((s) => s.concept === 'subnetting');
    expect(subnetting).toBeDefined();
    const targets: string[] = [];
    walkBlocks(parseMarkdown(subnetting!.instructions as string), (n) => {
      if (n.kind === 'link') targets.push(n.target.kind === 'concept' ? `concept:${n.target.tool}` : n.target.href);
    });
    expect(targets).toContain('concept:subnetting');
  });
});
