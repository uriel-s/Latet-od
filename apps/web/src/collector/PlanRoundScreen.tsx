// "תכנון סבב" in the collector app (spec §3.5), at /app/orders/plan: Yoel picks a date and a half
// of the city; every order waiting in that region starts marked, and he unmarks the ones that stay
// out. An optional pickup time (pre-filled from the last round, ADR-0003) and an optional personal
// text go into every confirmation request. "שלח בקשות אישור" plans the round
// (POST /api/collector/rounds) and opens the "סבבים" tab, where the round's "שלח" list waits.
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  APP_TIME_ZONE,
  PERSONAL_TEXT_MAX_LENGTH,
  REGION_LABELS,
  formFieldErrors,
  planRoundRequestSchema,
  regionSchema,
  type CollectorOrder,
  type OrderGroup,
  type PlanRoundRequest,
  type Region,
} from '@bottlerun/shared';
import {
  NETWORK_ERROR_MESSAGE,
  fetchRounds,
  fetchWaitingOrders,
  planRound,
  type PlanRoundOutcome,
  type RoundsOutcome,
  type WaitingOrdersOutcome,
} from '../api.ts';
import { TextField } from '../components/TextField.tsx';
import { UNKNOWN_FIELD_ERROR } from '../orderForm/formValues.ts';
import { Link, navigate } from '../router.tsx';
import { FLASH_NOTICES, flashNoticeState } from './flashNotice.ts';
import { ORDERS_LIST_PATH } from './orderEditing.ts';
import { ORDERS_LOAD_FAILED_MESSAGE, bottlesText } from './OrdersScreen.tsx';
import { orderTags } from './orderTags.ts';

/** Where a planned round leads: the "סבבים" tab, with the round's "שלח" list (ADR-0003). */
const ROUNDS_PATH = '/app/rounds';

/** In place of the order list, for a region with no waiting orders. */
export const NO_REGION_ORDERS_TEXT = 'אין הזמנות שממתינות באזור הזה';

/**
 * Under "אזור" while some waiting order has no region: the screen plans by region, so such an
 * order is not offered here until Yoel gives it one in "עריכה" (spec §3.5, "בלי אזור").
 */
export const UNASSIGNED_ORDERS_HINT =
  'הזמנות בלי אזור לא מופיעות כאן. קודם בוחרים להן אזור בעריכה.';

/** Under "טקסט אישי": where the text goes (spec §3.5, ת11). */
export const PERSONAL_TEXT_HINT = 'נוסף לכל בקשות האישור של הסבב.';

/** Under the pickup time: where it goes (ADR-0003). */
export const PICKUP_BY_HINT = 'נכנסת לבקשות האישור.';

const SEND_LABEL = 'שלח בקשות אישור';
const SENDING_LABEL = 'שולח...';

/** A field of the plan that shows its error next to it, in form order. */
type PlanField = 'date' | 'region' | 'orderIds' | 'pickupFrom' | 'pickupBy' | 'personalText';

const PLAN_FIELDS: readonly PlanField[] = [
  'date',
  'region',
  'orderIds',
  'pickupFrom',
  'pickupBy',
  'personalText',
];

/** Errors to show on the plan: one plain-Hebrew message per field, plus one above the button. */
interface PlanErrors {
  byField: Partial<Record<PlanField, string>>;
  /** A message about the whole plan: a failed send, a conflict, or an error no field shows. */
  other?: string;
}

const NO_ERRORS: PlanErrors = { byField: {} };

/**
 * Maps `{ dottedPath: message }` (the shared check's `formFieldErrors`, or the api's 400) onto the
 * plan's fields. A path's first segment names the field, so `orderIds.3` (one id of the list)
 * lands on the list. A path no field shows, or no path at all, sets `other` to
 * {@link UNKNOWN_FIELD_ERROR}: a refused plan that shows nothing would leave Yoel stuck.
 */
