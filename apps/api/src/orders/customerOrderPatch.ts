// Turns the customer's "שינוי" on their own page (PATCH /api/o/:token, spec §3.3: "אפשר לשנות
// כתובת, כמות והערה. לא את הטלפון.") into the OrderPatch the repo applies. Pure, so the rules
// (the near street and the region of a new street, ADR-0005; an address change taking the order
// out of its round) are tested here without a route or a database. customerOrderRoutes.ts calls
// it and writes the patch conditionally on the status it was built on. Yoel's own edit is
// orderPatch.ts, with different region rules (see below).
import {
  canTransition,
  isLocationChange,
  orderSchema,
  regionForAddress,
  type Address,
  type AddressPlace,
  type CustomerUpdateOrder,
  type Order,
  type Round,
} from '@bottlerun/shared';
import { leaveRoundPatch } from '../rounds/leaveRound.ts';
import { applyPatch } from './orderPatch.ts';
import type { OrderPatch } from './ordersRepo.ts';

/** What {@link buildCustomerOrderPatch} returns. */
export interface BuiltCustomerOrderPatch {
  /** Only the fields the change touches, plus what they imply, and `updatedAt`. */
  patch: OrderPatch;
  /**
   * True when the change moved the pickup to another place while the order was in a round, so
   * the patch also takes it out of the round (back to `waiting`, `lastMiss` `addressChanged`).
   */
  leftRound: boolean;
}

/**
 * The change the customer's validated PATCH (`customerUpdateOrderRequestSchema`) makes to
 * `stored`, which is in `round` (the round found by `stored.roundId`, or null), at `now`:
 *
 * - `bottlesEstimated`: replaced when present.
 * - `address` (when present): replaces the stored address as a whole. `nearStreetCode`, Yoel's
 *   "רחוב קרוב" (ADR-0005), never comes from the customer: it is KEPT when the street is
 *   unchanged (same `streetCode` and same `streetName`), and DROPPED when the customer changes
 *   the street, since a near street Yoel picked for the old street would give the new address a
 *   wrong region and map point.
 * - `region`: when the street changed, derived again from the new address (`regionForAddress`).
 *   A free-text street (or a listed one with no region) gives none, and then the stored region is
 *   REMOVED (`region: undefined` = Mongo `$unset`), so the order lands in "בלי אזור" for Yoel to
 *   assign. Unlike Yoel's own edit (orderPatch.ts), which keeps the stored region, because a region
 *   kept from the customer's old street would be wrong, and only Yoel knows the right one. In the
 *   patch only when its value changes; untouched when the street is unchanged (a new house number
 *   on the same street is in the same region, so a region Yoel set by hand survives it).
 * - Leaving the round (spec §3.3: "שינוי כתובת אחרי שההזמנה נכנסה לסבב מוציא אותה מהסבב"): when
 *   the street or the house number changed (`isLocationChange`), the order is in a round
 *   (`roundId`), and it may go back to `waiting` (`pending` or `confirmed`), the patch also has
 *   {@link leaveRoundPatch} with reason `addressChanged`: status `waiting`, `roundId` removed,
 *   `lastMiss` with the round's date (only when `round` is the order's round). The round was
 *   planned, and its route will be built, for the old place. A change of `bottlesSpot`,
 *   `floorApt`, the note or the bottles alone never leaves the round. A `waiting` order is in no
 *   round, so it never gets a `lastMiss` here.
 * - `updatedAt`: a copy of `now`, always.
 *
 * Never in the patch: `contact` (the phone keeps one open order per phone, spec §3.1), `messages`
 * (sendAndLog rewrites the log as a whole; a patch that carried it could undo a message logged
 * meanwhile), `token`, `source`, and `status` other than leaving the round. The caller refuses a
 * closed order (collected, cancelled) before calling this.
 *
 * @throws Error when the patched order does not match `orderSchema`. That is a bug, not a bad
 *   request: the request was validated before. The message holds no customer data.
 */
export function buildCustomerOrderPatch(
  stored: Order,
  request: CustomerUpdateOrder,
  round: Round | null,
  now: Date,
): BuiltCustomerOrderPatch {
  let patch: OrderPatch = {};
  let leftRound = false;

  if (request.bottlesEstimated !== undefined) {
    patch.bottlesEstimated = request.bottlesEstimated;
  }

  if (request.address !== undefined) {
    const streetChanged = isStreetChange(stored.address, request.address);
    const address: Address = { ...request.address };
    // Built without a key set to `undefined`: the Mongo driver would store it as null.
    if (!streetChanged && stored.address.nearStreetCode !== undefined) {
      address.nearStreetCode = stored.address.nearStreetCode;
    }
    patch.address = address;

    if (streetChanged) {
      // The new address has no near street (dropped above), so this is the new street's region.
      const region = regionForAddress(address);
      // `undefined` here removes the stored region: the order goes to "בלי אזור".
      if (region !== stored.region) patch.region = region;
    }

    const leavesRound =
      isLocationChange(stored.address, address) &&
      stored.roundId !== undefined &&
      canTransition(stored.status, 'waiting');
    if (leavesRound) {
      patch = { ...patch, ...leaveRoundPatch(stored, round, 'addressChanged', now) };
      leftRound = true;
    }
  }

  // A copy, so a later change to the caller's `now` moves nothing stored.
  patch.updatedAt = new Date(now);

  // OrdersRepo.update stores what it is given without validating it, so a wrong patch (a bug
  // here) would reach Mongo and break every later read of the order. A 500, and the message
  // names no field value (errors reach the logs; CLAUDE.md, privacy).
  if (!orderSchema.safeParse(applyPatch(stored, patch)).success) {
    throw new Error('buildCustomerOrderPatch: the patched order does not match orderSchema');
  }
  return { patch, leftRound };
}

/**
 * Whether the street itself changed: its code or its name. For a listed street the name is the
 * official one (the request's schema sets it), so only a change of street differs; for a
 * free-text street the name is all there is. The house number is not the street: a new number
 * on the same street keeps the near street and the region.
 */
function isStreetChange(before: AddressPlace, after: AddressPlace): boolean {
  return before.streetCode !== after.streetCode || before.streetName !== after.streetName;
}
