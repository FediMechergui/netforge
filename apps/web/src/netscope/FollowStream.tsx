/**
 * FollowStream — one conversation reassembled end to end (ARCHITECTURE-P1 §4.12 "Follow stream";
 * §10.2 accept.p1.netscope-filter "follow stream shows the request and response text").
 *
 * The engine reassembles by sequence number, drops retransmitted bytes and parses the HTTP messages; this
 * pane only reads the result out. Each side is labelled A or B with an arrow and its address, and the two
 * sides also differ in border style, so the transcript survives greyscale and a screen reader alike.
 */
import { fmtBytes } from '@netforge/engine/pure';
import type { FollowStreamResult } from '@netforge/engine';
import './netscope.css';

export interface FollowStreamProps {
  result: FollowStreamResult | undefined;
  loading?: boolean;
  /** Set when the engine refused the key (no such conversation). */
  error?: string;
  /** Shown when no conversation was chosen. */
  note: string;
  onClose(): void;
}

/** "A → B  192.168.1.80:49152 → 192.168.1.1:80" for a chunk's direction. */
export function sideLabel(from: 0 | 1, endpoints: readonly [string, string]): string {
  const [a, b] = endpoints;
  return from === 0 ? `A → B   ${a} → ${b}` : `B → A   ${b} → ${a}`;
}

export function FollowStream({ result, loading, error, note, onClose }: FollowStreamProps) {
  return (
    <div className="ns-pane">
      <h4 id="ns-stream-title">Follow stream{result ? ` — ${result.proto.toUpperCase()} ${result.key}` : ''}</h4>
      <div className="ns-bar">
        {result && (
          <>
            <span>
              A {result.endpoints[0]} · B {result.endpoints[1]}
            </span>
            <span>
              {result.chunks.length} block{result.chunks.length === 1 ? '' : 's'}
            </span>
            <span title="Bytes the sender repeated; they are shown once.">{result.retransmissions} repeated segment{result.retransmissions === 1 ? '' : 's'}</span>
          </>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Back to the frames
        </button>
      </div>
      <div className="ns-scroll" aria-labelledby="ns-stream-title">
        {error !== undefined && (
          <div className="ns-err" role="alert">
            ⚠ {error}
          </div>
        )}
        {!result ? (
          <div className="ns-note">{loading === true ? 'Reassembling the conversation…' : note}</div>
        ) : result.chunks.length === 0 ? (
          <div className="ns-note">This conversation carried no data yet — only control segments.</div>
        ) : (
          <pre className="ns-stream">
            {result.chunks.map((chunk, i) => (
              <span key={`${chunk.from}:${chunk.index}:${i}`} className={`ns-chunk ${chunk.from === 0 ? 'from-a' : 'from-b'}`}>
                <span className="who">
                  {sideLabel(chunk.from, result.endpoints)} · frame {chunk.index + 1} · {fmtBytes(chunk.bytes)}
                </span>
                {chunk.text}
              </span>
            ))}
          </pre>
        )}
        {result?.http && result.http.length > 0 && (
          <div className="ns-stats">
            <section>
              <h5>Messages the HTTP decoder recognised</h5>
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Frame</th>
                    <th>Kind</th>
                    <th>Start line</th>
                    <th className="num">Body bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {result.http.map((m, i) => (
                    <tr key={`${m.index}:${i}`}>
                      <td className="num">{m.index + 1}</td>
                      <td>{m.kind === 'request' ? '▶ request' : '◀ response'}</td>
                      <td className="mono">{m.startLine}</td>
                      <td className="num">{m.body.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