function planErrorsOf(fieldErrors: Record<string, string>): PlanErrors {
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
 * The waiting orders of `region`, oldest first as the api listed them; none before a region is
 * chosen. Orders "בלי אזור" are never among them: the api would accept their ids, but a round is
 * planned per region, and Yoel first gives such an order its region in "עריכה".
 */
function ordersOfRegion(
  groups: readonly OrderGroup[],
  region: Region | undefined,
): CollectorOrder[] {
  if (region === undefined) return [];
  return groups.find((group) => group.key === region)?.orders ?? [];
}

/**
 * Today as `YYYY-MM-DD` in Israel's time zone (the 'en-CA' format is that shape): the earliest
 * date the round's picker offers. Not the phone's own zone, so a round is never planned for
 * yesterday by Israel's calendar.
 */
function todayInIsrael(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE }).format(new Date());
}

/** "מסומנות: 3 מתוך 4": how many of the region's orders go into the round. */
function checkedSummary(checkedCount: number, total: number): string {
  return `מסומנות: ${checkedCount} מתוך ${total}`;
}

/** The ids for `aria-describedby`, space-separated; undefined when there is none. */
function describedBy(...ids: (string | undefined)[]): string | undefined {
  const present = ids.filter((id) => id !== undefined);
  return present.length === 0 ? undefined : present.join(' ');
}

/** Props of {@link PlanRoundScreen}. Each loader must keep its identity across renders. */
export interface PlanRoundScreenProps {
  /** Loads the waiting orders. Defaults to {@link fetchWaitingOrders}; tests pass a fake. */
  loadOrders?: () => Promise<WaitingOrdersOutcome>;
  /**
   * Loads the open rounds, for `previousPickupBy` (ADR-0003). Defaults to {@link fetchRounds};
   * tests pass a fake.
   */
  loadRounds?: () => Promise<RoundsOutcome>;
  /** Plans the round. Defaults to {@link planRound}; tests pass a fake. */
  submitPlan?: (request: PlanRoundRequest) => Promise<PlanRoundOutcome>;
}

/** What the screen shows. A logged-out answer leaves for /login and needs no state of its own. */
type ScreenState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | {
      kind: 'loaded';
      groups: OrderGroup[];
      previousPickupBy: string | undefined;
      previousPickupFrom: string | undefined;
    };

/**
 * The planning screen. Renders the page's only `<h1>` (Layout's heading rule) and the way back to
 * the orders in every state. The waiting orders and the rounds load together, once per mount and
 * again on "לנסות שוב"; the form appears only once both are there, so the pickup time starts
 * from the last round's.
 */
