// protocols/ike/{exchange,proof}.ts [C13] (ARCHITECTURE-P3 D27, §2.17, §3.13, §4.1, §4.2; §7 W1 wan), at the field
// level (the bytes are the W1 pdu item's codec): the four messages of §3.13 with their exact fields, the FNV proof and
// the SPI, nonce, KE and ESP SPI derivations, the crossing rule whichever request arrives first, a wrong key, an
// unknown peer, a silent peer (three retransmissions, then ike-no-response), repeated requests and a peer reload.
import { describe, expect, it } from 'vitest';
import { ipv4ToU32 } from '../src/contracts/addr.js';
import { SEC } from '../src/contracts/time.js';
import {
  IKE_AUTH,
  IKE_FLAG_INITIATOR,
  IKE_FLAG_RESPONSE,
  IKE_IDLE,
  IKE_NO_RESPONSE_WAIT_NS,
  IKE_NOTIFY_AUTHENTICATION_FAILED,
  IKE_NOTIFY_NO_PROPOSAL_CHOSEN,
  IKE_PROPOSAL,
  IKE_PROPOSAL_LABEL,
  IKE_REXMT_DELAYS_NS,
  IKE_RETRY_NS,
  IKE_SA_INIT,
  IKE_SPI_ZERO,
  IKE_TRAFFIC_SELECTOR,
  ikeChildProposal,
  ikeChildSpiOf,
  ikeKeepsOwnExchange,
  ikeReceive,
  ikeStart,
  ikeStop,
  ikeTimeout,
  ipsecSaStateOf,
  type IkeEnv,
  type IkeMessage,
  type IkeStep,
  type IkeTunnel,
} from '../src/protocols/ike/exchange.js';
import {
  ESP_SPI_MIN,
  espSpiOf,
  fnvChainHex,
  ikeAuthProof,
  ikeKeOf,
  ikeNonceOf,
  ikeSpiOf,
  ipsecKeyIdOf,
} from '../src/protocols/ike/proof.js';

const R1 = '209.165.200.225';
const R2 = '209.165.200.230';
const KEY = 'Lab-Key-2025';

/** One end of the §3.13 tunnel: its environment (the counter advances as the daemon would) and its state. */
class End {
  tunnel: IkeTunnel = IKE_IDLE;
  counter = 0;
  readonly log: IkeStep[] = [];
  constructor(
    readonly device: string,
    readonly local: string,
    readonly peer: string,
    public key: string | undefined,
  ) {}
  env(): IkeEnv {
    return { device: this.device, port: 'Tunnel0', local: this.local, peer: this.peer, key: this.key, counter: this.counter };
  }
  private take(s: IkeStep): IkeStep {
    this.tunnel = s.tunnel;
    if (s.consumedCounter) this.counter++;
    this.log.push(s);
    return s;
  }
  start(): IkeStep {
    return this.take(ikeStart(this.tunnel, this.env()));
  }
  receive(m: IkeMessage): IkeStep {
    return this.take(ikeReceive(this.tunnel, m, this.env()));
  }
  timeout(): IkeStep {
    return this.take(ikeTimeout(this.tunnel));
  }
}

/** R1 and R2 of §3.13 with their keys (`null`: no keyring peer for the other end). */
const pair = (k1: string | null = KEY, k2: string | null = KEY): [End, End] => [new End('r1', R1, R2, k1 ?? undefined), new End('r2', R2, R1, k2 ?? undefined)];

/** Deliver `s.send` to `to`; fail the test if there is nothing to send. */
function deliver(s: IkeStep, to: End): IkeStep {
  expect(s.send, 'a message to deliver').toBeDefined();
  return to.receive(s.send!);
}

