// "תכנון סבב" in the collector app (spec §3.5), at /app/orders/plan: Yoel picks a date and a half
// of the city; every order waiting in that region starts marked, and he unmarks the ones that stay
// out. Optional pickup times (pre-filled from the last round, ADR-0003, ADR-0012) and an optional
// personal text go into every message; the message announces the pickup, nobody confirms
// (ADR-0012). "שלח הודעות" plans the round
// (POST /api/collector/rounds) and opens the "סבבים" tab, where the round's "שלח" list waits.
import { LoadFailed } from '../components/LoadFailed.tsx';
import { Skeleton } from '../components/Skeleton.tsx';
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  APP_TIME_ZONE,
  PERSONAL_TEXT_MAX_LENGTH,
  formFieldErrors,
  planRoundRequestSchema,
  type OrderGroup,
  type Region,
} from '@bottlerun/shared';
import { NETWORK_ERROR_MESSAGE } from '../api/request.ts';
import { useApi } from '../api/ApiContext.tsx';
import type { WaitingOrdersOutcome } from '../api/collectorOrdersApi.ts';
import type { PlanRoundOutcome, RoundsOutcome } from '../api/roundsApi.ts';
import { TextField } from '../components/TextField.tsx';
import { describedBy } from '../components/describedBy.ts';
import { FormCard } from '../orderForm/OrderFields.tsx';
import { navigate } from '../router.tsx';
import { useMountedRef } from '../useMountedRef.ts';
import { BackToOrdersLink } from './BackToOrdersLink.tsx';
import { FLASH_NOTICES, flashNoticeState } from './flashNotice.ts';
import { ORDERS_LOAD_FAILED_MESSAGE } from './OrdersScreen.tsx';
import { PlanOrdersField, ordersOfRegion } from './PlanOrdersField.tsx';
import {
  NO_ERRORS,
  planErrorsOf,
  withoutFieldErrors,
  type PlanErrors,
  type PlanField,
} from './planErrors.ts';

/** Where a planned round leads: the "סבבים" tab, with the round's "שלח" list (ADR-0003). */
const ROUNDS_PATH = '/app/rounds';

/** Under "טקסט אישי": where the text goes (spec §3.5, ת11). */
export const PERSONAL_TEXT_HINT = 'נוסף לכל ההודעות של הסבב.';

/**
 * Under the window's start: the start is also the time the bottles must be out by (ADR-0012), so
 * nobody puts them out after Yoel has started coming.
 */
export const PICKUP_FROM_HINT = 'הלקוחות יתבקשו להוציא את הבקבוקים עד השעה הזאת.';

/** Under the window's end: what the message says, and what it says when it is the only time. */
export const PICKUP_BY_HINT =
  'בהודעה: "נגיע בין השעות". בלי שעת התחלה, יתבקשו להוציא את הבקבוקים עד השעה הזאת.';

/** The labels of the two time fields (ADR-0012: the window is when Yoel comes). */
export const PICKUP_FROM_LABEL = 'מאיזו שעה מגיעים (לא חובה)';
export const PICKUP_BY_LABEL = 'עד איזו שעה מגיעים (לא חובה)';

// The form's three cards, top to bottom.
const WHERE_CARD_TITLE = 'איפה';
const WHEN_CARD_TITLE = 'מתי';
const MESSAGE_CARD_TITLE = 'הודעה';

const SEND_LABEL = 'שלח הודעות';
const SENDING_LABEL = 'שולח...';

/**
 * Today as `YYYY-MM-DD` in Israel's time zone (the 'en-CA' format is that shape): the earliest
 * date the round's picker offers. Not the phone's own zone, so a round is never planned for
 * yesterday by Israel's calendar.
 */
