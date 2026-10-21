// The customer's own page `/o/<token>` (spec §3.3), reached from the thank-you screen and from the
// links in Yoel's WhatsApp messages, by the order's random token only. It loads the order (api.ts,
// GET /api/o/:token) and draws what fits its status: the round's date and a big "כן, אוציא את הבקבוקים"
// while a confirmation is asked for, "נתראה ב-<תאריך>" once confirmed, thanks and "הזמנה חדשה עם
// אותם פרטים" once collected or cancelled, and, while the order is open, "שינוי" (the booking
// form's fields without the contact: address, note and bottles, never the phone) and "ביטול
// ההזמנה" (with a question first). Every button is a POST or a PATCH, never a link to open:
// WhatsApp's preview opens links. The page always draws the order the api answered with, not what
// it expected the button to do.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  BOTTLES_SPOT_LABELS,
  CUSTOMER_ORDER_MESSAGES,
  ORDER_STATUS_LABELS,
  formatDayMonth,
  formatIsraeliMobileLocal,
  isLocationChange,
  isOpenStatus,
  type CustomerOrder,
  type CustomerUpdateOrderRequest,
} from '@bottlerun/shared';
import {
  NETWORK_ERROR_MESSAGE,
  cancelCustomerOrder,
  confirmCustomerOrder,
  declineCustomerOrder,
  fetchCustomerOrder,
  updateCustomerOrder,
  type CustomerOrderOutcome,
  type CustomerOrderWriteOutcome,
} from '../api.ts';
import { CancelConfirm } from '../components/CancelConfirm.tsx';
import {
  NO_ERRORS,
  SAVE_FAILED_MESSAGE,
  addressPlaceOf,
  validateCustomerChange,
  type FormErrors,
  type OrderFormValues,
} from '../orderForm/formValues.ts';
import { OrderFields } from '../orderForm/OrderFields.tsx';
import { formValuesFromPrefill, orderFormNavigationState } from '../orderForm/savedDetails.ts';
import { useOrderForm } from '../orderForm/useOrderForm.ts';
import { Link, navigate } from '../router.tsx';

/** The page's `<h1>`, the same in every state. */
export const ORDER_PAGE_HEADING = 'ההזמנה שלך';

/** Shown when the order got no usable answer (network error, 5xx, unreadable body). */
export const ORDER_LOAD_FAILED_MESSAGE =
  'לא הצלחנו לטעון את ההזמנה. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

/** Under the status of a waiting order: what happens next, in the thank-you screen's words. */
export const WAITING_TEXT = 'נשלח לך הודעת WhatsApp לפני הסבב באזור שלך.';

/** Under the status of a collected order. */
export const COLLECTED_TEXT = 'ההזמנה נאספה. תודה רבה שלקחתם חלק בלתת עוד!';

/**
 * Under the status of a cancelled order: thanks (spec §3.3), and what the button under it does.
 * Not "ההזמנה בוטלה.": the status line already says it, and so does the message announced right
 * after the customer's own cancel.
 */
export const CANCELLED_TEXT = 'תודה! אפשר להזמין איסוף חדש בכל עת.';

/** What each request of the page announces once the api stored it. */
export const SAVED_MESSAGES = {
  confirm: 'תודה! האיסוף אושר.',
  decline: 'קיבלנו. נחזור אליך עם מועד חדש.',
  cancel: 'ההזמנה בוטלה.',
  change: 'השינויים נשמרו.',
} as const;

/**
 * Announced instead of {@link SAVED_MESSAGES}.change when a new street or house number took the
 * order out of its round (spec §3.3: "שינוי כתובת אחרי שההזמנה נכנסה לסבב מוציא אותה מהסבב").
 */
export const LEFT_ROUND_MESSAGE = 'הכתובת עודכנה. ההזמנה יצאה מהסבב, ונחזור אליך עם מועד חדש.';

/** Above the change form's fields: why the phone is not among them (spec §3.3). */
export const PHONE_NOT_CHANGED_TEXT = 'את מספר הטלפון אי אפשר לשנות כאן.';

