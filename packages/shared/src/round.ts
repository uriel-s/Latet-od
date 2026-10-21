// Rounds (spec §3.5, §3.6, §4 "מצבי סבב", §5 `rounds`): a planned collection trip, a date and a
// half of the city. Like orderSchema, roundSchema checks structure only, so a stored round stays
// readable; the rules for planning one (at most 25 orders, all waiting) live in roundsApi.ts and
// the api.
import { z } from 'zod';
import { pickupTimeSchema } from './messages.ts';
import { timestampSchema } from './order.ts';
import { regionSchema } from './streets.ts';

/**
 * Most orders one round may have (spec §1: a round of more than 25 stops is out of the MVP). The
 * planning request is refused above it; the stored shape does not repeat the cap.
 */
export const MAX_ROUND_ORDERS = 25;

// ---------------------------------------------------------------------------------------------
// Status and phase
// ---------------------------------------------------------------------------------------------

/**
 * A round's status (spec §4, "מצבי סבב"): `open` from planning until Yoel taps "סגור סבב", then
 * `closed`. An order is in at most one open round.
 */
export const ROUND_STATUSES = ['open', 'closed'] as const;
export const roundStatusSchema = z.enum(ROUND_STATUSES);
export type RoundStatus = z.infer<typeof roundStatusSchema>;

/**
 * Where an open round is (spec §3.6):
 * - `confirming`: the confirmation requests went out, and the customers are confirming (step 1).
 * - `routed`: Yoel tapped "סגור אישורים ובנה מסלול"; whoever did not confirm left the round and
 *   the route is built and stored (step 2).
 * "סגור סבב" does not change the phase: a closed round keeps the one it was closed in, which
 * records whether its route was ever built (and why its orders left: `notConfirmed` or
 * `notReached`).
 */
export const ROUND_PHASES = ['confirming', 'routed'] as const;
export const roundPhaseSchema = z.enum(ROUND_PHASES);
export type RoundPhase = z.infer<typeof roundPhaseSchema>;

// ---------------------------------------------------------------------------------------------
// Stored round
// ---------------------------------------------------------------------------------------------

/**
 * One stop of the stored route, in driving order. The route is computed once by `planRoute` and
 * stored, so the order of the stops does not change in the middle of the drive (spec §3.6).
 *
 * A stop has no status of its own: whether it was collected, not found, and so on is derived from
 * its order's status (and `lastMiss`). Yoel moving a stop up or down just reorders `stops`.
 */
export const roundStopSchema = z.object({
  orderId: z.string().min(1),
  /**
   * Whether the order had a map point when the route was built. Stops without one were put at
   * the end by `planRoute` (ADR-0005), and the card shows the "בלי מיקום" tag. Stored, not
   * re-derived from the order: if Yoel picks a near street later, the stop stays where the route
   * put it, and the tag still explains why it is there. Required, which is safe: no stored round
   * has stops yet (they stay empty until the route is built).
   */
  hasLocation: z.boolean(),
});
export type RoundStop = z.infer<typeof roundStopSchema>;

/**
 * A round as the api reads it from Mongo (spec §5 `rounds`, with ADR-0003's `pickupBy`). Unknown
 * keys are stripped, so Mongo's `_id` does not leak: the repo maps it to the hex `id`.
 */
export const roundSchema = z.object({
  id: z.string().min(1),
  /** The round's calendar day in Israel, `YYYY-MM-DD` (formatted as DD/MM by `formatDayMonth`). */
  date: z.iso.date(),
  /** Half of the city: a round is planned per region (spec §3.5, "תכנון סבב"). */
  region: regionSchema,
  status: roundStatusSchema,
  phase: roundPhaseSchema,
  /** Yoel's own words for the confirmation request (spec §3.5, ת11); absent when he wrote none. */
  personalText: z.string().min(1).optional(),
  /**
   * "עד איזו שעה להוציא את הבקבוקים" (ADR-0003), `HH:MM`. The next planning screen pre-fills it
   * from the last round's.
   */
  pickupBy: pickupTimeSchema.optional(),
  /**
   * Every order put into the round, in plan order. It never shrinks when an order leaves the
   * round (its `roundId` goes, `lastMiss.roundId` points here), so the round's view still finds
   * who asked for another date.
   */
  orderIds: z.array(z.string().min(1)),
  /**
   * The stored route, in driving order: home → these stops → drop-off (the two ends are not
   * stored here). Empty until the route is built (phase `routed`).
   */
  stops: z.array(roundStopSchema),
  createdAt: timestampSchema,
  /**
   * Set when Yoel taps "סגור סבב" (POST /api/collector/rounds/:id/close), once: closing a round
   * already closed keeps its first `closedAt`.
   */
  closedAt: timestampSchema.optional(),
});
export type Round = z.infer<typeof roundSchema>;

/** A round before it is stored: what a repository's `create()` takes. The repo assigns `id`. */
export type NewRound = Omit<Round, 'id'>;