export function PlanRoundScreen({
  loadOrders = fetchWaitingOrders,
  loadRounds = fetchRounds,
  submitPlan = planRound,
}: PlanRoundScreenProps) {
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  // Counts the "לנסות שוב" taps: a new value runs the load below again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // False once this load's answer no longer matters: Yoel left the screen, a retry started a
    // newer load, or React's StrictMode ran the effect a second time (dev only). A stale answer
    // changes nothing; above all, a late "logged out" must not pull him to the login from
    // another screen.
    let current = true;

    // Both at once: two cold requests in a row would double the wait. Neither loader rejects; a
    // rejection is a failed load like any other.
    const orders = loadOrders().catch((): WaitingOrdersOutcome => ({ kind: 'failed' }));
    const rounds = loadRounds().catch((): RoundsOutcome => ({ kind: 'failed' }));
    void Promise.all([orders, rounds]).then(([ordersOutcome, roundsOutcome]) => {
      if (!current) return;
      if (ordersOutcome.kind === 'loggedOut' || roundsOutcome.kind === 'loggedOut') {
        // Replace, not push: "back" from the login must not land on a screen that needs it.
        navigate('/login', { replace: true });
        return;
      }
      if (ordersOutcome.kind === 'failed' || roundsOutcome.kind === 'failed') {
        // The form needs both: without the rounds the pickup time would silently start empty.
        setState({ kind: 'failed' });
        return;
      }
      setState({
        kind: 'loaded',
        groups: ordersOutcome.groups,
        previousPickupBy: roundsOutcome.previousPickupBy,
        previousPickupFrom: roundsOutcome.previousPickupFrom,
      });
    });
    return () => {
      current = false;
    };
  }, [loadOrders, loadRounds, attempt]);

  function retry(): void {
    setState({ kind: 'loading' });
    setAttempt((previous) => previous + 1);
  }

  return (
    <>
      <h1>תכנון סבב</h1>
      <Link to={ORDERS_LIST_PATH} className="back-link">
        חזרה להזמנות
      </Link>

      {state.kind === 'loading' && <p role="status">טוען...</p>}

      {state.kind === 'failed' && (
        <>
          <p className="form-alert" role="alert">
            {ORDERS_LOAD_FAILED_MESSAGE}
          </p>
          <button type="button" className="button button-primary button-block" onClick={retry}>
            לנסות שוב
          </button>
        </>
      )}

      {state.kind === 'loaded' && (
        <PlanRoundForm
          initialGroups={state.groups}
          previousPickupBy={state.previousPickupBy}
          previousPickupFrom={state.previousPickupFrom}
          loadOrders={loadOrders}
          submitPlan={submitPlan}
        />
      )}
    </>
  );
}

/** Props of {@link PlanRoundForm}. */
interface PlanRoundFormProps {
  /** The waiting orders by region group, as loaded with the screen. */
  initialGroups: OrderGroup[];
  /** The last round's pickup time, `HH:MM`, which the field starts with (ADR-0003). */
  previousPickupBy: string | undefined;
  /** The last round's window start, `HH:MM`, which the "from" field starts with. */
  previousPickupFrom: string | undefined;
  /** Loads the orders again after a conflict (`ordersNotWaiting`). */
  loadOrders: () => Promise<WaitingOrdersOutcome>;
  submitPlan: (request: PlanRoundRequest) => Promise<PlanRoundOutcome>;
}

/**
 * The plan's form, top to bottom: the date, the region with its waiting-order counts, the region's
 * orders as checkboxes (all marked when the region is chosen, spec §3.5), the pickup time, the
 * personal text, and "שלח בקשות אישור". Every mistake shows next to its field, checked with the
 * shared `planRoundRequestSchema` (the api's own check) before anything is sent.
 */
