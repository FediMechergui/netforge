/**
 * Subnetting workbench (ARCHITECTURE-P1 §4.13, §7 "Concept views", §10.2): the view over
 * concept/subnetting/model.ts. Three panes, one at a time:
 *
 *  - **Bits and mask** — one address split at its prefix: the 32 bits with an N/H letter under each, the
 *    interesting octet and its block size, and every figure the model computes (network, broadcast, usable
 *    range, wildcard, class and borrowed bits), plus the subnet before and after it.
 *  - **Split a block (VLSM)** — a parent block and a list of "this many hosts" requirements, carved largest
 *    first by `carveVlsm`, with the leftover space as aligned blocks.
 *  - **Practice** — the seeded question generator: the same seed always gives the same questions, and a wrong
 *    answer shows the model's own one-line method.
 *
 * Every figure comes from the model (§10.2 pins its vectors); nothing is recomputed here. Bits are labelled
 * with letters and the mask boundary with a `|`, so nothing is told by colour alone, and every control is a
 * labelled input or button. Wording is original (§1.6).
 *
 * ponytail: one address at a time and one flat VLSM level — the CCNA 1 exercises do exactly that, and the
 * model already refuses anything it cannot carve.
 */
import { useId, useMemo, useState } from 'react';
import {
  bitCells,
  carveVlsm,
  checkPracticeAnswer,
  formatBits,
  neighbourSubnet,
  parseSubnetInput,
  practiceProblem,
  subnetInfo,
  type PracticeCheck,
  type SubnetInfo,
  type VlsmRequirement,
} from './model';

/** Panes of the workbench. */
export type SubnetPane = 'bits' | 'vlsm' | 'practice';

/** Pane names in display order. */
export const SUBNET_PANES: readonly { readonly id: SubnetPane; readonly label: string }[] = Object.freeze([
  { id: 'bits', label: 'Bits and mask' },
  { id: 'vlsm', label: 'Split a block' },
  { id: 'practice', label: 'Practice' },
]);

/** Default address the workbench opens on (the §10.2 vector). */
export const DEFAULT_SUBNET_INPUT = '192.168.1.130/26';
/** Default parent block of the VLSM pane. */
export const DEFAULT_VLSM_PARENT = '192.168.10.0/24';
/** Requirements the VLSM pane starts with. */
export const DEFAULT_VLSM_ROWS: readonly VlsmRequirement[] = Object.freeze([
  { name: 'Offices', hosts: 60 },
  { name: 'Workshop', hosts: 28 },
  { name: 'Router link', hosts: 2 },
]);

/** Address / mask figures of `text`, or the model's reason for refusing it. */
export function readSubnet(text: string): { readonly info: SubnetInfo } | { readonly error: string } {
  const parsed = parseSubnetInput(text);
  if (!parsed.ok) return { error: parsed.error };
  return { info: subnetInfo(parsed.value.address, parsed.value.prefixLen) };
}