// What the button really confirms: the customer puts the bottles out on the round's day (not "the
// pickup", which Yoel does). ConfirmLabel appends the round's date when the api sent one.
const CONFIRM_LABEL = 'כן, אוציא את הבקבוקים';
const DECLINE_LABEL = 'לא מתאים הפעם';
// A tap on "לא מתאים הפעם" sits just under the big "כן, אוציא את הבקבוקים" and takes the order out of the
// round, so it asks first (elderly customers mis-tap).
const DECLINE_QUESTION = 'לא מתאים לך הפעם? ההזמנה תחכה לסבב הבא.';
const CONFIRM_DECLINE_LABEL = 'כן, לא מתאים';
const SENDING_LABEL = 'שולח...';
const CANCEL_ORDER_LABEL = 'ביטול ההזמנה';
const CANCEL_QUESTION = 'לבטל את ההזמנה?';
const NEW_ORDER_LABEL = 'הזמנה חדשה עם אותם פרטים';
const CHANGE_LABEL = 'שינוי';
const CHANGE_HEADING = 'שינוי פרטי ההזמנה';
const SAVE_CHANGE_LABEL = 'שמירת השינויים';
const SAVING_LABEL = 'שומר...';
const KEEP_AS_IS_LABEL = 'בלי לשנות';

/** A request of the page, by what it asks the api to do. */
type Action = keyof typeof SAVED_MESSAGES;

/** A button that sends its request at once: every action but the change form's save. */
type ButtonAction = Exclude<Action, 'change'>;

/** Sends one button's request for the order with `token`. */
type SendAction = (token: string) => Promise<CustomerOrderWriteOutcome>;

/** Props of {@link OrderPage}. */
export interface OrderPageProps {
  /** The order's token, from the URL `/o/<token>`. */
  token: string;
  /**
   * Loads the order. Defaults to {@link fetchCustomerOrder}; tests pass a fake. Must keep its
   * identity across renders (a module function, not an inline arrow): a new one loads again.
   */
  loadOrder?: (token: string) => Promise<CustomerOrderOutcome>;
  /** The confirm button. Defaults to {@link confirmCustomerOrder}; tests pass a fake. */
  confirmOrder?: SendAction;
  /** "לא מתאים הפעם". Defaults to {@link declineCustomerOrder}; tests pass a fake. */
  declineOrder?: SendAction;
  /** "כן, לבטל". Defaults to {@link cancelCustomerOrder}; tests pass a fake. */
  cancelOrder?: SendAction;
  /**
   * "שמירת השינויים" of the change form. Defaults to {@link updateCustomerOrder}; tests pass a
   * fake.
   */
  updateOrder?: (
    token: string,
    request: CustomerUpdateOrderRequest,
  ) => Promise<CustomerOrderWriteOutcome>;
}

/** What the page shows below its heading. */
type PageState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'notFound' }
  | { kind: 'loaded'; order: CustomerOrder };

/**
 * A message about the last button, right under the heading: what it did (`status`, announced
 * politely), or why it did not (`alert`, announced at once). `focus`: the button just tapped is
 * gone, so focus moves to the message.
 */
interface Notice {
  role: 'status' | 'alert';
  text: string;
  focus: boolean;
}

/**
 * The customer's order page. Renders the page's only `<h1>` (Layout's heading rule), "ההזמנה
 * שלך", in every state. The order loads once per mount (App gives the page `key={token}`), again
 * on "לנסות שוב", and again after a request the api refused because the order changed meanwhile.
 *
 * "שינוי" opens a form in place of the order's details and buttons, filled from the order; it
 * closes on a saved change (the page then draws the order the api answered with) or on "בלי
 * לשנות", which sends nothing.
 *
 * One request at a time: a double tap on a button sends one request. Every write is idempotent
 * on the api's side too, so a request whose answer was lost is put right by tapping again.
 */
