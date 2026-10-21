// Pure logic of the rounds tab's round picker (the button + bottom sheet that chooses ONE open
// round to show): region filter, which round is selected, and the Hebrew words of a row.
// No React here, so the rules are tested without rendering the sheet.
import {
  REGION_LABELS,
  ROUND_GROUP_LABELS,
  formatDayMonth,
  regionSchema,
  type Region,
  type RoundPhase,
  type RoundView,
} from '@bottlerun/shared';

/** What the sheet's chips can select: one region, or every round. */
export type RegionFilter = Region | 'all';

/** Short Hebrew name of the step a round is in (spec §3.6: step 1 "אישורים", step 2 "מסלול"). */
export const ROUND_PHASE_LABELS: Readonly<Record<RoundPhase, string>> = {
  confirming: 'אישורים',
  routed: 'מסלול',
};

/** The rounds of one region, or all of them for `'all'`. Keeps the api's order. */
export function filterRoundsByRegion(
  rounds: readonly RoundView[],
  filter: RegionFilter,
): RoundView[] {
  if (filter === 'all') return [...rounds];
  return rounds.filter((view) => view.round.region === filter);
}

/**
 * The round to show: the one with `requestedId` (the `?round=` of the URL), else the first of
 * `rounds`. The fallback covers no id, an id of a round that was closed meanwhile, and a garbage
 * id, so a stale link still lands on something useful. `rounds` is NOT sorted here: the api lists
 * open rounds by date, then by creation, so the first is the nearest one and that order is the
 * truth. `undefined` when there is no open round.
 */
export function pickSelectedRound(
  rounds: readonly RoundView[],
  requestedId: string | undefined,
): RoundView | undefined {
  const requested = rounds.find((view) => view.round.id === requestedId);
  return requested ?? rounds[0];
}

/**
 * The regions that have at least one of `rounds`, in the fixed region order (ramat, old), so the
 * sheet can hide a chip that would show an empty list.
 */
export function regionsPresent(rounds: readonly RoundView[]): Region[] {
  return regionSchema.options.filter((region) =>
    rounds.some((view) => view.round.region === region),
  );
}

/** The three parts of a picker row; the UI wraps `date` in `<bdi dir="ltr">`. */
export type RoundPickerParts = {
  /** "DD/MM". */
  date: string;
  /** "רמת בית שמש" or "בית שמש". */
  region: string;
  /** Numbers only: "אישרו 3 מתוך 5" while confirming, "7 עצירות" once routed. */
  summary: string;
};

/**
 * The words of one round's row. While confirming, the number that matters is how many customers
 * confirmed out of all of the round's orders (all three groups); once routed it is the count of
 * stops in the route.
 */
export function roundPickerParts(view: RoundView): RoundPickerParts {
  const { round, groups, stops } = view;
  let summary: string;
  if (round.phase === 'routed') {
    summary = `${stops.length} עצירות`;
  } else {
    const total = groups.reduce((sum, group) => sum + group.orders.length, 0);
    const confirmed = groups.find((group) => group.key === 'confirmed')?.orders.length ?? 0;
    summary = `${ROUND_GROUP_LABELS.confirmed} ${confirmed} מתוך ${total}`;
  }
  return { date: formatDayMonth(round.date), region: REGION_LABELS[round.region], summary };
}

/** One-line label of a round, e.g. "28/10 · רמת בית שמש · 7 עצירות" (plain text). */
export function roundPickerLabel(view: RoundView): string {
  const { date, region, summary } = roundPickerParts(view);
  return `${date} · ${region} · ${summary}`;
}

/** Short tag of the round's step: "אישורים" or "מסלול". */
export function roundPhaseLabel(view: RoundView): string {
  return ROUND_PHASE_LABELS[view.round.phase];
}