export function SubnetWorkbench() {
  const [pane, setPane] = useState<SubnetPane>('bits');
  const uid = useId();
  return (
    <div className="dock-panel">
      <div className="dock-toolbar" role="group" aria-label="Subnetting panes">
        {SUBNET_PANES.map((p) => (
          <button
            key={p.id}
            type="button"
            id={`${uid}-tab-${p.id}`}
            aria-pressed={pane === p.id}
            aria-controls={`${uid}-pane`}
            className={`tab${pane === p.id ? ' is-active' : ''}`}
            onClick={() => setPane(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="dock-scroll" id={`${uid}-pane`} aria-labelledby={`${uid}-tab-${pane}`}>
        {pane === 'bits' && <BitsPane />}
        {pane === 'vlsm' && <VlsmPane />}
        {pane === 'practice' && <PracticePane />}
      </div>
    </div>
  );
}

// ── bits and mask ────────────────────────────────────────────────────────────

export function BitsPane() {
  const uid = useId();
  const [text, setText] = useState(DEFAULT_SUBNET_INPUT);
  const read = useMemo(() => readSubnet(text), [text]);
  return (
    <>
      <div className="desk-field">
        <label htmlFor={`${uid}-addr`}>Address with a prefix or a mask</label>
        <input
          id={`${uid}-addr`}
          className="input mono"
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={'error' in read}
          aria-describedby={'error' in read ? `${uid}-addr-err` : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="dim">Write it as 192.168.1.130/26, 192.168.1.130/255.255.255.192 or 192.168.1.130 255.255.255.192.</span>
      </div>
      {'error' in read ? (
        <p id={`${uid}-addr-err`} className="insp-note" role="alert">
          <span aria-hidden="true">⚠ </span>
          {read.error}
        </p>
      ) : (
        <SubnetReport info={read.info} />
      )}
    </>
  );
}

/** One row of the bit view: 32 bits with an N (network) or H (host) letter under each. */
export function BitRow({ info }: { info: SubnetInfo }) {
  const cells = bitCells(info.address, info.prefixLen);
  return (
    <table className="table">
      <caption className="dim">
        Bits of {info.address}. N marks a network bit, H a host bit; the prefix ends after {info.prefixLen} bit{info.prefixLen === 1 ? '' : 's'}.
      </caption>
      <tbody>
        <tr>
          <th scope="row">Bit</th>
          {cells.map((c) => (
            <td key={c.index} className="mono">
              {c.bit}
            </td>
          ))}
        </tr>
        <tr>
          <th scope="row">Part</th>
          {cells.map((c) => (
            <td key={c.index} className="mono">
              {c.part === 'network' ? 'N' : 'H'}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

function SubnetReport({ info }: { info: SubnetInfo }) {
  const b = info.boundary;
  const previous = neighbourSubnet(info.address, info.prefixLen, -1);
  const next = neighbourSubnet(info.address, info.prefixLen, 1);
  const rows: readonly (readonly [string, string])[] = [
    ['Network address', info.network],
    ['Broadcast address', info.broadcast],
    ['First usable host', info.firstUsable],
    ['Last usable host', info.lastUsable],
    ['Usable hosts', String(info.usableHosts)],
    ['Addresses in the block', String(info.totalAddresses)],
    ['Subnet mask', info.mask],
    ['Wildcard mask', info.wildcard],
    ['Offset inside the subnet', String(info.hostOffset)],
    ['Address class', `${info.classful.addressClass}${info.classful.defaultPrefixLen === null ? '' : ` (default /${info.classful.defaultPrefixLen})`}`],
    [
      'Borrowed bits',
      info.classful.borrowedBits === null ? 'not a host block' : `${info.classful.borrowedBits} → ${info.classful.subnetCount} subnet${info.classful.subnetCount === 1 ? '' : 's'}`,
    ],
    ['Interesting octet', `octet ${b.octetIndex + 1}, mask ${b.maskOctet}, block size ${b.blockSize}`],
    ['Address range', info.isPrivate ? 'private' : 'public'],
    ['Previous subnet', previous === null ? 'none below' : `${previous}/${info.prefixLen}`],
    ['Next subnet', next === null ? 'none above' : `${next}/${info.prefixLen}`],
  ];
  return (
    <>
      <div className="panel-title">The address, bit by bit</div>
      <BitRow info={info} />
      <table className="table">
        <caption className="dim">The mask boundary written with a bar.</caption>
        <tbody>
          <tr>
            <th scope="row">Address</th>
            <td className="mono">{formatBits(info.bits.address, info.prefixLen)}</td>
          </tr>
          <tr>
            <th scope="row">Mask</th>
            <td className="mono">{formatBits(info.bits.mask, info.prefixLen)}</td>
          </tr>
          <tr>
            <th scope="row">Network</th>
            <td className="mono">{formatBits(info.bits.network, info.prefixLen)}</td>
          </tr>
          <tr>
            <th scope="row">Broadcast</th>
            <td className="mono">{formatBits(info.bits.broadcast, info.prefixLen)}</td>
          </tr>
        </tbody>
      </table>
      {info.reserved !== null && (
        <p className="insp-note">
          <span aria-hidden="true">⚑ </span>
          {info.address} is the {info.reserved} address of this subnet, so no host may use it.
        </p>
      )}
      <div className="panel-title">What that gives you</div>
      <table className="table">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className="mono">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ── VLSM ─────────────────────────────────────────────────────────────────────

export function VlsmPane() {
  const uid = useId();
  const [parent, setParent] = useState(DEFAULT_VLSM_PARENT);
  const [rows, setRows] = useState<VlsmRequirement[]>([...DEFAULT_VLSM_ROWS]);
  const result = useMemo(() => carveVlsm(parent, rows), [parent, rows]);
  const edit = (i: number, patch: Partial<VlsmRequirement>): void => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      <div className="desk-field">
        <label htmlFor={`${uid}-parent`}>Block to split</label>
        <input id={`${uid}-parent`} className="input mono" value={parent} spellCheck={false} autoComplete="off" onChange={(e) => setParent(e.target.value)} />
      </div>
      <div className="panel-title">How many hosts each subnet must hold</div>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Hosts</th>
            <th scope="col">Remove</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  id={`${uid}-name-${i}`}
                  className="input"
                  value={r.name}
                  autoComplete="off"
                  aria-label={`Name of subnet ${i + 1}`}
                  onChange={(e) => edit(i, { name: e.target.value })}
                />
              </td>
              <td>
                <input
                  id={`${uid}-hosts-${i}`}
                  className="input mono"
                  type="number"
                  min={1}
                  value={r.hosts}
                  aria-label={`Hosts in subnet ${i + 1}`}
                  onChange={(e) => edit(i, { hosts: Math.trunc(Number(e.target.value)) })}
                />
              </td>
              <td>
                <button type="button" className="btn" aria-label={`Remove subnet ${i + 1}`} onClick={() => setRows((list) => list.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="desk-actions">
        <button type="button" className="btn" onClick={() => setRows((list) => [...list, { name: `Subnet ${list.length + 1}`, hosts: 10 }])}>
          Add a subnet
        </button>
      </div>
      {result.ok ? (
        <>
          <div className="panel-title">Carved out of {result.parent}</div>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Block</th>
                <th scope="col">Mask</th>
                <th scope="col">Usable range</th>
                <th scope="col">Broadcast</th>
                <th scope="col">Spare</th>
              </tr>
            </thead>
            <tbody>
              {result.allocations.map((a) => (
                <tr key={a.cidr}>
                  <th scope="row">{a.name === '' ? `Subnet ${a.inputIndex + 1}` : a.name}</th>
                  <td className="mono">{a.cidr}</td>
                  <td className="mono">{a.mask}</td>
                  <td className="mono">
                    {a.firstUsable} – {a.lastUsable}
                  </td>
                  <td className="mono">{a.broadcast}</td>
                  <td className="mono">
                    {a.spareHosts} of {a.usableHosts}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dim">
            {result.usedAddresses} of {result.totalAddresses} addresses used. Still free:{' '}
            <span className="mono">{result.free.length === 0 ? 'nothing' : result.free.join(', ')}</span>.
          </p>
        </>
      ) : (
        <p className="insp-note" role="alert">
          <span aria-hidden="true">⚠ </span>
          {result.error}
        </p>
      )}
    </>
  );
}

// ── practice ─────────────────────────────────────────────────────────────────

export function PracticePane() {
  const uid = useId();
  const [seed, setSeed] = useState(1);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [checked, setChecked] = useState<PracticeCheck | null>(null);
  const problem = useMemo(() => practiceProblem(seed, index), [seed, index]);
  const move = (nextIndex: number, nextSeed = seed): void => {
    setSeed(nextSeed);
    setIndex(nextIndex);
    setAnswer('');
    setChecked(null);
  };
  return (
    <>
      <div className="dock-toolbar">
        <div className="desk-field">
          <label htmlFor={`${uid}-seed`}>Question set</label>
          <input
            id={`${uid}-seed`}
            className="input mono"
            type="number"
            value={seed}
            onChange={(e) => move(0, Math.trunc(Number(e.target.value)) || 0)}
          />
        </div>
        <span className="dim">Question {index + 1}. The same set number always asks the same questions.</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setChecked(checkPracticeAnswer(problem, answer));
        }}
      >
        <p>{problem.prompt}</p>
        <div className="desk-field">
          <label htmlFor={`${uid}-answer`}>Your answer</label>
          <input id={`${uid}-answer`} className="input mono" value={answer} spellCheck={false} autoComplete="off" onChange={(e) => setAnswer(e.target.value)} />
        </div>
        <div className="desk-actions">
          <button type="submit" className="btn btn-primary">
            Check
          </button>
          <button type="button" className="btn" onClick={() => move(index + 1)}>
            Next question
          </button>
        </div>
      </form>
      {/* Mounted before there is an answer, so a screen reader hears the verdict when it arrives (§16). */}
      <div className={`insp-note${checked === null ? ' is-empty' : ''}`} role="status" aria-live="polite">
        {checked !== null && (
          <>
            <p>
              <span aria-hidden="true">{checked.correct ? '✓ ' : '✗ '}</span>
              {checked.correct ? 'That is right.' : `Not yet — the answer is ${checked.expected}.`}
              {!checked.correct && checked.given === null && ' That answer could not be read as an address, a mask, a count or a prefix.'}
            </p>
            <p className="dim">{checked.explanation}</p>
          </>
        )}
      </div>
    </>
  );
}