describe('ike proof: derived values (§4.1, D27)', () => {
  it('SPIs are 16 hex digits, nonces and KE values 32 bytes (64 hex digits), proofs 16 bytes (32 hex digits)', () => {
    expect(ikeSpiOf('r1', 'Tunnel0', 0, 'I')).toMatch(/^[0-9a-f]{16}$/);
    expect(ikeNonceOf('r1', 'Tunnel0', 0, 'I')).toMatch(/^[0-9a-f]{64}$/);
    expect(ikeKeOf('r1', 'Tunnel0', 0, 'I')).toMatch(/^[0-9a-f]{64}$/);
    const inputs = { key: KEY, spiI: 'a'.repeat(16), spiR: 'b'.repeat(16), nonceI: 'c'.repeat(64), nonceR: 'd'.repeat(64) };
    expect(ikeAuthProof(inputs, 'I')).toMatch(/^[0-9a-f]{32}$/);
    expect(ikeSpiOf('r1', 'Tunnel0', 0, 'I')).not.toBe(IKE_SPI_ZERO);
  });

  it('every value is deterministic and differs by device, port, counter and role', () => {
    const base = ikeSpiOf('r1', 'Tunnel0', 0, 'I');
    expect(ikeSpiOf('r1', 'Tunnel0', 0, 'I')).toBe(base);
    const variants = [
      ikeSpiOf('r2', 'Tunnel0', 0, 'I'),
      ikeSpiOf('r1', 'Tunnel1', 0, 'I'),
      ikeSpiOf('r1', 'Tunnel0', 1, 'I'),
      ikeSpiOf('r1', 'Tunnel0', 0, 'R'),
    ];
    expect(new Set([base, ...variants]).size).toBe(5);
    expect(ikeNonceOf('r1', 'Tunnel0', 0, 'I')).not.toBe(ikeNonceOf('r1', 'Tunnel0', 0, 'R'));
    expect(ikeNonceOf('r1', 'Tunnel0', 0, 'I')).not.toBe(ikeKeOf('r1', 'Tunnel0', 0, 'I'));
  });

  it('ESP SPIs are u32 values of at least 256, distinct per device, port and counter', () => {
    const spis = new Set<number>();
    for (const dev of ['r1', 'r2', 'r3'])
      for (const port of ['Tunnel0', 'Tunnel1'])
        for (let c = 0; c < 20; c++) {
          const v = espSpiOf(dev, port, c);
          expect(Number.isInteger(v) && v >= ESP_SPI_MIN && v <= 0xffff_ffff).toBe(true);
          spis.add(v);
        }
    expect(spis.size).toBe(120);
  });

  it('the proof depends on the key, both SPIs, both nonces and the role; the key id on all but the role', () => {
    const inputs = { key: KEY, spiI: ikeSpiOf('r1', 'Tunnel0', 0, 'I'), spiR: ikeSpiOf('r2', 'Tunnel0', 0, 'R'), nonceI: ikeNonceOf('r1', 'Tunnel0', 0, 'I'), nonceR: ikeNonceOf('r2', 'Tunnel0', 0, 'R') };
    const p = ikeAuthProof(inputs, 'I');
    expect(ikeAuthProof(inputs, 'I')).toBe(p);
    expect(ikeAuthProof(inputs, 'R')).not.toBe(p);
    for (const k of ['key', 'spiI', 'spiR', 'nonceI', 'nonceR'] as const) {
      expect(ikeAuthProof({ ...inputs, [k]: `${inputs[k]}x` }, 'I'), k).not.toBe(p);
      expect(ipsecKeyIdOf({ ...inputs, [k]: `${inputs[k]}x` }), k).not.toBe(ipsecKeyIdOf(inputs));
    }
    expect(p.includes(KEY)).toBe(false);
  });

  it('the chain is FNV-1a words written big-endian; its length must be a positive multiple of 4', () => {
    expect(fnvChainHex('x', 8)).toMatch(/^[0-9a-f]{16}$/);
    expect(fnvChainHex('x', 8).slice(0, 8)).toBe(fnvChainHex('x', 4));
    expect(() => fnvChainHex('x', 6)).toThrow(RangeError);
    expect(() => fnvChainHex('x', 0)).toThrow(RangeError);
  });
});