function todayInIsrael(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE }).format(new Date());
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
 *
 * Both loads are of {@link useApi}: `fetchWaitingOrders` (GET /api/collector/orders) and
 * `fetchRounds` (GET /api/collector/rounds, for the last round's pickup times, ADR-0003). The form
 * takes its own requests from the client too.
 */
export function PlanRoundScreen() {
  // The client keeps its functions' identity, so listing them as effect dependencies does not run
  // the load again.
  const { fetchWaitingOrders: loadOrders, fetchRounds: loadRounds } = useApi();
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
      <BackToOrdersLink />
      <h1>תכנון סבב</h1>

      {state.kind === 'loading' && <Skeleton />}

      {state.kind === 'failed' && (
        <LoadFailed message={ORDERS_LOAD_FAILED_MESSAGE} onRetry={retry} />
      )}

      {state.kind === 'loaded' && (
        <PlanRoundForm
          initialGroups={state.groups}
          previousPickupBy={state.previousPickupBy}
          previousPickupFrom={state.previousPickupFrom}
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
}

/**
 * The plan's form, in three cards: "איפה" (the region and its orders, all marked when the region
 * is chosen, spec §3.5), "מתי" (the date and the pickup window) and "הודעה" (the personal text);
 * then "שלח הודעות". Every mistake shows next to its field, checked with the
 * shared `planRoundRequestSchema` (the api's own check) before anything is sent.
 *
 * The send is `planRound` of {@link useApi}, and after a conflict (`ordersNotWaiting`) the list
 * loads again with its `fetchWaitingOrders`.
 */
function PlanRoundForm({
  initialGroups,
  previousPickupBy,
  previousPickupFrom,
}: PlanRoundFormProps) {
  const { fetchWaitingOrders: loadOrders, planRound: submitPlan } = useApi();
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
  // An answer after Yoel left must not pull him to the rounds, or to the login.
  const mountedRef = useMountedRef();
  const formRef = useRef<HTMLFormElement>(null);

  const regionOrders = ordersOfRegion(groups, region);

  /** Clears these fields' errors (only these: the rest still hold), as their value changes. */
  function clearErrors(...fields: PlanField[]): void {
    setErrors((previous) => withoutFieldErrors(previous, fields));
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
      {/* Three cards: where (the region, and right under it its orders),
          when, and the message. The first field with an error is focused in this DOM order. */}
      <FormCard title={WHERE_CARD_TITLE} icon="pin">
        <PlanOrdersField
          groups={groups}
          region={region}
          checkedIds={checkedIds}
          regionError={errors.byField.region}
          ordersError={errors.byField.orderIds}
          onChooseRegion={chooseRegion}
          onToggleOrder={toggleOrder}
        />
      </FormCard>

      <FormCard title={WHEN_CARD_TITLE} icon="calendar">
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

        {/* One under the other, not side by side: the full labels are long. */}
        <TextField
          label={PICKUP_FROM_LABEL}
          type="time"
          value={pickupFrom}
          onChange={(nextTime) => {
            setPickupFrom(nextTime);
            clearErrors('pickupFrom', 'pickupBy');
          }}
          error={errors.byField.pickupFrom}
          hint={PICKUP_FROM_HINT}
          autoComplete="off"
        />

        <TextField
          label={PICKUP_BY_LABEL}
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
      </FormCard>

      <FormCard title={MESSAGE_CARD_TITLE} icon="chat">
        <PersonalTextField
          value={personalText}
          onChange={(nextText) => {
            setPersonalText(nextText);
            clearErrors('personalText');
          }}
          error={errors.byField.personalText}
        />
      </FormCard>

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

/** Props of {@link PersonalTextField}. */
interface PersonalTextFieldProps {
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
}

/** "טקסט אישי": a textarea, which TextField does not render, so the same .field parts by hand. */
function PersonalTextField({ value, onChange, error }: PersonalTextFieldProps) {
  const textId = useId();
  const textHintId = useId();
  const textErrorId = useId();

  return (
    <div className="field">
      <label htmlFor={textId} className="field-label">
        טקסט אישי (לא חובה)
      </label>
      <p id={textHintId} className="field-hint">
        {PERSONAL_TEXT_HINT}
      </p>
      <textarea
        id={textId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={PERSONAL_TEXT_MAX_LENGTH}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(textHintId, error ? textErrorId : undefined)}
      />
      {error && (
        <p id={textErrorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
