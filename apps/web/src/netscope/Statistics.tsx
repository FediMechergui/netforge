/**
 * Statistics — the capture's protocol hierarchy, conversations, endpoints and frame lengths
 * (ARCHITECTURE-P1 §4.12; §10.2 accept.p1.netscope-filter "the statistics hierarchy includes
 * ethernet/ipv4/tcp/http"). The numbers are the engine's, over the records the applied filter matches.
 *
 * Every proportion is written twice: a run of filled and empty blocks AND the percentage in figures, so no
 * reading of this pane depends on seeing a bar.
 */
import { fmtBytes, formatSimTime } from '@netforge/engine/pure';
import type { CaptureStatistics } from '@netforge/engine';
import { protocolLabel } from '../vocab/protocols';
import { hierarchyTree, shareBar } from './netscope-client';
import './netscope.css';

export interface StatisticsProps {
  stats: CaptureStatistics | undefined;
  loading?: boolean;
  /** Set when the engine refused the query (an unknown capture, a filter it would not compile). */
  error?: string;
  /** The applied display filter, named in the heading when it narrows the numbers. */
  filter: string;
  note: string;
  onClose(): void;
}

/** Indent guide for a hierarchy depth (text, not padding, so it survives copy and paste). */
export function indentFor(depth: number): string {
  return depth === 0 ? '' : `${'   '.repeat(depth - 1)}└─ `;
}

export function Statistics({ stats, loading, error, filter, note, onClose }: StatisticsProps) {
  const nodes = stats ? hierarchyTree(stats) : [];
  return (
    <div className="ns-pane">
      <h4 id="ns-stats-title">Statistics{filter.trim() === '' ? '' : ` — filtered by ${filter}`}</h4>
      <div className="ns-bar">
        {stats && (
          <>
            <span>
              {stats.total} frame{stats.total === 1 ? '' : 's'}
            </span>
            <span>{fmtBytes(stats.bytes)}</span>
            <span>over {formatSimTime(stats.durationNs)}</span>
          </>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Back to the frames
        </button>
      </div>
      <div className="ns-scroll ns-stats" aria-labelledby="ns-stats-title">
        {error !== undefined && (
          <div className="ns-err" role="alert">
            ⚠ {error}
          </div>
        )}
        {!stats ? (
          <div className="ns-note">{loading === true ? 'Counting the frames…' : note}</div>
        ) : stats.total === 0 ? (
          <div className="ns-note">Nothing matched, so there is nothing to count.</div>
        ) : (
          <>
            <section>
              <h5>Protocol hierarchy</h5>
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Protocol</th>
                    <th className="num">Frames</th>
                    <th>Share</th>
                    <th className="num">Bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((n) => {
                    const bar = shareBar(n.share);
                    return (
                      <tr key={n.path}>
                        <td className="mono" title={n.path}>
                          {indentFor(n.depth)}
                          {protocolLabel(n.label)}
                        </td>
                        <td className="num">{n.frames}</td>
                        <td className="ns-bar-cell" aria-label={`${bar.text} of the frames`}>
                          <span aria-hidden="true">{bar.bar} </span>
                          {bar.text}
                        </td>
                        <td className="num">{fmtBytes(n.bytes)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <section>
              <h5>Conversations</h5>
              {stats.conversations.length === 0 ? (
                <div className="ns-note">No pair of addresses exchanged frames.</div>
              ) : (
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Layer</th>
                      <th>Side A</th>
                      <th>Side B</th>
                      <th className="num">Frames</th>
                      <th className="num">Bytes</th>
                      <th>First seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.conversations.map((c, i) => (
                      <tr key={`${c.proto}:${c.a}:${c.b}:${i}`}>
                        <td>{protocolLabel(c.proto)}</td>
                        <td className="mono">{c.a}</td>
                        <td className="mono">{c.b}</td>
                        <td className="num">{c.frames}</td>
                        <td className="num">{fmtBytes(c.bytes)}</td>
                        <td className="mono">{formatSimTime(c.firstNs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h5>Endpoints</h5>
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Layer</th>
                    <th>Address</th>
                    <th className="num">Frames</th>
                    <th className="num">Bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.endpoints.map((e, i) => (
                    <tr key={`${e.proto}:${e.address}:${i}`}>
                      <td>{protocolLabel(e.proto)}</td>
                      <td className="mono">{e.address}</td>
                      <td className="num">{e.frames}</td>
                      <td className="num">{fmtBytes(e.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h5>Frame lengths</h5>
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Bytes</th>
                    <th className="num">Frames</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.lengths.map((l) => {
                    const bar = shareBar(stats.total > 0 ? l.frames / stats.total : 0);
                    return (
                      <tr key={l.bucket}>
                        <td className="mono">{l.bucket}</td>
                        <td className="num">{l.frames}</td>
                        <td className="ns-bar-cell" aria-label={`${bar.text} of the frames`}>
                          <span aria-hidden="true">{bar.bar} </span>
                          {bar.text}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