describe('ike exchange: the four messages (§3.13 steps 2–6)', () => {
  it('IKE_SA_INIT, its answer, IKE_AUTH and its answer carry exactly the §2.17 fields, and both ends establish', () => {
    const [r1, r2] = pair();
    // R1 initiates (R2's own kick comes later in this case: it is answering first).
    const s1 = r1.start();
    expect(s1.transition).toEqual({ from: 'idle', to: 'init-sent', cause: 'exchange started' });
    expect(s1.timer).toEqual({ op: 'arm', delayNs: 1 * SEC });
    expect(s1.consumedCounter).toBe(true);
    const spiI = ikeSpiOf('r1', 'Tunnel0', 0, 'I');
    const nonceI = ikeNonceOf('r1', 'Tunnel0', 0, 'I');
    expect(s1.send).toEqual({
      spiI,
      spiR: IKE_SPI_ZERO,
      exchange: IKE_SA_INIT,
      flags: IKE_FLAG_INITIATOR,
      messageId: 0,
      sa: 'enc=aes-cbc-256,integ=sha256,prf=sha256,dh=14',
      ke: ikeKeOf('r1', 'Tunnel0', 0, 'I'),
      nonce: nonceI,
    });

    const s2 = deliver(s1, r2);
    const spiR = ikeSpiOf('r2', 'Tunnel0', 0, 'R');
    const nonceR = ikeNonceOf('r2', 'Tunnel0', 0, 'R');
    expect(s2.transition).toEqual({ from: 'idle', to: 'init-answered', cause: 'IKE_SA_INIT request received' });
    expect(s2.send).toEqual({ spiI, spiR, exchange: 34, flags: IKE_FLAG_RESPONSE, messageId: 0, sa: IKE_PROPOSAL, ke: ikeKeOf('r2', 'Tunnel0', 0, 'R'), nonce: nonceR });
    expect(r2.tunnel.role).toBe('responder');

    const s3 = deliver(s2, r1);
    const proofInputs = { key: KEY, spiI, spiR, nonceI, nonceR };
    const r1In = espSpiOf('r1', 'Tunnel0', 0);
    expect(s3.transition).toEqual({ from: 'init-sent', to: 'auth-sent', cause: 'IKE_SA_INIT answered' });
    expect(s3.timer).toEqual({ op: 'arm', delayNs: 1 * SEC });
    expect(s3.send).toEqual({
      spiI,
      spiR,
      exchange: IKE_AUTH,
      flags: IKE_FLAG_INITIATOR,
      messageId: 1,
      idi: R1,
      auth: ikeAuthProof(proofInputs, 'I'),
      sa: ikeChildProposal(r1In),
      tsi: '0.0.0.0/0',
      tsr: IKE_TRAFFIC_SELECTOR,
    });

    const s4 = deliver(s3, r2);
    const r2In = espSpiOf('r2', 'Tunnel0', 0);
    const keyId = ipsecKeyIdOf(proofInputs);
    expect(s4.transition).toEqual({ from: 'init-answered', to: 'established', cause: 'initiator authenticated' });
    expect(s4.send).toEqual({
      spiI,
      spiR,
      exchange: IKE_AUTH,
      flags: IKE_FLAG_RESPONSE,
      messageId: 1,
      idr: R2,
      auth: ikeAuthProof(proofInputs, 'R'),
      sa: ikeChildProposal(r2In),
      tsi: IKE_TRAFFIC_SELECTOR,
      tsr: IKE_TRAFFIC_SELECTOR,
    });
    expect(s4.sa).toEqual({ op: 'up', spiIn: r2In, spiOut: r1In, keyId });

    const s5 = deliver(s4, r1);
    expect(s5.transition).toEqual({ from: 'auth-sent', to: 'established', cause: 'responder authenticated' });
    expect(s5.timer).toEqual({ op: 'cancel' });
    expect(s5.send).toBeUndefined();
    expect(s5.sa).toEqual({ op: 'up', spiIn: r1In, spiOut: r2In, keyId });

    expect([r1.tunnel.state, r2.tunnel.state]).toEqual(['established', 'established']);
    expect([ipsecSaStateOf(r1.tunnel.state), ipsecSaStateOf('auth-sent'), ipsecSaStateOf('failed')]).toEqual(['established', 'negotiating', 'failed']);
    expect(IKE_PROPOSAL_LABEL).toBe('aes-cbc-256 sha256 group14');
    // The key is in no field of any message.
    for (const step of [...r1.log, ...r2.log]) {
      if (step.send) for (const v of Object.values(step.send)) expect(String(v).includes(KEY)).toBe(false);
    }
  });

  it('the child proposal round-trips its SPI', () => {
    expect(ikeChildProposal(0x1234)).toBe('esp:enc=aes-cbc-256,integ=sha256,spi=0x00001234');
    expect(ikeChildSpiOf(ikeChildProposal(0xfedcba98))).toBe(0xfedcba98);
    expect(ikeChildSpiOf(IKE_PROPOSAL)).toBeUndefined();
    expect(ikeChildSpiOf(undefined)).toBeUndefined();
  });
});