function PlanRoundForm({
  initialGroups,
  previousPickupBy,
  previousPickupFrom,
  loadOrders,
  submitPlan,
}: PlanRoundFormProps) {
  // Replaced only after a conflict, by the list loaded again.
  const [groups, setGroups] = useState(initialGroups);
  const [date, setDate] = useState('');
  // undefined until Yoel picks one: no region is preselected, so he never plans the wrong half.
  const [region, setRegion] = useState<Region | undefined>(undefined);
  // The region as last chosen, for an answer that comes after he chose another one while the
  // request was on its way: the submit's own `region` is the one it sent.
  const latestRegionRef = useRef<Region | undefined>(undefined);
  // The marked ids. Choosing a region replaces the whole set with that region's orders, so ids of
  // another region never linger here; only the shown region's marked orders are sent anyway.
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pickupFrom, setPickupFrom] = useState(previousPickupFrom ?? '');
  const [pickupBy, setPickupBy] = useState(previousPickupBy ?? '');
  const [personalText, setPersonalText] = useState('');
  const [errors, setErrors] = useState<PlanErrors>(NO_ERRORS);
  const [sending, setSending] = useState(false);
  // The state above reaches the handler only after a re-render; this ref stops a second tap or
  // Enter that comes before it, so one plan does not send two rounds of requests.
  const busyRef = useRef(false);
  // False once the screen is gone: an answer that comes after Yoel left (the bottom navigation)
  // must not pull him to the rounds, or to the login, from the screen he went to.
  const mountedRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const regionGroupName = useId();
  const regionHintId = useId();
  const regionErrorId = useId();
  const ordersSummaryId = useId();
  const ordersErrorId = useId();
  const textId = useId();
  const textHintId = useId();
  const textErrorId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const regionOrders = ordersOfRegion(groups, region);
  const checkedCount = regionOrders.filter((order) => checkedIds.has(order.id)).length;
  const unassignedCount = groups.find((group) => group.key === 'none')?.orders.length ?? 0;
  const regionError = errors.byField.region;
  const ordersError = errors.byField.orderIds;
  const textError = errors.byField.personalText;

  /** Clears these fields' errors (only these: the rest still hold), as their value changes. */
  function clearErrors(...fields: PlanField[]): void {
    setErrors((previous) => {
      if (fields.every((field) => previous.byField[field] === undefined)) return previous;
      const byField = { ...previous.byField };
      for (const field of fields) byField[field] = undefined;
      return { ...previous, byField };
    });
  }

  /**
   * Shows `next`, then moves focus to the first field that has an error, in form order (as the
   * order forms do, useOrderForm.ts). Rendered first, so the field is focused together with its
   * message, and the focus call stays inside the tap's handler.
   */
  function showErrors(next: PlanErrors): void {
    flushSync(() => setErrors(next));
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }

  /** Marks every order of `orderGroups`' region `nextRegion`, except the ids in `leaveOut`. */
  function markAll(
    orderGroups: readonly OrderGroup[],
    nextRegion: Region | undefined,
    leaveOut: readonly string[] = [],
  ): void {
    setCheckedIds(
      new Set(
        ordersOfRegion(orderGroups, nextRegion)
          .map((order) => order.id)
          .filter((id) => !leaveOut.includes(id)),
      ),
    );
  }

  function chooseRegion(nextRegion: Region): void {
    latestRegionRef.current = nextRegion;
    setRegion(nextRegion);
    // Spec §3.5: every order waiting in the region starts marked, also when Yoel comes back to a
    // region he unmarked some in: a new choice starts over.
    markAll(groups, nextRegion);
    clearErrors('region', 'orderIds');
  }

  function toggleOrder(orderId: string, checked: boolean): void {
    setCheckedIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(orderId);
      else next.delete(orderId);
      return next;
    });
    clearErrors('orderIds');
  }

  /** Loads the list again; a rejection is a failed load. */
  async function reloadOrders(): Promise<WaitingOrdersOutcome> {
    try {
      return await loadOrders();
    } catch {
      return { kind: 'failed' };
    }
  }

  async function submit(): Promise<void> {
    if (busyRef.current) return;
    // In list order (oldest first, as the api listed them), whatever order he tapped in.
    const orderIds = regionOrders.filter((order) => checkedIds.has(order.id)).map(({ id }) => id);
    const parsed = planRoundRequestSchema.safeParse({
      date,
      region,
      orderIds,
      pickupFrom,
      pickupBy,
      personalText,
    });
    if (!parsed.success) {
      const next = planErrorsOf(formFieldErrors(parsed.error));
      // With no region there is no list on the screen yet: "choose a region" is the one thing to
      // do, and "mark an order" would point at a list he cannot see.
      if (region === undefined) next.byField.orderIds = undefined;
      showErrors(next);
      return;
    }

    busyRef.current = true;
    setSending(true);
    setErrors(NO_ERRORS);
    let outcome: PlanRoundOutcome;
    try {
      // The schema's output: the personal text trimmed, an empty time or text left out.
      outcome = await submitPlan(parsed.data);
    } catch {
      // planRound never rejects, but a rejection must not leave the button on "שולח...".
      outcome = { kind: 'failed' };
    }
    // A conflict means the list was out of date: it loads again before the button is free, so
    // the next tap sends from the fresh list.
    const reload = outcome.kind === 'ordersNotWaiting' ? await reloadOrders() : undefined;
    busyRef.current = false;
    if (!mountedRef.current) return;
    setSending(false);

    switch (outcome.kind) {
      case 'planned':
        // Replace, not push: "back" from the rounds returns to the orders, not to this form,
        // whose orders are no longer waiting (a second send would only be refused).
        // `?round=` names the new round: the rounds tab shows one round at a time, the nearest
        // open one by default, so without it an earlier open round would hide the "שלח" list of
        // the round Yoel just planned.
        navigate(`${ROUNDS_PATH}?round=${encodeURIComponent(outcome.view.round.id)}`, {
          replace: true,
          state: flashNoticeState(FLASH_NOTICES.roundPlanned),
        });
        return;
      case 'loggedOut':
        navigate('/login', { replace: true });
        return;
      case 'invalid':
        // Normally caught by the same check above; an unknown key goes above the button.
        showErrors(planErrorsOf(outcome.fieldErrors));
        return;
      case 'ordersNotWaiting': {
        if (reload?.kind === 'loggedOut') {
          navigate('/login', { replace: true });
          return;
        }
        // The date, region, time and text stay as typed. The region's current orders are all
        // marked again, except the ones the api named (normally gone from the fresh list). If the
        // list could not load again, the old one stays with those unmarked, so the next tap can
        // still go through.
        const nextGroups = reload?.kind === 'loaded' ? reload.groups : groups;
        setGroups(nextGroups);
        markAll(nextGroups, latestRegionRef.current, outcome.orderIds);
        setErrors({ byField: {}, other: outcome.message });
        return;
      }
      case 'failed':
        // Nothing is retried: the plan may have arrived. Sending again then answers
        // `ordersNotWaiting`, and the round is in the "סבבים" tab.
        setErrors({ byField: {}, other: NETWORK_ERROR_MESSAGE });
        return;
    }
  }

  return (
    // noValidate: the form shows its own Hebrew messages next to each field, not the browser's
    // bubbles.
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextField
        label="תאריך הסבב"
        type="date"
        min={todayInIsrael()}
        value={date}
        onChange={(nextDate) => {
          setDate(nextDate);
          clearErrors('date');
        }}
        error={errors.byField.date}
        autoComplete="off"
      />

      <fieldset
        className="field"
        aria-describedby={describedBy(
          unassignedCount > 0 ? regionHintId : undefined,
          regionError ? regionErrorId : undefined,
        )}
      >
        <legend className="field-label">אזור</legend>
        {unassignedCount > 0 && (
          <p id={regionHintId} className="field-hint">
            {UNASSIGNED_ORDERS_HINT}
          </p>
        )}
        <div className="choice-list">
          {regionSchema.options.map((option) => (
            <label key={option} className="choice">
              <input
                type="radio"
                name={regionGroupName}
                value={option}
                checked={region === option}
                onChange={() => chooseRegion(option)}
                aria-invalid={regionError ? true : undefined}
              />
              {/* The number of orders waiting there, so an empty half is seen before it is
                  chosen. */}
              {`${REGION_LABELS[option]} (${ordersOfRegion(groups, option).length})`}
            </label>
          ))}
        </div>
        {regionError && (
          <p id={regionErrorId} className="field-error">
            {regionError}
          </p>
        )}
      </fieldset>

      {region !== undefined && (
        <fieldset
          className="field"
          aria-describedby={describedBy(
            regionOrders.length > 0 ? ordersSummaryId : undefined,
            ordersError ? ordersErrorId : undefined,
          )}
        >
          <legend className="field-label">הזמנות לסבב</legend>
          {regionOrders.length === 0 ? (
            <p className="field-hint">{NO_REGION_ORDERS_TEXT}</p>
          ) : (
            <>
              <p id={ordersSummaryId} className="field-hint">
                {checkedSummary(checkedCount, regionOrders.length)}
              </p>
              <div className="choice-list">
                {regionOrders.map((order) => (
                  <PlanOrderRow
                    key={order.id}
                    order={order}
                    checked={checkedIds.has(order.id)}
                    invalid={Boolean(ordersError)}
                    onToggle={toggleOrder}
                  />
                ))}
              </div>
            </>
          )}
          {ordersError && (
            <p id={ordersErrorId} className="field-error">
              {ordersError}
            </p>
          )}
        </fieldset>
      )}

      <TextField
        label="מאיזו שעה להוציא את הבקבוקים (לא חובה)"
        type="time"
        value={pickupFrom}
        onChange={(nextTime) => {
          setPickupFrom(nextTime);
          clearErrors('pickupFrom', 'pickupBy');
        }}
        error={errors.byField.pickupFrom}
        autoComplete="off"
      />

      <TextField
        label="עד איזו שעה להוציא את הבקבוקים (לא חובה)"
        type="time"
        value={pickupBy}
        onChange={(nextTime) => {
          setPickupBy(nextTime);
          clearErrors('pickupBy');
        }}
        error={errors.byField.pickupBy}
        hint={PICKUP_BY_HINT}
        autoComplete="off"
      />

      {/* A textarea, which TextField does not render: the same .field parts and wiring by hand. */}
      <div className="field">
        <label htmlFor={textId} className="field-label">
          טקסט אישי (לא חובה)
        </label>
        <p id={textHintId} className="field-hint">
          {PERSONAL_TEXT_HINT}
        </p>
        <textarea
          id={textId}
          value={personalText}
          onChange={(event) => {
            setPersonalText(event.target.value);
            clearErrors('personalText');
          }}
          maxLength={PERSONAL_TEXT_MAX_LENGTH}
          aria-invalid={textError ? true : undefined}
          aria-describedby={describedBy(textHintId, textError ? textErrorId : undefined)}
        />
        {textError && (
          <p id={textErrorId} className="field-error">
            {textError}
          </p>
        )}
      </div>

      {errors.other && (
        <p className="form-alert" role="alert">
          {errors.other}
        </p>
      )}

      {/* aria-disabled, not disabled, while sending: the button keeps focus and is announced as
          unavailable; busyRef ignores the extra taps. */}
      <button
        type="submit"
        className="button button-primary button-block"
        aria-disabled={sending ? true : undefined}
      >
        {sending ? SENDING_LABEL : SEND_LABEL}
      </button>
    </form>
  );
}

