import { UNKNOWN_FIELD_ERROR } from '../orderForm/formValues.ts';

/** A field of the plan that shows its error next to it, in form order. */
export type PlanField = 'region' | 'orderIds' | 'date' | 'pickupFrom' | 'pickupBy' | 'personalText';

const PLAN_FIELDS: readonly PlanField[] = [
  'region',
  'orderIds',
  'date',
  'pickupFrom',
  'pickupBy',
  'personalText',
];

/** Errors to show on the plan: one plain-Hebrew message per field, plus one above the button. */
export interface PlanErrors {
  byField: Partial<Record<PlanField, string>>;
  /** A message about the whole plan: a failed send, a conflict, or an error no field shows. */
  other?: string;
}

export const NO_ERRORS: PlanErrors = { byField: {} };

/**
 * Maps `{ dottedPath: message }` (the shared check's `formFieldErrors`, or the api's 400) onto the
 * plan's fields. A path's first segment names the field, so `orderIds.3` (one id of the list)
 * lands on the list. A path no field shows, or no path at all, sets `other` to
 * {@link UNKNOWN_FIELD_ERROR}: a refused plan that shows nothing would leave Yoel stuck.
 */
export function planErrorsOf(fieldErrors: Record<string, string>): PlanErrors {
  const byField: Partial<Record<PlanField, string>> = {};
  let unplaced = false;
  for (const [path, message] of Object.entries(fieldErrors)) {
    const head = path.split('.')[0];
    const field = PLAN_FIELDS.find((candidate) => candidate === head);
    if (field === undefined) unplaced = true;
    else byField[field] ??= message;
  }
  if (Object.keys(byField).length === 0) unplaced = true;
  return unplaced ? { byField, other: UNKNOWN_FIELD_ERROR } : { byField };
}

/**
 * `errors` without these fields' messages (only these: the rest still hold). The same object when
 * none of them had one, so a state update with it changes nothing.
 */
export function withoutFieldErrors(errors: PlanErrors, fields: readonly PlanField[]): PlanErrors {
  if (fields.every((field) => errors.byField[field] === undefined)) return errors;
  const byField = { ...errors.byField };
  for (const field of fields) byField[field] = undefined;
  return { ...errors, byField };
}