describe('ike exchange: crossing initiations (D27, §3.13 step 3)', () => {
  it('the lower source address keeps its exchange', () => {
    expect(ipv4ToU32(R1) < ipv4ToU32(R2)).toBe(true);
    expect(ikeKeepsOwnExchange(R1, R2)).toBe(true);
    expect(ikeKeepsOwnExchange(R2, R1)).toBe(false);
  });

  for (const firstArrival of ['at R2', 'at R1'] as const) {
    it(`both ends initiate at once; R1's request arrives ${firstArrival} first; R1's exchange completes either way`, () => {
      const [r1, r2] = pair();
      const i1 = r1.start();
      const i2 = r2.start();
      let answer: IkeStep;
      if (firstArrival === 'at R2') {
        answer = deliver(i1, r2);
        const discard = deliver(i2, r1);
        expect(discard.send).toBeUndefined();
        expect(discard.note).toMatch(/lower address 209\.165\.200\.225 keeps its own exchange/);
        expect(r1.tunnel.state).toBe('init-sent');
      } else {
        const discard = deliver(i2, r1);
        expect(discard.send).toBeUndefined();
        expect(r1.tunnel.state).toBe('init-sent');
        answer = deliver(i1, r2);
      }
      // R2 abandons its own exchange (its retransmission timer is cancelled) and answers as the responder.
      expect(answer.transition).toEqual({ from: 'init-sent', to: 'init-answered', cause: 'crossing request from the lower address 209.165.200.225' });
      expect(answer.timer).toEqual({ op: 'cancel' });
      expect(r2.tunnel.role).toBe('responder');
      expect(r2.tunnel.spiI).toBe(i1.send!.spiI);
      const auth = deliver(answer, r1);
      const done = deliver(deliver(auth, r2), r1);
      expect([r1.tunnel.state, r2.tunnel.state]).toEqual(['established', 'established']);
      expect([r1.tunnel.role, r2.tunnel.role]).toEqual(['initiator', 'responder']);
      expect(done.sa?.op).toBe('up');
      // Same SAs whichever order: R1's SPI I from counter 0, R2's SPI R from counter 1 (its counter 0 went to its own start).
      expect(r1.tunnel.spiI).toBe(ikeSpiOf('r1', 'Tunnel0', 0, 'I'));
      expect(r2.tunnel.spiR).toBe(ikeSpiOf('r2', 'Tunnel0', 1, 'R'));
    });
  }
});

