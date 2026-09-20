/**
 * Lab instructions markdown (ARCHITECTURE-P1 §4.13, §7 "Labs browser", §10.2 `markdown.test.ts`): the
 * allowlisted subset a `ScenarioMeta.instructions` string may use, parsed into a small tree that LabPanel
 * renders with React elements.
 *
 * THIS IS A SECURITY BOUNDARY. Lab text is data, never markup: the parser produces text, code, emphasis and
 * link nodes and NOTHING else, so there is no node kind a renderer could turn into raw HTML. Angle brackets,
 * ampersands and quotes travel inside text nodes and React escapes them when it renders. Link targets are
 * allowlisted to `concept:subnetting`, `concept:ipv6` and `https://…`; every other target (`javascript:`,
 * `data:`, plain `http:`, a relative path) is not a link at all — the whole `[text](target)` run stays visible
 * as literal text, so nothing is silently dropped either. Anything else the parser does not know is text too.
 *
 * Subset: `#`…`######` headings, `-`/`*`/`+` and `1.` lists, ``` fenced code, blank-line separated paragraphs,
 * `` `code` ``, `**strong**`, `*em*` / `_em_` and `[text](target)`.
 *
 * ponytail: one flat list level (an indented item joins the list it follows rather than nesting), no tables,
 * block quotes, images, footnotes, reference links, HTML entities or backslash escapes — none of them appear in
 * the CCNA 1 lab text, and every one of them would be one more thing to prove safe; an unterminated fence runs
 * to the end of the text as code, which shows the author exactly what they forgot to close.
 */

/** Concept views a lab may link to (`concept:subnetting`, `concept:ipv6`). */
export type ConceptLinkTool = 'subnetting' | 'ipv6';

/** Where an allowed link points. */
export type MdLinkTarget = { kind: 'concept'; tool: ConceptLinkTool } | { kind: 'external'; href: string };

/** One piece of a line. Text and code carry literal characters; the rest wrap more pieces. */
export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'em'; children: MdInline[] }
  | { kind: 'strong'; children: MdInline[] }
  | { kind: 'link'; target: MdLinkTarget; children: MdInline[] };

/** One block of instructions. */
export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { kind: 'paragraph'; children: MdInline[] }
  | { kind: 'list'; ordered: boolean; items: MdInline[][] }
  | { kind: 'code'; text: string };

/** Longest instructions text the parser reads; the rest is dropped (a lab is a page, not a book). */
export const MARKDOWN_MAX_CHARS = 20_000;

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const ORDERED = /^[ \t]*\d{1,9}[.)][ \t]+(.*)$/;
const FENCE = /^[ \t]*(?:```|~~~)/;

/**
 * The allowed target of `[text](href)`, or null when the link is not allowed. Only `concept:subnetting`,
 * `concept:ipv6` and an `https://` address with no whitespace, angle brackets or quotes pass.
 */
export function markdownLinkTarget(href: string): MdLinkTarget | null {
  const t = href.trim();
  if (t === 'concept:subnetting') return { kind: 'concept', tool: 'subnetting' };
  if (t === 'concept:ipv6') return { kind: 'concept', tool: 'ipv6' };
  if (/^https:\/\/[^\s<>"'`\\]+$/i.test(t)) return { kind: 'external', href: `https://${t.slice('https://'.length)}` };
  return null;
}

/** Parse instructions text into blocks. Never throws; unknown syntax stays text. */
export function parseMarkdown(text: string): MdBlock[] {
  const lines = String(text ?? '').slice(0, MARKDOWN_MAX_CHARS).split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test((lines[i] ?? '').replace(/\r$/, ''))) {
        body.push((lines[i] ?? '').replace(/\r$/, ''));
        i++;
      }
      i++; // the closing fence (or the end of the text)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]!.length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2]!.replace(/[ \t]+#+[ \t]*$/, '')) });
      i++;
      continue;
    }
    const first = itemText(line);
    if (first !== null) {
      const ordered = ORDERED.test(line);
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const raw = (lines[i] ?? '').replace(/\r$/, '');
        const item = itemText(raw);
        if (item === null || ORDERED.test(raw) !== ordered) break;
        items.push(parseInline(item));
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const raw = (lines[i] ?? '').replace(/\r$/, '');
      if (raw.trim() === '' || HEADING.test(raw) || FENCE.test(raw) || itemText(raw) !== null) break;
      para.push(raw.trim());
      i++;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(para.join(' ')) });
  }
  return blocks;
}

/** Text of a list item line, or null when the line is not one. */
function itemText(line: string): string | null {
  const o = ORDERED.exec(line);
  if (o) return o[1]!;
  const b = BULLET.exec(line);
  return b ? b[1]! : null;
}

const INLINE = /(`+)([\s\S]*?)\1|\[([^\]\n]*)\]\(([^()\s]*)\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+)\*|_([^_\n]+)_/;

/** Parse one line into inline pieces. Everything the pattern does not match stays literal text. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = text;
  for (;;) {
    const m = INLINE.exec(rest);
    if (m === null) break;
    pushText(out, rest.slice(0, m.index));
    const whole = m[0]!;
    if (m[2] !== undefined) out.push({ kind: 'code', text: m[2].trim() === '' ? m[2] : m[2].replace(/^ | $/g, '') });
    else if (m[4] !== undefined) {
      const target = markdownLinkTarget(m[4]);
      if (target === null) pushText(out, whole); // not an allowed target: the source stays visible as text
      else out.push({ kind: 'link', target, children: parseInline(m[3] ?? '') });
    } else if (m[5] !== undefined || m[6] !== undefined) out.push({ kind: 'strong', children: parseInline((m[5] ?? m[6])!) });
    else out.push({ kind: 'em', children: parseInline((m[7] ?? m[8])!) });
    rest = rest.slice(m.index + whole.length);
  }
  pushText(out, rest);
  return out;
}

function pushText(out: MdInline[], text: string): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last !== undefined && last.kind === 'text') last.text += text;
  else out.push({ kind: 'text', text });
}

/** The characters of a run of inline pieces, with no markup at all (labels, titles, tests). */
export function inlineText(nodes: readonly MdInline[]): string {
  return nodes.map((n) => (n.kind === 'text' || n.kind === 'code' ? n.text : inlineText(n.children))).join('');
}

/** The characters of a whole document, one block per line (screen-reader summaries, tests). */
export function markdownText(blocks: readonly MdBlock[]): string {
  return blocks
    .map((b) => {
      if (b.kind === 'code') return b.text;
      if (b.kind === 'list') return b.items.map((it) => inlineText(it)).join('\n');
      return inlineText(b.children);
    })
    .join('\n');
}
