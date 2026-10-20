// "עריכה" of one order in the collector app (spec §3.5), at /app/orders/<id>: the booking form's
// fields filled from the order, then "רחוב קרוב" (ADR-0005: a listed street near a hand-written
// address, which sets both its region and its map point) and the region by hand ("שינוי אזור"),
// and "ביטול ההזמנה" with a confirmation in plain words. The PATCH body is put together in
// orderEditing.ts; this file is the screen and what happens after each answer.
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  COLLECTOR_ORDER_MESSAGES,
  REGION_LABELS,
  isOpenStatus,
  regionSchema,
  type CollectorOrder,
  type Region,
  type UpdateOrderRequest,
} from '@bottlerun/shared';
import {
  cancelCollectorOrder,
  fetchCollectorOrder,
  updateCollectorOrder,
  type CollectorOrderOutcome,
  type CollectorOrderWriteOutcome,
} from '../api.ts';
import { NO_ERRORS, validateOrderDetails } from '../orderForm/formValues.ts';
import { OrderFields } from '../orderForm/OrderFields.tsx';
import { useOrderForm } from '../orderForm/useOrderForm.ts';
import { Link, navigate } from '../router.tsx';
import { StreetPicker } from '../streetPicker/StreetPicker.tsx';
import type { StreetChoice } from '../streetPicker/streetChoice.ts';
import {
  ORDERS_LIST_PATH,
  cancelErrorMessage,
  editRequest,
  formValuesFromOrder,
  nearStreetChoice,
  saveErrors,
} from './orderEditing.ts';

/** Shown when the order got no usable answer (network error, 5xx, unreadable body). */
export const ORDER_LOAD_FAILED_MESSAGE =
  'לא הצלחנו לטעון את ההזמנה. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

/** Under "רחוב קרוב": what picking one does, in plain words (ADR-0005). */
export const NEAR_STREET_HINT = 'לכתובת שלא ברשימה: רחוב קרוב קובע את האזור ואת המיקום.';

/** Under "אזור": the near street already sets the region; this is for changing it by hand. */
export const REGION_HINT = 'רחוב קרוב כבר קובע את האזור. כאן משנים את האזור ביד, רק אם צריך.';

const SAVE_LABEL = 'שמירת השינויים';
const SAVING_LABEL = 'שומר...';
const CANCEL_ORDER_LABEL = 'ביטול ההזמנה';
const CONFIRM_CANCEL_LABEL = 'כן, לבטל';
const CANCELLING_LABEL = 'מבטל...';
const KEEP_ORDER_LABEL = 'לא, להשאיר';

/** Props of {@link EditOrderScreen}. */
export interface EditOrderScreenProps {
  /** The order's id, decoded from the URL (tabs.ts `ordersView`). */
  id: string;
  /**
   * Loads the order. Defaults to {@link fetchCollectorOrder}; tests pass a fake. Must keep its
   * identity across renders (a module function, not an inline arrow): a new one loads again.
   */
  loadOrder?: (id: string) => Promise<CollectorOrderOutcome>;
  /** Sends the changes. Defaults to {@link updateCollectorOrder}; tests pass a fake. */
  updateOrder?: (id: string, request: UpdateOrderRequest) => Promise<CollectorOrderWriteOutcome>;
  /** Cancels the order. Defaults to {@link cancelCollectorOrder}; tests pass a fake. */
  cancelOrder?: (id: string) => Promise<CollectorOrderWriteOutcome>;
}

/** What the screen shows. A logged-out answer leaves for /login and needs no state of its own. */
type ScreenState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'notFound' }
  | { kind: 'loaded'; order: CollectorOrder };

/**
 * The edit screen of order `id`. Renders the page's only `<h1>` (Layout's heading rule) and the
 * way back to the list in every state. The order loads once per mount (CollectorShell gives the
 * screen `key={id}`, so another order mounts it anew), and again when Yoel taps "לנסות שוב".
 *
 * The form appears only once the order is loaded: the street pickers read their value only when
 * they mount. An order that is no longer open (collected or cancelled) shows why instead of a form
 * the api would refuse.
 */