export function OrderPage({
  token,
  loadOrder = fetchCustomerOrder,
  confirmOrder = confirmCustomerOrder,
  declineOrder = declineCustomerOrder,
  cancelOrder = cancelCustomerOrder,
  updateOrder = updateCustomerOrder,
}: OrderPageProps) {
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  // Counts the loads asked for after the first ("לנסות שוב", a refused request): a new value runs
  // the load below again.
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The request on its way: its button shows "שולח..." (the cancel: "מבטל...", the change form's
  // save: "שומר...").
  const [busy, setBusy] = useState<Action | null>(null);
  // A failed cancel is told inside the cancel question, next to the buttons to try again.
  const [cancelError, setCancelError] = useState<string | null>(null);
  // The same for a failed "לא מתאים הפעם", inside its own question.
  const [declineError, setDeclineError] = useState<string | null>(null);
  // True while the change form is open, in place of the order's details and buttons.
  const [changing, setChanging] = useState(false);
  // One request at a time: `busy` reaches the handlers only after a re-render, and this ref stops
  // a second tap that comes before it.
  const busyRef = useRef(false);
  // False once the page is gone: an answer that comes after the customer left changes nothing.
  const mountedRef = useRef(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const changeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // False once this load's answer no longer matters: the customer left the page, a newer load
    // started, or React's StrictMode ran the effect a second time (dev only).
    let current = true;

    function settle(outcome: CustomerOrderOutcome): void {
      if (!current) return;
      switch (outcome.kind) {
        case 'loaded':
          setState({ kind: 'loaded', order: outcome.order });
          return;
        case 'notFound':
          setState({ kind: 'notFound' });
          return;
        case 'failed':
          setState({ kind: 'failed' });
          return;
      }
    }

    // fetchCustomerOrder never rejects; a rejection is a failed load like any other.
    loadOrder(token).then(settle, () => settle({ kind: 'failed' }));
    return () => {
      current = false;
    };
  }, [token, loadOrder, attempt]);

  // After the page drew a message whose button is gone, focus moves to it, so a screen reader
  // reads it and a keyboard user goes on from there. Once per message: a reload keeps the same one.
  // A layout effect: focus moves in the same commit that draws the message, never a moment later
  // (an answer arrives outside any tap, where a plain effect runs only after the browser paints).
  useLayoutEffect(() => {
    if (notice?.focus) noticeRef.current?.focus();
  }, [notice]);

  function reload(): void {
    setState({ kind: 'loading' });
    setAttempt((previous) => previous + 1);
  }

  /**
   * Sends one request, unless another is on its way. Returns its outcome, or null when it was
   * not sent or its answer came after the customer left the page: then there is nothing to draw.
   */
  async function sendOnce(
    action: Action,
    send: () => Promise<CustomerOrderWriteOutcome>,
  ): Promise<CustomerOrderWriteOutcome | null> {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(action);
    setNotice(null);
    setCancelError(null);
    setDeclineError(null);
    let outcome: CustomerOrderWriteOutcome;
    try {
      outcome = await send();
    } catch {
      // The api.ts functions never reject, but a rejection must not leave the button busy.
      outcome = { kind: 'failed' };
    }
    busyRef.current = false;
    if (!mountedRef.current) return null;
    setBusy(null);
    return outcome;
  }

  /**
   * The order changed under the page: Yoel closed the round's confirmations, or it was collected
   * or cancelled meanwhile. Says why, and loads it again so the page shows its real state; the
   * message stays above it through the reload.
   */
  function showClosed(message: string): void {
    setChanging(false);
    setNotice({ role: 'alert', text: message, focus: true });
    reload();
  }

  /** Sends one button's request, and draws what the api answered. */
  async function press(action: ButtonAction, send: SendAction): Promise<void> {
    const outcome = await sendOnce(action, () => send(token));
    if (outcome === null) return;

    switch (outcome.kind) {
      case 'saved':
        setState({ kind: 'loaded', order: outcome.order });
        setNotice({ role: 'status', text: SAVED_MESSAGES[action], focus: true });
        return;
      case 'closed':
        showClosed(outcome.message);
        return;
      case 'notFound':
        setState({ kind: 'notFound' });
        return;
      // A button sends no body, so a 400 is nothing the customer can fix: like any failure.
      case 'invalid':
      case 'failed':
        // The page stays as it was, so the same button is one tap away from another try.
        if (action === 'cancel') setCancelError(NETWORK_ERROR_MESSAGE);
        else if (action === 'decline') setDeclineError(NETWORK_ERROR_MESSAGE);
        else setNotice({ role: 'alert', text: NETWORK_ERROR_MESSAGE, focus: false });
        return;
    }
  }

  /**
   * "שמירת השינויים": sends the change form's validated request, and draws what the api answered.
   * `leavesRound`: the form warned that the new address takes the order out of its round.
   *
   * Returns the errors the form shows, keeping what was typed (a field the api refused, or
   * {@link SAVE_FAILED_MESSAGE}), or null when the form has nothing to show: it was closed (saved,
   * or the order closed or was not found), or the request was not sent.
   */
  async function saveChange(
    request: CustomerUpdateOrderRequest,
    leavesRound: boolean,
  ): Promise<FormErrors | null> {
    const outcome = await sendOnce('change', () => updateOrder(token, request));
    if (outcome === null) return null;

    switch (outcome.kind) {
      case 'saved': {
        // The api decides whether the order left its round; the answer's status says it did.
        const leftRound = leavesRound && outcome.order.status === 'waiting';
        setChanging(false);
        setState({ kind: 'loaded', order: outcome.order });
        setNotice({
          role: 'status',
          text: leftRound ? LEFT_ROUND_MESSAGE : SAVED_MESSAGES.change,
          focus: true,
        });
        return null;
      }
      case 'closed':
        showClosed(outcome.message);
        return null;
      case 'notFound':
        setChanging(false);
        setState({ kind: 'notFound' });
        return null;
      case 'invalid':
        // Next to the fields the api named; a 400 with none (a body refused as a whole) is
        // already UNKNOWN_FIELD_ERROR in `other`, above the save button.
        return outcome.errors;
      case 'failed':
        // Nothing is retried on its own: the change may have arrived. Saving again is harmless.
        return { byField: {}, other: SAVE_FAILED_MESSAGE };
    }
  }

  /** "שינוי": the form in place of the details. It moves focus to its own heading. */
  function openChange(): void {
    if (busyRef.current) return;
    setNotice(null);
    setCancelError(null);
    setChanging(true);
  }

  /**
   * "בלי לשנות": closes the form without a request. flushSync renders first, so "שינוי" is back
   * to take the focus, and the focus call stays inside the tap.
   */
  function closeChange(): void {
    flushSync(() => setChanging(false));
    changeButtonRef.current?.focus();
  }

  return (
    <>
      <h1>{ORDER_PAGE_HEADING}</h1>

      {notice !== null && (
        // tabIndex -1: focusable from code, but not a stop when tabbing through the page.
        <p
          ref={noticeRef}
          tabIndex={-1}
          role={notice.role}
          className={notice.role === 'alert' ? 'form-alert' : 'order-notice'}
        >
          {notice.text}
        </p>
      )}

      {state.kind === 'loading' && <p role="status">טוען...</p>}

      {state.kind === 'failed' && (
        <>
          <p className="form-alert" role="alert">
            {ORDER_LOAD_FAILED_MESSAGE}
          </p>
          <button type="button" className="button button-primary button-block" onClick={reload}>
            לנסות שוב
          </button>
        </>
      )}

      {state.kind === 'notFound' && (
        <>
          <p className="form-alert" role="alert">
            {CUSTOMER_ORDER_MESSAGES.orderNotFound}
          </p>
          <Link to="/" className="button button-primary button-block">
            לטופס ההזמנה
          </Link>
        </>
      )}

      {state.kind === 'loaded' && (
        <>
          <OrderStatus order={state.order} />

          {/* Only an open order can change (spec §3.3); a collected or cancelled one never
              shows the form, even if it closed while the form was open. */}
          {changing && isOpenStatus(state.order.status) ? (
            <ChangeOrderForm
              order={state.order}
              saving={busy === 'change'}
              onSave={saveChange}
              onClose={closeChange}
            />
          ) : (
            <>
              {state.order.status === 'pending' && (
                <div className="order-actions">
                  {/* aria-disabled, not disabled, while a request is on its way: the button
                      keeps focus and is announced as unavailable; busyRef ignores the extra
                      taps. */}
                  <button
                    type="button"
                    className="button button-primary button-block button-large"
                    aria-disabled={busy !== null ? true : undefined}
                    onClick={() => void press('confirm', confirmOrder)}
                  >
                    {busy === 'confirm' ? (
                      SENDING_LABEL
                    ) : (
                      <ConfirmLabel round={state.order.round} />
                    )}
                  </button>
                  <CancelConfirm
                    inline
                    buttonLabel={DECLINE_LABEL}
                    question={DECLINE_QUESTION}
                    confirmLabel={CONFIRM_DECLINE_LABEL}
                    busyLabel={SENDING_LABEL}
                    cancelling={busy === 'decline'}
                    error={declineError}
                    onConfirm={() => void press('decline', declineOrder)}
                    onOpenChange={() => setDeclineError(null)}
                  />
                </div>
              )}

              {!isOpenStatus(state.order.status) && (
                <button
                  type="button"
                  className="button button-primary button-block"
                  onClick={() => startNewOrder(state.order)}
                >
                  {NEW_ORDER_LABEL}
                </button>
              )}

              <OrderDetails order={state.order} />

              {/* Collected and cancelled are final (spec §4): nothing left to change or cancel. */}
              {isOpenStatus(state.order.status) && (
                <>
                  <button
                    ref={changeButtonRef}
                    type="button"
                    className="button button-secondary button-block order-change-button"
                    aria-disabled={busy !== null ? true : undefined}
                    onClick={openChange}
                  >
                    {CHANGE_LABEL}
                  </button>
                  <CancelConfirm
                    buttonLabel={CANCEL_ORDER_LABEL}
                    question={CANCEL_QUESTION}
                    cancelling={busy === 'cancel'}
                    error={cancelError}
                    onConfirm={() => void press('cancel', cancelOrder)}
                    onOpenChange={() => setCancelError(null)}
                  />
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/** Props of {@link ChangeOrderForm}. */
interface ChangeOrderFormProps {
  /** The open order the form starts from. */
  order: CustomerOrder;
  /** True while the save is on its way: the save button reads "שומר...". */
  saving: boolean;
  /** Sends the validated change; resolves to the errors to show, or null (see saveChange). */
  onSave: (request: CustomerUpdateOrderRequest, leavesRound: boolean) => Promise<FormErrors | null>;
  /** "בלי לשנות": closes the form without a request. */
  onClose: () => void;
}

/**
 * "שינוי" (spec §3.3: "אפשר לשנות כתובת, כמות והערה. לא את הטלפון."): the booking form's fields
 * without the contact, filled from the order, and the same rules (validateCustomerChange) before
 * anything is sent. Mounted only when opened: the street picker reads its value when it mounts.
 *
 * While the order is in a round (pending or confirmed) and the street or house number differs
 * from the stored one, a line above the save button says that saving takes the order out of the
 * round (the api's rule, shared `isLocationChange`), before the customer saves.
 */
function ChangeOrderForm({ order, saving, onSave, onClose }: ChangeOrderFormProps) {
  const { values, errors, setErrors, setField, formRef, showErrors } = useOrderForm(() =>
    changeFormValues(order),
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const warningId = useId();

  // The "שינוי" button just tapped is gone: focus moves to the form's heading, so a screen reader
  // says where the customer is, and the next tab reaches the first field. In the commit that
  // draws the form (a layout effect), so focus is never left on the vanished button.
  useLayoutEffect(() => {
    headingRef.current?.focus();
  }, []);

  // A pending or confirmed order is in a round; the api takes it out on a new street or house
  // number. The round's date shows when the api sent it.
  const inRound = order.status === 'pending' || order.status === 'confirmed';
  const leavesRound = inRound && isLocationChange(order.address, addressPlaceOf(values));

  async function save(): Promise<void> {
    if (saving) return;
    const validation = validateCustomerChange(values);
    if (!validation.ok) {
      showErrors(validation.errors);
      return;
    }
    setErrors(NO_ERRORS);
    const shown = await onSave(validation.request, leavesRound);
    if (shown !== null) showErrors(shown);
  }

  return (
    <section aria-labelledby={headingId}>
      {/* tabIndex -1: focusable from code, but not a stop when tabbing through the page. */}
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        {CHANGE_HEADING}
      </h2>
      <p>{PHONE_NOT_CHANGED_TEXT}</p>

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
        <OrderFields
          values={values}
          errors={errors.byField}
          onFieldChange={setField}
          showContact={false}
        />

        {leavesRound && (
          <p id={warningId} className="order-change-warning">
            {order.round === undefined ? (
              'שינוי הכתובת יוציא את ההזמנה מהסבב, ונחזור אליך עם מועד חדש.'
            ) : (
              <>
                שינוי הכתובת יוציא את ההזמנה מהסבב ב-
                {/* DD/MM reads left to right inside the right-to-left text (CLAUDE.md). */}
                <bdi dir="ltr">{formatDayMonth(order.round.date)}</bdi>, ונחזור אליך עם מועד חדש.
              </>
            )}
          </p>
        )}

        {errors.other && (
          <p className="form-alert" role="alert">
            {errors.other}
          </p>
        )}

        <div className="order-actions">
          {/* aria-disabled, not disabled, while saving: the button keeps focus and is announced
              as unavailable; the page's busyRef ignores the extra taps. */}
          <button
            type="submit"
            className="button button-primary button-block"
            aria-disabled={saving ? true : undefined}
            aria-describedby={leavesRound ? warningId : undefined}
          >
            {saving ? SAVING_LABEL : SAVE_CHANGE_LABEL}
          </button>
          <button
            type="button"
            className="button button-secondary button-block"
            aria-disabled={saving ? true : undefined}
            onClick={() => {
              // While the save is on its way its answer decides; closing now would hide it.
              if (!saving) onClose();
            }}
          >
            {KEEP_AS_IS_LABEL}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * The change form's starting values: the order's address as the booking form's prefill shows it
 * (a street still in the official list as that listed street, any other as the stored name in
 * free text), and the number of bottles as text in its input. The name and phone are in the
 * values too, but the form neither shows nor sends them.
 */
function changeFormValues(order: CustomerOrder): OrderFormValues {
  return {
    ...formValuesFromPrefill({ contact: order.contact, address: order.address }),
    bottlesEstimated: String(order.bottlesEstimated),
  };
}

/**
 * "הזמנה חדשה עם אותם פרטים": the booking form at `/`, filled with this order's contact and
 * address (savedDetails.ts reads them back). Never the number of bottles, which differs from one
 * order to the next. A new history entry, so "back" returns to this page.
 */
function startNewOrder(order: CustomerOrder): void {
  navigate('/', {
    state: orderFormNavigationState({ contact: order.contact, address: order.address }),
  });
}

/**
 * The confirm button's text: what is confirmed, and on which day. DD/MM reads left to right inside
 * the right-to-left text (CLAUDE.md). A pending order whose round the api did not send gets the
 * text without a day.
 */
function ConfirmLabel({ round }: { round: CustomerOrder['round'] }) {
  if (round === undefined) return CONFIRM_LABEL;
  return (
    <>
      {CONFIRM_LABEL} ב-<bdi dir="ltr">{formatDayMonth(round.date)}</bdi>
    </>
  );
}

/** The status in plain words, and what it means for the customer now (spec §3.3). */
function OrderStatus({ order }: { order: CustomerOrder }) {
  return (
    <>
      <p className="order-status">
        מצב ההזמנה: <strong>{ORDER_STATUS_LABELS[order.status]}</strong>
      </p>
      <StatusText order={order} />
    </>
  );
}

/**
 * The lines under the status. The round's date shows for a pending or confirmed order only, and
 * only when the api sent it: an order whose round is gone has no date to promise.
 */
function StatusText({ order }: { order: CustomerOrder }) {
  const { round } = order;
  switch (order.status) {
    case 'waiting':
      return <p>{WAITING_TEXT}</p>;
    case 'pending':
    case 'confirmed':
      if (round === undefined) return null;
      return (
        <>
          <p>
            {order.status === 'pending' ? 'נעבור לאסוף ב-' : 'נתראה ב-'}
            {/* DD/MM and HH:MM read left to right inside the right-to-left text (CLAUDE.md). */}
            <bdi dir="ltr">{formatDayMonth(round.date)}</bdi>.
          </p>
          {round.pickupBy !== undefined && (
            <p>
              נא להוציא את הבקבוקים עד השעה <bdi dir="ltr">{round.pickupBy}</bdi>.
            </p>
          )}
        </>
      );
    case 'collected':
      return <p>{COLLECTED_TEXT}</p>;
    case 'cancelled':
      return <p>{CANCELLED_TEXT}</p>;
  }
}

/**
 * The order's details as the customer gave them: only what the api sent, which is the order's
 * own (no id, no region, nothing of another customer).
 */
function OrderDetails({ order }: { order: CustomerOrder }) {
  const headingId = useId();
  const { contact, address } = order;
  // Where at the address: the spot in the form's words, then the floor and apartment if given.
  const spot = [BOTTLES_SPOT_LABELS[address.bottlesSpot], address.floorApt]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');

  return (
    <section className="order-details" aria-labelledby={headingId}>
      <h2 id={headingId}>פרטי ההזמנה</h2>
      <dl>
        <dt>שם</dt>
        <dd>{contact.name}</dd>
        <dt>טלפון</dt>
        <dd>
          {/* Digits and hyphens read left to right inside the right-to-left text (CLAUDE.md). */}
          <bdi dir="ltr">{formatIsraeliMobileLocal(contact.phone)}</bdi>
        </dd>
        <dt>כתובת</dt>
        <dd>
          {address.streetName} {address.houseNumber}
        </dd>
        <dt>איפה הבקבוקים</dt>
        <dd>{spot}</dd>
        {address.note !== undefined && address.note !== '' && (
          <>
            <dt>הערה</dt>
            <dd>{address.note}</dd>
          </>
        )}
        <dt>כמות בקבוקים</dt>
        <dd>{order.bottlesEstimated}</dd>
      </dl>
    </section>
  );
}
