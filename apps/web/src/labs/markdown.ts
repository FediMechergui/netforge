/**
 * Lab instructions markdown (ARCHITECTURE-P1 §4.13, §7 "Labs browser", §10.2 `markdown.test.ts`): the
 * allowlisted subset a `ScenarioMeta.instructions` string may use, parsed into a small tree that LabPanel
 * renders with React elements.
 *
 * THIS IS A SECURITY BOUNDARY. Lab text is data, never markup: the parser produces text, code, emphasis and
 * link nodes and NOTHING else, so there is no node kind a renderer could turn into raw HTML. Angle brackets,
 * ampersands and quotes travel inside text nodes and React escapes them when it renders. Link targets are
 * allowlisted to `concept:<id>` for the ids of `ConceptToolId` and `https://…`; every other target (`javascript:`,
 * `data:`, plain `http:`, a relative path) is not a link at all — the whole `[text](target)` run stays visible
 * as literal text, so nothing is silently dropped either. Anything else the parser does not know is text too.
 *
 * Subset: `#`…`######` headings, `-`/`*`/`+` and `1.` lists, ``` fenced code, blank-line separated paragraphs,
 * `` `code` ``, `**strong**`, `*em*` / `_em_` and `[text](target)`.
 *
 * @since P3 (ARCHITECTURE-P3 §2.14, D24, §11.3; W1 web-learn) A fence may name the language of its block — ```json,
 * ```yaml, ```xml, ```http, ```python or ```text — and the code block then carries `lang`. It is DISPLAY-ONLY: a label
 * and a class for the renderer. It never changes how the body is read: the body of a fence is literal text whatever
 * the language, so a JSON body that holds `[x](https://…)` or `<b>` stays characters, never a link or markup. Any other
 * info string (an unknown language, a second word) is ignored exactly as before, so a fence without a known language
 * gives the same `{kind: 'code', text}` node as in P1/P2.
 *
 * ponytail: one flat list level (an indented item joins the list it follows rather than nesting), no tables,
 * block quotes, images, footnotes, reference links, HTML entities or backslash escapes — none of them appear in
 * the CCNA 1 lab text, and every one of them would be one more thing to prove safe; an unterminated fence runs
 * to the end of the text as code, which shows the author exactly what they forgot to close.
 */

import type { ConceptToolId } from '@netforge/engine';

/**
 * Concept views a lab may link to (`concept:subnetting`, `concept:ipv6`, …). @since P3 the one engine contract
 * `ConceptToolId` (ARCHITECTURE-P3 D24, §2.14): the local union is gone.
 */
export type ConceptLinkTool = ConceptToolId;

/**
 * @since P3 The `concept:<id>` allowlist, exhaustive over `ConceptToolId` (a new id is a compile error here until it is
 * listed): subnetting, ipv6, and the P3 'queueing', 'data-formats' and [S9] 'wildcard' (ARCHITECTURE-P3 §9.2 W0 item 2).
 */
const CONCEPT_LINK_IDS: Readonly<Record<ConceptToolId, true>> = Object.freeze({
  subnetting: true,
  ipv6: true,
  queueing: true,
  'data-formats': true,
  wildcard: true,
});

const CONCEPT_PREFIX = 'concept:';

/** Where an allowed link points. */
export type MdLinkTarget = { kind: 'concept'; tool: ConceptLinkTool } | { kind: 'external'; href: string };

/** One piece of a line. Text and code carry literal characters; the rest wrap more pieces. */
export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'em'; children: MdInline[] }
  | { kind: 'strong'; children: MdInline[] }
  | { kind: 'link'; target: MdLinkTarget; children: MdInline[] };

/** @since P3 The languages a code fence may name (display-only, §2.14). */
export const MD_CODE_LANGS = ['json', 'yaml', 'xml', 'http', 'python', 'text'] as const;
/** @since P3 One language a code fence may name. */
export type MdCodeLang = (typeof MD_CODE_LANGS)[number];

/** @since P3 The label a renderer shows above a code block of each language. */
export const MD_CODE_LANG_LABEL: Readonly<Record<MdCodeLang, string>> = Object.freeze({
  json: 'JSON',
  yaml: 'YAML',
  xml: 'XML',
  http: 'HTTP',
  python: 'Python',
  text: 'Text',
});

/** One block of instructions. `lang` (P3) is present only when the fence named a language of `MD_CODE_LANGS`. */
export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { kind: 'paragraph'; children: MdInline[] }
  | { kind: 'list'; ordered: boolean; items: MdInline[][] }
  | { kind: 'code'; text: string; lang?: MdCodeLang };

/** Longest instructions text the parser reads; the rest is dropped (a lab is a page, not a book). */
export const MARKDOWN_MAX_CHARS = 20_000;

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const ORDERED = /^[ \t]*\d{1,9}[.)][ \t]+(.*)$/;
const FENCE = /^[ \t]*(?:```|~~~)/;
/** An opening fence and its info string: the language is the whole info string, one word of letters. */
const FENCE_LANG = /^[ \t]*(?:```|~~~)[ \t]*([A-Za-z]+)[ \t]*$/;

/**
 * @since P3 The display language an opening fence line names, or undefined: only a single word of `MD_CODE_LANGS`
 * (any case) counts; anything else in the info string is ignored, as it always was.
 */
export function fenceLang(line: string): MdCodeLang | undefined {
  const m = FENCE_LANG.exec(line.replace(/\r$/, ''));
  if (m === null) return undefined;
  const word = (m[1] ?? '').toLowerCase();
  return (MD_CODE_LANGS as readonly string[]).includes(word) ? (word as MdCodeLang) : undefined;
}

/**
 * The allowed target of `[text](href)`, or null when the link is not allowed. Only `concept:<id>` for an id of
 * `ConceptToolId` and an `https://` address with no whitespace, angle brackets or quotes pass.
 */
export function markdownLinkTarget(href: string): MdLinkTarget | null {
  const t = href.trim();
  if (t.startsWith(CONCEPT_PREFIX)) {
    const id = t.slice(CONCEPT_PREFIX.length);
    if (Object.prototype.hasOwnProperty.call(CONCEPT_LINK_IDS, id)) return { kind: 'concept', tool: id as ConceptToolId };
    return null;
  }
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
      const lang = fenceLang(line);
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test((lines[i] ?? '').replace(/\r$/, ''))) {
        body.push((lines[i] ?? '').replace(/\r$/, ''));
        i++;
      }
      i++; // the closing fence (or the end of the text)
      blocks.push(lang === undefined ? { kind: 'code', text: body.join('\n') } : { kind: 'code', text: body.join('\n'), lang });
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