export function EditOrderScreen({
  id,
  loadOrder = fetchCollectorOrder,
  updateOrder = updateCollectorOrder,
  cancelOrder = cancelCollectorOrder,
}: EditOrderScreenProps) {
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  // Counts the "לנסות שוב" taps: a new value runs the load below again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // False once this load's answer no longer matters: Yoel left the screen, a retry started a
    // newer load, or React's StrictMode ran the effect a second time (dev only). A stale answer
    // changes nothing; above all, a late "logged out" must not pull him to the login from
    // another screen.
    let current = true;

    function settle(outcome: CollectorOrderOutcome): void {
      if (!current) return;
      switch (outcome.kind) {
        case 'loaded':
          setState({ kind: 'loaded', order: outcome.order });
          return;
        case 'notFound':
          setState({ kind: 'notFound' });
          return;
        case 'loggedOut':
          // Replace, not push: "back" from the login must not land on a screen that needs it.
          navigate('/login', { replace: true });
          return;
        case 'failed':
          setState({ kind: 'failed' });
          return;
      }
    }

    // fetchCollectorOrder never rejects; a rejection is a failed load like any other.
    loadOrder(id).then(settle, () => settle({ kind: 'failed' }));
    return () => {
      current = false;
    };
  }, [id, loadOrder, attempt]);

  function retry(): void {
    setState({ kind: 'loading' });
    setAttempt((previous) => previous + 1);
  }

  return (
    <>
      <h1>עריכת הזמנה</h1>
      <Link to={ORDERS_LIST_PATH} className="back-link">
        חזרה להזמנות
      </Link>

      {state.kind === 'loading' && <p role="status">טוען...</p>}

      {state.kind === 'failed' && (
        <>
          <p className="form-alert" role="alert">
            {ORDER_LOAD_FAILED_MESSAGE}
          </p>
          <button type="button" className="button button-primary button-block" onClick={retry}>
            לנסות שוב
          </button>
        </>
      )}

      {state.kind === 'notFound' && (
        <p className="form-alert" role="alert">
          {COLLECTOR_ORDER_MESSAGES.orderNotFound}
        </p>
      )}

      {state.kind === 'loaded' &&
        (isOpenStatus(state.order.status) ? (
          <EditOrderForm order={state.order} updateOrder={updateOrder} cancelOrder={cancelOrder} />
        ) : (
          // Collected or cancelled: final statuses (spec §4), so there is nothing left to edit.
          <p className="form-alert" role="alert">
            {COLLECTOR_ORDER_MESSAGES.orderClosed}
          </p>
        ))}
    </>
  );
}

/** Props of {@link EditOrderForm}. */
interface EditOrderFormProps {
  order: CollectorOrder;
  updateOrder: NonNullable<EditOrderScreenProps['updateOrder']>;
  cancelOrder: NonNullable<EditOrderScreenProps['cancelOrder']>;
}

/**
 * The form of a loaded, open order, and its cancel. Mounted only once the order is there, so
 * every field (the two street pickers too) starts from the stored values.
 */
