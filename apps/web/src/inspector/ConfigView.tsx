/**
 * Running-config viewer with line numbers and an optional diff against the
 * saved startup-config. Added lines carry a '+' sign and a green tint, removed
 * lines a '−' sign, a red tint and strike-through — never colour alone.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import './inspector.css';

type Op = 'same' | 'add' | 'del';

interface Line {
  text: string;
  op: Op;
  /** Line number in the running-config (undefined for removed lines). */
  ln?: number;
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const LCS_CELL_LIMIT = 4_000_000;

/** Ordered line diff (LCS); falls back to a set difference for very large inputs. */
function diffLines(before: readonly string[], after: readonly string[]): Line[] {
  const n = before.length;
  const m = after.length;
  const out: Line[] = [];
  if (n * m > LCS_CELL_LIMIT) {
    const inBefore = new Set(before);
    const inAfter = new Set(after);
    for (const t of before) if (!inAfter.has(t)) out.push({ text: t, op: 'del' });
    after.forEach((t, i) => out.push({ text: t, op: inBefore.has(t) ? 'same' : 'add', ln: i + 1 }));
    return out;
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  const at = (i: number, j: number): number => dp[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const a = before[i] ?? '';
    const b = after[j] ?? '';
    if (a === b) {
      out.push({ text: b, op: 'same', ln: j + 1 });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ text: a, op: 'del' });
      i++;
    } else {
      out.push({ text: b, op: 'add', ln: j + 1 });
      j++;
    }
  }
  for (; i < n; i++) out.push({ text: before[i] ?? '', op: 'del' });
  for (; j < m; j++) out.push({ text: after[j] ?? '', op: 'add', ln: j + 1 });
  return out;
}

const SIGN: Record<Op, string> = { same: ' ', add: '+', del: '−' };

interface ConfigViewProps {
  running: string;
  startup?: string;
  /** A config line to highlight and scroll to (e.g. a provenance cause). */
  highlight?: string | null;
  /** Bump to re-scroll to the same highlight. */
  highlightNonce?: number;
}

export function ConfigView({ running, startup, highlight, highlightNonce = 0 }: ConfigViewProps) {
  const [showDiff, setShowDiff] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const hasStartup = startup !== undefined;
  const diffing = showDiff && hasStartup;

  const lines = useMemo<Line[]>(() => {
    const run = splitLines(running);
    if (diffing && startup !== undefined) return diffLines(splitLines(startup), run);
    return run.map((text, i) => ({ text, op: 'same', ln: i + 1 }));
  }, [running, startup, diffing]);

  const counts = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const l of lines) {
      if (l.op === 'add') add++;
      else if (l.op === 'del') del++;
    }
    return { add, del };
  }, [lines]);

  const hotIndex = useMemo(() => {
    const want = highlight?.trim();
    if (!want) return -1;
    const exact = lines.findIndex((l) => l.op !== 'del' && l.text.trim() === want);
    if (exact >= 0) return exact;
    return lines.findIndex((l) => l.op !== 'del' && l.text.trim().length > 1 && want.includes(l.text.trim()) && !l.text.trim().startsWith('!'));
  }, [lines, highlight]);

  useEffect(() => {
    if (hotIndex < 0) return;
    const el = preRef.current?.querySelector('.cfg-line.is-hot');
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center' });
  }, [hotIndex, highlightNonce]);

  const runningCount = lines.filter((l) => l.op !== 'del').length;

  return (
    <div>
      <div className="cfg-toolbar">
        <span>
          running-config · {runningCount} line{runningCount === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        {hasStartup ? (
          <>
            {diffing && (
              <span className="mono" title="Lines added / removed since the last save">
                +{counts.add} / −{counts.del}
              </span>
            )}
            <label>
              <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} /> diff vs
              startup
            </label>
          </>
        ) : (
          <span title="Save with: copy running-config startup-config">not saved yet (no startup-config)</span>
        )}
      </div>
      {diffing && counts.add === 0 && counts.del === 0 && (
        <div className="insp-note">The running configuration matches the saved startup configuration.</div>
      )}
      <pre className="cfg" ref={preRef}>
        {lines.map((l, i) => {
          const cls = `cfg-line${l.op === 'add' ? ' add' : l.op === 'del' ? ' del' : ''}${i === hotIndex ? ' is-hot' : ''}`;
          const comment = l.text.trimStart().startsWith('!');
          return (
            <div key={i} className={cls}>
              <span className="cfg-ln">{l.ln ?? ''}</span>
              {diffing && (
                <span className="cfg-sign" aria-label={l.op === 'add' ? 'added' : l.op === 'del' ? 'removed' : undefined}>
                  {SIGN[l.op]}
                </span>
              )}
              <span className={`cfg-text${comment ? ' comment' : ''}`}>{l.text || ' '}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
