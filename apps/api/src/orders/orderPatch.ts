// Turns Yoel's PATCH /api/collector/orders/:id (spec §3.5: "עריכה", "שינוי אזור", and picking a
// near street, ADR-0005) into the OrderPatch the repo applies. Pure, so the region rules of
// `updateOrderRequestSchema` (packages/shared/src/collectorOrdersApi.ts) are tested here without
// a route or a database; collectorOrdersRoutes.ts calls it and hands the patch to OrdersRepo.update.
import {
  orderSchema,
  regionForAddress,
  type Address,
  type Order,
  type Region,
  type UpdateOrder,
} from '@bottlerun/shared';
import type { OrderPatch } from './ordersRepo.ts';

/** What {@link buildOrderPatch} returns. */
export interface BuiltOrderPatch {
  /** Only the fields the request changes, plus what they imply (region) and `updatedAt`. */
  patch: OrderPatch;
  /** The stored order with `patch` applied the way the repo applies it, already validated. */
  updated: Order;
}

/**
 * The change a validated PATCH makes to `stored`, following the rules documented on
 * `updateOrderRequestSchema`:
 * - `contact`: name and phone from the request; `method` stays the stored one (the request has
 *   none, and the MVP has only WhatsApp).
 * - `bottlesEstimated`: replaced.
 * - `address`: the request's address replaces the stored one, but `nearStreetCode` (which the
 *   form's address never carries) is kept unless the request has `nearStreetCode` too: a number
 *   sets it, `null` removes it.
 * - `region`: an explicit `region` in the request wins. Otherwise it is derived again
 *   (`regionForAddress`) only when the street code or the near street code changed; a derived
 *   region replaces the stored one, and when the new streets give none the stored one is kept, so
 *   a region Yoel set by hand survives a fix of the house number or of a free-text street name.
 * - `updatedAt`: `now`, always.
 *
 * The patch holds only those keys (`address` when the address or the near street was in the
 * request, `region` only when its value changes), and never a key set to `undefined`: every
 * patched field is replaced, none is removed (there is no way back to "בלי אזור").
 *
 * @throws Error when the patched order does not match `orderSchema`. That is a bug, not a bad
 *   request: the request was validated before. The message holds no customer data.
 */
export function buildOrderPatch(stored: Order, request: UpdateOrder, now: Date): BuiltOrderPatch {
  const patch: OrderPatch = {};

  if (request.contact !== undefined) {
    patch.contact = {
      name: request.contact.name,
      phone: request.contact.phone,
      method: stored.contact.method,
    };
  }

  if (request.bottlesEstimated !== undefined) {
    patch.bottlesEstimated = request.bottlesEstimated;
  }

  // `nearStreetCode: null` counts as "in the request" (it removes the near street); only an absent
  // key leaves the address alone.
  const addressInRequest = request.address !== undefined || request.nearStreetCode !== undefined;
  const address = addressInRequest ? nextAddress(stored.address, request) : stored.address;
  if (addressInRequest) patch.address = address;

  const region = nextRegion(stored, address, request.region);
  // `region` is undefined only when the stored order has none either, so nothing is ever unset.
  if (region !== undefined && region !== stored.region) patch.region = region;

  // A copy, so a later change to the caller's `now` moves nothing stored.
  patch.updatedAt = new Date(now);

  const updated = applyPatch(stored, patch);
  // OrdersRepo.update stores what it is given without validating it, and the in-memory fake never
  // validates, so a wrong patch (a bug here) would reach Mongo and break every later read of the
  // order. The request itself was already validated: a failure here is the api's own bug, so it
  // is a 500, and its message names no field value (errors reach the logs; CLAUDE.md, privacy).
  if (!orderSchema.safeParse(updated).success) {
    throw new Error('buildOrderPatch: the patched order does not match orderSchema');
  }
  return { patch, updated };
}

/**
 * The address after the request: the request's address if it has one, else the stored one, with
 * the near street from the request when it has the key (`null` removes it), else the stored one.
 * Built without keys set to `undefined` (the Mongo driver would store them as null).
 */
function nextAddress(stored: Address, request: UpdateOrder): Address {
  const { nearStreetCode: storedNearStreetCode, ...storedWithoutNear } = stored;
  // The form's address has no `nearStreetCode`: picking a near street is Yoel's alone.
  const address: Address = { ...(request.address ?? storedWithoutNear) };

  const nearStreetCode =
    request.nearStreetCode === undefined
      ? storedNearStreetCode
      : (request.nearStreetCode ?? undefined);
  if (nearStreetCode !== undefined) address.nearStreetCode = nearStreetCode;
  return address;
}

/**
 * The region after the request (see {@link buildOrderPatch}): Yoel's explicit choice, else the
 * region derived from the new streets when they changed, else the stored one.
 */
function nextRegion(
  stored: Order,
  address: Address,
  explicitRegion: Region | undefined,
): Region | undefined {
  if (explicitRegion !== undefined) return explicitRegion;
  const streetsChanged =
    address.streetCode !== stored.address.streetCode ||
    address.nearStreetCode !== stored.address.nearStreetCode;
  if (!streetsChanged) return stored.region;
  return regionForAddress(address) ?? stored.region;
}

/**
 * `stored` with `patch` applied like OrdersRepo.update applies it (Mongo `$set` / `$unset`): each
 * key replaces the field as a whole, and a key set to `undefined` removes the field. Pure (a new
 * object; `stored` is not touched). The patch builders (this file's and the customer's,
 * customerOrderPatch.ts) check the result with `orderSchema` before anything is written.
 */
export function applyPatch(stored: Order, patch: OrderPatch): Order {
  const next: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as Order;
}
