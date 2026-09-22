/**
 * Measured constants of the P2P medium for the P2 acceptance tests (ARCHITECTURE-P2 D23, §7 W1 media, §10.1
 * `accept.p2.loop-storm-bounded`). Plain data: no import, nothing read at module scope (§0 rule 12).
 *
 * `P2P_EVENTS_PER_FRAME`: scheduler events the P2P medium dispatches per delivered frame — one `txComplete` at the
 * end of serialization and one `frameArrival` at the receiver. `link.p2p.queue-cap.test.ts` measures it on a real
 * link model and scheduler (a burst, a paced stream and a multiplying loop) and fails if the measurement differs.
 * The storm test's line-rate event bound is `links × 2 × ⌈duration / slot⌉ × P2P_EVENTS_PER_FRAME × 1.1`.
 */
export const P2P_EVENTS_PER_FRAME = 2;