describe('ike exchange: failures (§3.13 step 10, D27)', () => {
  it('a wrong key: the responder answers AUTHENTICATION_FAILED; both ends fail with ike-failed', () => {
    const [r1, r2] = pair(KEY, 'another-key');
    const s4 = deliver(deliver(deliver(r1.start(), r2), r1), r2);
    expect(s4.send).toEqual({
      spiI: r1.tunnel.spiI,
      spiR: r2.tunnel.spiR,
      exchange: IKE_AUTH,
      flags: IKE_FLAG_RESPONSE,
      messageId: 1,
      notify: IKE_NOTIFY_AUTHENTICATION_FAILED,
    });
    expect(s4.transition).toEqual({ from: 'init-answered', to: 'failed', cause: 'the initiator proof does not match the pre-shared key' });
    expect(s4.sa).toEqual({ op: 'down', reason: 'ike-failed' });
    expect(s4.timer).toBeUndefined();
    const s5 = deliver(s4, r1);
    expect(s5.transition).toEqual({ from: 'auth-sent', to: 'failed', cause: 'the responder refused the proof' });
    expect(s5.sa).toEqual({ op: 'down', reason: 'ike-failed' });
    expect(s5.timer).toEqual({ op: 'cancel' });
    expect([r1.tunnel.reason, r2.tunnel.reason]).toEqual(['ike-failed', 'ike-failed']);
  });

  it('the periodic retry after a failure starts a new exchange with fresh values; a corrected key establishes', () => {
    const [r1, r2] = pair(KEY, 'another-key');
    deliver(deliver(deliver(deliver(r1.start(), r2), r1), r2), r1);
    expect(r1.tunnel.state).toBe('failed');
    expect(IKE_RETRY_NS).toBe(10 * SEC);
    r2.key = KEY;
    const retry = r1.start();
    expect(retry.transition).toEqual({ from: 'failed', to: 'init-sent', cause: 'exchange started' });
    expect(retry.send!.spiI).toBe(ikeSpiOf('r1', 'Tunnel0', 1, 'I'));
    const answer = deliver(retry, r2);
    expect(answer.transition).toEqual({ from: 'failed', to: 'init-answered', cause: 'IKE_SA_INIT request received' });
    deliver(deliver(deliver(answer, r1), r2), r1);
    expect([r1.tunnel.state, r2.tunnel.state]).toEqual(['established', 'established']);
    expect(r1.tunnel.reason).toBeUndefined();
  });

  it('an unknown peer: the responder answers NO_PROPOSAL_CHOSEN; both ends fail with ike-no-proposal', () => {
    const [r1, r2] = pair(KEY, null);
    const s1 = r1.start();
    const s2 = deliver(s1, r2);
    expect(s2.send).toEqual({ spiI: s1.send!.spiI, spiR: IKE_SPI_ZERO, exchange: IKE_SA_INIT, flags: IKE_FLAG_RESPONSE, messageId: 0, notify: IKE_NOTIFY_NO_PROPOSAL_CHOSEN });
    expect(s2.transition).toEqual({ from: 'idle', to: 'failed', cause: 'no keyring peer for the initiator address' });
    expect(s2.sa).toEqual({ op: 'down', reason: 'ike-no-proposal' });
    expect(s2.consumedCounter).toBeUndefined();
    const s3 = deliver(s2, r1);
    expect(s3.transition).toEqual({ from: 'init-sent', to: 'failed', cause: 'the responder chose no proposal' });
    expect(r1.tunnel.reason).toBe('ike-no-proposal');
    // The same request again (a retransmission) gets the same refusal.
    expect(r2.receive(s1.send!).send).toEqual(s2.send);
  });

  it('a proposal other than the fixed one is refused with NO_PROPOSAL_CHOSEN', () => {
    const [r1, r2] = pair();
    const s1 = r1.start();
    const s2 = r2.receive({ ...s1.send!, sa: 'enc=3des,integ=md5,prf=md5,dh=2' });
    expect(s2.send?.notify).toBe(IKE_NOTIFY_NO_PROPOSAL_CHOSEN);
    expect(s2.transition?.cause).toBe('proposal not supported');
  });

  it('without a keyring peer for its destination a tunnel fails at once, silently, and stays silent on retry', () => {
    const r1 = new End('r1', R1, R2, undefined);
    const s = r1.start();
    expect(s.send).toBeUndefined();
    expect(s.transition).toEqual({ from: 'idle', to: 'failed', cause: 'no keyring peer for the tunnel destination' });
    expect(s.sa).toEqual({ op: 'down', reason: 'ike-no-proposal' });
    const again = r1.start();
    expect(again).toEqual({ tunnel: r1.tunnel });
  });

  it('a silent peer: retransmissions after 1, 2 and 4 s, then ike-no-response after 8 s more', () => {
    const r1 = new End('r1', R1, R2, KEY);
    const s1 = r1.start();
    expect(IKE_REXMT_DELAYS_NS).toEqual([1 * SEC, 2 * SEC, 4 * SEC]);
    expect(IKE_NO_RESPONSE_WAIT_NS).toBe(8 * SEC);
    const waits: number[] = [s1.timer!.op === 'arm' ? s1.timer!.delayNs : -1];
    let sends = 1;
    for (;;) {
      const s = r1.timeout();
      if (s.send) {
        expect(s.send).toEqual(s1.send);
        sends++;
      }
      if (s.timer?.op === 'arm') waits.push(s.timer.delayNs);
      else break;
    }
    expect(sends).toBe(4);
    expect(waits).toEqual([1 * SEC, 2 * SEC, 4 * SEC, 8 * SEC]);
    const last = r1.log[r1.log.length - 1]!;
    expect(last.transition).toEqual({ from: 'init-sent', to: 'failed', cause: 'no response from the peer' });
    expect(last.sa).toEqual({ op: 'down', reason: 'ike-no-response' });
    expect(last.timer).toEqual({ op: 'cancel' });
    expect(r1.tunnel.reason).toBe('ike-no-response');
    // A timeout with nothing outstanding does nothing.
    expect(ikeTimeout(r1.tunnel)).toEqual({ tunnel: r1.tunnel });
  });

  it('an IKE_AUTH request left unanswered is retransmitted too, and a late answer still establishes', () => {
    const [r1, r2] = pair();
    const auth = deliver(deliver(r1.start(), r2), r1);
    const re = r1.timeout();
    expect(re.send).toEqual(auth.send);
    expect(re.timer).toEqual({ op: 'arm', delayNs: 2 * SEC });
    // R2 answers the first copy, then the retransmission again with the same response.
    const a1 = deliver(auth, r2);
    const a2 = deliver(re, r2);
    expect(a2.send).toEqual(a1.send);
    expect(a2.note).toBe('repeated IKE_AUTH request: response sent again');
    expect(deliver(a1, r1).transition?.to).toBe('established');
    expect(deliver(a2, r1).note).toBe('response to no outstanding request: discarded');
  });
});

