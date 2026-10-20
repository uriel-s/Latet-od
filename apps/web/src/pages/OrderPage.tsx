// The customer's own page `/o/<token>` (spec §3.3), reached from the thank-you screen and from the
// links in Yoel's WhatsApp messages, by the order's random token only. It loads the order (api.ts,
// GET /api/o/:token) and draws what fits its status: the round's date and a big "מאשר/ת איסוף"
// while a confirmation is asked for, "נתראה ב-<תאריך>" once confirmed, thanks and "הזמנה חדשה עם
// אותם פרטים" once collected or cancelled, and "ביטול ההזמנה" (with a question first) while the
// order is open. Every button is a POST, never a link to open: WhatsApp's preview opens links. The
// page always draws the order the api answered with, not what it expected the button to do.
import { useEffect, useId, useRef, useState } from 'react';
import {
  BOTTLES_SPOT_LABELS,
  CUSTOMER_ORDER_MESSAGES,
  ORDER_STATUS_LABELS,
  formatDayMonth,
  formatIsraeliMobileLocal,
  isOpenStatus,
  type CustomerOrder,
} from '@bottlerun/shared';
import {
  NETWORK_ERROR_MESSAGE,
  cancelCustomerOrder,
  confirmCustomerOrder,
  declineCustomerOrder,
  fetchCustomerOrder,
  type CustomerOrderOutcome,
  type CustomerOrderWriteOutcome,
} from '../api.ts';
import { CancelConfirm } from '../components/CancelConfirm.tsx';
import { orderFormNavigationState } from '../orderForm/savedDetails.ts';
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

/** What each button announces once the api stored it. */
export const SAVED_MESSAGES = {
  confirm: 'תודה! האיסוף אושר.',
  decline: 'קיבלנו. נחזור אליך עם מועד חדש.',
  cancel: 'ההזמנה בוטלה.',
} as const;

const CONFIRM_LABEL = 'מאשר/ת איסוף';
const DECLINE_LABEL = 'לא מתאים הפעם';
const SENDING_LABEL = 'שולח...';
const CANCEL_ORDER_LABEL = 'ביטול ההזמנה';
const CANCEL_QUESTION = 'לבטל את ההזמנה?';
const NEW_ORDER_LABEL = 'הזמנה חדשה עם אותם פרטים';

/** A button of the page, by what it asks the api to do. */
type Action = keyof typeof SAVED_MESSAGES;

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
  /** "מאשר/ת איסוף". Defaults to {@link confirmCustomerOrder}; tests pass a fake. */
  confirmOrder?: SendAction;
  /** "לא מתאים הפעם". Defaults to {@link declineCustomerOrder}; tests pass a fake. */
  declineOrder?: SendAction;
  /** "כן, לבטל". Defaults to {@link cancelCustomerOrder}; tests pass a fake. */
  cancelOrder?: SendAction;
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
 * on "לנסות שוב", and again after a button the api refused because the order changed meanwhile.
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
}: OrderPageProps) {
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  // Counts the loads asked for after the first ("לנסות שוב", a refused button): a new value runs
  // the load below again.
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The button whose request is on its way, which shows "שולח..." (the cancel: "מבטל...").
  const [busy, setBusy] = useState<Action | null>(null);
  // A failed cancel is told inside the cancel question, next to the buttons to try again.
  const [cancelError, setCancelError] = useState<string | null>(null);
  // One request at a time: `busy` reaches the handlers only after a re-render, and this ref stops
  // a second tap that comes before it.
  const busyRef = useRef(false);
  // False once the page is gone: an answer that comes after the customer left changes nothing.
  const mountedRef = useRef(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);

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
  useEffect(() => {
    if (notice?.focus) noticeRef.current?.focus();
  }, [notice]);

  function reload(): void {
    setState({ kind: 'loading' });
    setAttempt((previous) => previous + 1);
  }

  /** Sends one button's request, and draws what the api answered. */
  async function press(action: Action, send: SendAction): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(action);
    setNotice(null);
    setCancelError(null);
    let outcome: CustomerOrderWriteOutcome;
    try {
      outcome = await send(token);
    } catch {
      // The api.ts functions never reject, but a rejection must not leave the button on "שולח...".
      outcome = { kind: 'failed' };
    }
    busyRef.current = false;
    if (!mountedRef.current) return;
    setBusy(null);

    switch (outcome.kind) {
      case 'saved':
        setState({ kind: 'loaded', order: outcome.order });
        setNotice({ role: 'status', text: SAVED_MESSAGES[action], focus: true });
        return;
      case 'closed':
        // The order changed under the page: Yoel closed the round's confirmations, or it was
        // collected or cancelled meanwhile. Say why, and load it again so the page shows its real
        // state; the message stays above it through the reload.
        setNotice({ role: 'alert', text: outcome.message, focus: true });
        reload();
        return;
      case 'notFound':
        setState({ kind: 'notFound' });
        return;
      // A button sends no body, so a 400 is nothing the customer can fix: like any failure.
      case 'invalid':
      case 'failed':
        // The page stays as it was, so the same button is one tap away from another try.
        if (action === 'cancel') setCancelError(NETWORK_ERROR_MESSAGE);
        else setNotice({ role: 'alert', text: NETWORK_ERROR_MESSAGE, focus: false });
        return;
    }
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

          {state.order.status === 'pending' && (
            <div className="order-actions">
              {/* aria-disabled, not disabled, while a request is on its way: the button keeps
                  focus and is announced as unavailable; busyRef ignores the extra taps. */}
              <button
                type="button"
                className="button button-primary button-block button-large"
                aria-disabled={busy !== null ? true : undefined}
                onClick={() => void press('confirm', confirmOrder)}
              >
                {busy === 'confirm' ? SENDING_LABEL : CONFIRM_LABEL}
              </button>
              <button
                type="button"
                className="button button-secondary button-block"
                aria-disabled={busy !== null ? true : undefined}
                onClick={() => void press('decline', declineOrder)}
              >
                {busy === 'decline' ? SENDING_LABEL : DECLINE_LABEL}
              </button>
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

          {/* Collected and cancelled are final (spec §4): nothing left to cancel. */}
          {isOpenStatus(state.order.status) && (
            <CancelConfirm
              buttonLabel={CANCEL_ORDER_LABEL}
              question={CANCEL_QUESTION}
              cancelling={busy === 'cancel'}
              error={cancelError}
              onConfirm={() => void press('cancel', cancelOrder)}
              onOpenChange={() => setCancelError(null)}
            />
          )}
        </>
      )}
    </>
  );
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