function EditOrderForm({ order, updateOrder, cancelOrder }: EditOrderFormProps) {
  const { values, errors, setErrors, setField, formRef, showErrors } = useOrderForm(() =>
    formValuesFromOrder(order),
  );
  const [nearStreet, setNearStreet] = useState<StreetChoice | null>(() =>
    nearStreetChoice(order.address.nearStreetCode),
  );
  // undefined: the order has no region yet ("בלי אזור"), and Yoel has not picked one.
  const [region, setRegion] = useState<Region | undefined>(order.region);
  const [saving, setSaving] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // One request at a time, save or cancel: the states above reach the handlers only after a
  // re-render, and this ref stops a second tap that comes before it.
  const busyRef = useRef(false);
  // False once the screen is gone: an answer that comes after Yoel left (the bottom navigation)
  // must not pull him back to the list, or to the login, from the screen he went to.
  const mountedRef = useRef(false);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmQuestionRef = useRef<HTMLParagraphElement>(null);
  const regionGroupName = useId();
  const regionHintId = useId();
  const confirmQuestionId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function save(): Promise<void> {
    if (busyRef.current) return;
    const validation = validateOrderDetails(values);
    if (!validation.ok) {
      showErrors(validation.errors);
      return;
    }

    busyRef.current = true;
    setSaving(true);
    setErrors(NO_ERRORS);
    let outcome: CollectorOrderWriteOutcome;
    try {
      outcome = await updateOrder(
        order.id,
        editRequest(order, validation.request, nearStreet, region),
      );
    } catch {
      // updateCollectorOrder never rejects, but a rejection must not leave the button on "שומר...".
      outcome = { kind: 'failed' };
    }
    busyRef.current = false;
    if (!mountedRef.current) return;
    setSaving(false);

    switch (outcome.kind) {
      case 'saved':
        // Replace, not push: "back" from the list must not reopen the form as it was before.
        navigate(ORDERS_LIST_PATH, { replace: true });
        return;
      case 'loggedOut':
        navigate('/login', { replace: true });
        return;
      default:
        showErrors(saveErrors(outcome));
        return;
    }
  }

  /**
   * Opens or closes the confirmation, and moves focus where the next step is: to the question
   * when it opens (the button just tapped disappears), back to "ביטול ההזמנה" when it closes.
   * flushSync renders first, so the element exists, and the focus call stays inside the tap.
   */
  function showCancelConfirmation(open: boolean): void {
    flushSync(() => {
      setConfirmingCancel(open);
      setCancelError(null);
    });
    (open ? confirmQuestionRef : cancelButtonRef).current?.focus();
  }

  async function confirmCancel(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setCancelling(true);
    setCancelError(null);
    let outcome: CollectorOrderWriteOutcome;
    try {
      outcome = await cancelOrder(order.id);
    } catch {
      outcome = { kind: 'failed' };
    }
    busyRef.current = false;
    if (!mountedRef.current) return;
    setCancelling(false);

    switch (outcome.kind) {
      case 'saved':
        // The order left the waiting list; replace, so "back" does not reopen its form.
        navigate(ORDERS_LIST_PATH, { replace: true });
        return;
      case 'loggedOut':
        navigate('/login', { replace: true });
        return;
      default:
        // The confirmation stays open with the reason, so a dropped connection is one tap away
        // from another try.
        setCancelError(cancelErrorMessage(outcome));
        return;
    }
  }

  return (
    <>
      {/* noValidate: the form shows its own Hebrew messages next to each field, not the
          browser's bubbles. */}
      <form
        ref={formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <OrderFields values={values} errors={errors.byField} onFieldChange={setField} />

        {/* Shown for every order, not only one written by hand: a listed street with no point,
            or a wrong one, gets its location from a near street too (ADR-0005). */}
        <StreetPicker
          label="רחוב קרוב"
          allowFreeText={false}
          value={nearStreet}
          onChange={setNearStreet}
          hint={NEAR_STREET_HINT}
        />

        <fieldset className="field" aria-describedby={regionHintId}>
          <legend className="field-label">אזור</legend>
          <p id={regionHintId} className="field-hint">
            {REGION_HINT}
          </p>
          {/* No radio is checked for an order without a region ("בלי אזור"). There is no way
              back to it: the api keeps a region once the order has one. */}
          <div className="choice-list">
            {regionSchema.options.map((option) => (
              <label key={option} className="choice">
                <input
                  type="radio"
                  name={regionGroupName}
                  value={option}
                  checked={region === option}
                  onChange={() => setRegion(option)}
                />
                {REGION_LABELS[option]}
              </label>
            ))}
          </div>
        </fieldset>

        {errors.other && (
          <p className="form-alert" role="alert">
            {errors.other}
          </p>
        )}

        {/* aria-disabled, not disabled, while saving: the button keeps focus and is announced
            as unavailable; busyRef ignores the extra taps. */}
        <button
          type="submit"
          className="button button-primary button-block"
          aria-disabled={saving ? true : undefined}
        >
          {saving ? SAVING_LABEL : SAVE_LABEL}
        </button>
      </form>

      {/* Outside the form, so Enter in a field never reaches it. A confirmation in the page, not
          window.confirm: big buttons in Hebrew, and the customer's name in the question. */}
      <div className="cancel-order">
        {confirmingCancel ? (
          <div role="group" aria-labelledby={confirmQuestionId} className="cancel-confirm">
            <p
              id={confirmQuestionId}
              ref={confirmQuestionRef}
              tabIndex={-1}
              className="cancel-confirm-question"
            >
              לבטל את ההזמנה של {order.contact.name}?
            </p>
            {cancelError !== null && (
              <p className="form-alert" role="alert">
                {cancelError}
              </p>
            )}
            <div className="cancel-confirm-actions">
              <button
                type="button"
                className="button button-primary"
                aria-disabled={cancelling ? true : undefined}
                onClick={() => void confirmCancel()}
              >
                {cancelling ? CANCELLING_LABEL : CONFIRM_CANCEL_LABEL}
              </button>
              <button
                type="button"
                className="button button-secondary"
                aria-disabled={cancelling ? true : undefined}
                onClick={() => {
                  // While the cancel is on its way its answer decides; closing now would hide it.
                  if (!cancelling) showCancelConfirmation(false);
                }}
              >
                {KEEP_ORDER_LABEL}
              </button>
            </div>
          </div>
        ) : (
          <button
            ref={cancelButtonRef}
            type="button"
            className="button button-secondary button-block"
            onClick={() => showCancelConfirmation(true)}
          >
            {CANCEL_ORDER_LABEL}
          </button>
        )}
      </div>
    </>
  );
}