describe('ike exchange: repeated requests, reloads and disconnects', () => {
  it('a repeated IKE_SA_INIT request is answered with the same response and no new counter', () => {
    const [r1, r2] = pair();
    const s1 = r1.start();
    const a1 = deliver(s1, r2);
    const a2 = r2.receive(s1.send!);
    expect(a2.send).toEqual(a1.send);
    expect(a2.consumedCounter).toBeUndefined();
    expect(r2.counter).toBe(1);
  });

  it('a new IKE_SA_INIT from a peer with an established SA replaces the SA (the peer reloaded)', () => {
    const [r1, r2] = pair();
    deliver(deliver(deliver(deliver(r1.start(), r2), r1), r2), r1);
    expect(r2.tunnel.state).toBe('established');
    // R1 reloads: a fresh state and counter, so the same first SPI; R2 treats it as a new exchange.
    const reloaded = new End('r1', R1, R2, KEY);
    const s1 = reloaded.start();
    const s2 = deliver(s1, r2);
    expect(s2.sa).toEqual({ op: 'down', reason: 'ike-negotiating' });
    expect(s2.transition).toEqual({ from: 'established', to: 'init-answered', cause: 'new exchange from the peer replaces the SA' });
    deliver(deliver(deliver(s2, reloaded), r2), reloaded);
    expect([reloaded.tunnel.state, r2.tunnel.state]).toEqual(['established', 'established']);
    expect(r2.tunnel.espSpiIn).toBe(espSpiOf('r2', 'Tunnel0', 1));
  });

  it('messages that match no exchange are discarded with a note and change nothing', () => {
    const [r1, r2] = pair();
    const s1 = r1.start();
    const stray: IkeMessage = { spiI: 'f'.repeat(16), spiR: '1'.repeat(16), exchange: IKE_AUTH, flags: IKE_FLAG_INITIATOR, messageId: 1, auth: '0'.repeat(32) };
    const d1 = r2.receive(stray);
    expect(d1.tunnel).toBe(IKE_IDLE);
    expect(d1.note).toBe('IKE_AUTH request for no exchange of this tunnel: discarded');
    const d2 = r1.receive({ ...s1.send!, flags: IKE_FLAG_RESPONSE, messageId: 5 });
    expect(d2.note).toBe('response to no outstanding request: discarded');
    expect(r1.tunnel.state).toBe('init-sent');
    expect(r2.receive({ ...s1.send!, exchange: 37 }).note).toBe('exchange type 37 not supported: discarded');
    expect(r2.receive({ ...s1.send!, spiR: '2'.repeat(16) }).note).toMatch(/discarded/);
  });

  it('only an idle or failed tunnel starts; a disconnect returns to idle and cancels the timer', () => {
    const [r1] = pair();
    r1.start();
    expect(ikeStart(r1.tunnel, r1.env())).toEqual({ tunnel: r1.tunnel });
    const stop = ikeStop(r1.tunnel);
    expect(stop).toEqual({ tunnel: IKE_IDLE, timer: { op: 'cancel' }, transition: { from: 'init-sent', to: 'idle', cause: 'tunnel disconnected' } });
    expect(ikeStop(IKE_IDLE)).toEqual({ tunnel: IKE_IDLE });
  });
});