/** Props of {@link PlanOrderRow}. */
interface PlanOrderRowProps {
  order: CollectorOrder;
  checked: boolean;
  /** True while the list has an error ("נא לסמן לפחות הזמנה אחת", too many). */
  invalid: boolean;
  onToggle: (orderId: string, checked: boolean) => void;
}

/**
 * One waiting order of the region as a checkbox row: who, where, how many bottles, and its tags
 * (orderTags.ts: why it came back from a round, "בלי מיקום"). The whole row is the tap target.
 * The checkbox is named by the customer's name alone and described by the rest, so a screen
 * reader says the name first and the details after.
 */
function PlanOrderRow({ order, checked, invalid, onToggle }: PlanOrderRowProps) {
  const nameId = useId();
  const detailsId = useId();
  const tags = orderTags(order);

  return (
    <label className="choice plan-order">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(order.id, event.target.checked)}
        aria-labelledby={nameId}
        aria-describedby={detailsId}
        aria-invalid={invalid ? true : undefined}
      />
      <span className="plan-order-details">
        <span id={nameId} className="plan-order-name">
          {order.contact.name}
        </span>
        <span id={detailsId} className="plan-order-more">
          <span>
            {order.address.streetName} {order.address.houseNumber}
          </span>
          <span>{bottlesText(order.bottlesEstimated)}</span>
          {tags.length > 0 && (
            <span className="tag-list">
              {tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </span>
          )}
        </span>
      </span>
    </label>
  );
}
