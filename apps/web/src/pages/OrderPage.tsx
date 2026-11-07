// The customer's own page `/o/<token>` (spec §3.3), reached from the thank-you screen and from the
// links in Yoel's WhatsApp messages, by the order's random token only. It loads the order (api.ts,
// GET /api/o/:token) and draws what fits its status: the round's date and a big "כן, אוציא את הבקבוקים"
// while a confirmation is asked for, "נתראה ב-<תאריך>" once confirmed, thanks and "הזמנה חדשה עם
// אותם פרטים" once collected or cancelled, and, while the order is open, "שינוי" (the booking
// form's fields without the contact: address, note and bottles, never the phone) and "ביטול
// ההזמנה" (with a question first). Every button is a POST or a PATCH, never a link to open:
// WhatsApp's preview opens links. The page always draws the order the api answered with, not what
// it expected the button to do.
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import {
  CUSTOMER_ORDER_MESSAGES,
  DEFAULT_LANG,
  findStreet,
  formatDayMonth,
  formatIsraeliMobileLocal,
  isLocationChange,
  isOpenStatus,
  streetDisplayName,
  t,
  type CustomerOrder,
  type CustomerUpdateOrderRequest,
  type Lang,
  type MessageKey,
} from '@bottlerun/shared';
import {
  cancelCustomerOrder,
  confirmCustomerOrder,
  declineCustomerOrder,
  fetchCustomerOrder,
  networkErrorMessage,
  updateCustomerOrder,
  type CustomerOrderOutcome,
  type CustomerOrderWriteOutcome,
} from '../api.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { CancelConfirm } from '../components/CancelConfirm.tsx';
import {
  NO_ERRORS,
  addressPlaceOf,
  validateCustomerChange,
  type FormErrors,
  type OrderFormValues,
} from '../orderForm/formValues.ts';
import { localizedFormErrors } from '../orderForm/formText.ts';
import { OrderFields } from '../orderForm/OrderFields.tsx';
import { formValuesFromPrefill, orderFormNavigationState } from '../orderForm/savedDetails.ts';
import { useOrderForm } from '../orderForm/useOrderForm.ts';
import { Link, navigate } from '../router.tsx';
import { useDocumentLanguage } from '../useDocumentLanguage.ts';

// The Hebrew texts of the page are exported for tests; they are the dictionary's (i18n.ts,
// 'orderPage.*'), where the English ones live next to them.

/** The page's `<h1>`, the same in every state. */
export const ORDER_PAGE_HEADING = t('he', 'orderPage.heading');

/** Shown when the order got no usable answer (network error, 5xx, unreadable body). */
export const ORDER_LOAD_FAILED_MESSAGE = t('he', 'orderPage.loadFailed');

/** Under the status of a waiting order: what happens next, in the thank-you screen's words. */
export const WAITING_TEXT = t('he', 'orderPage.waiting');

/** Under the status of a collected order. */
export const COLLECTED_TEXT = t('he', 'orderPage.collected');

/**
 * Under the status of a cancelled order: thanks (spec §3.3), and what the button under it does.
 * Not "ההזמנה בוטלה.": the status line already says it, and so does the message announced right
 * after the customer's own cancel.
 */
export const CANCELLED_TEXT = t('he', 'orderPage.cancelled');

/** What each request of the page announces once the api stored it (Hebrew; see {@link savedMessage}). */
export const SAVED_MESSAGES = {
  confirm: t('he', 'orderPage.saved.confirm'),
  decline: t('he', 'orderPage.saved.decline'),
  cancel: t('he', 'orderPage.saved.cancel'),
  change: t('he', 'orderPage.saved.change'),
} as const;

/**
 * Announced instead of {@link SAVED_MESSAGES}.change when a new street or house number took the
 * order out of its round (spec §3.3: "שינוי כתובת אחרי שההזמנה נכנסה לסבב מוציא אותה מהסבב").
 */
export const LEFT_ROUND_MESSAGE = t('he', 'orderPage.leftRound');

/** Above the change form's fields: why the phone is not among them (spec §3.3). */
export const PHONE_NOT_CHANGED_TEXT = t('he', 'orderPage.phoneNotChanged');

/** The text of what `action` announces once saved, in `lang`. */
function savedMessage(lang: Lang, action: keyof typeof SAVED_MESSAGES): string {
  return t(lang, `orderPage.saved.${action}`);
}

/**
 * The api's Hebrew refusal ("the order closed meanwhile") in `lang`; any other text is returned
 * as it is.
 */
function closedMessageText(lang: Lang, message: string): string {
  if (message === CUSTOMER_ORDER_MESSAGES.confirmationsClosed)
    return t(lang, 'customerOrder.confirmationsClosed');
  if (message === CUSTOMER_ORDER_MESSAGES.orderClosed) return t(lang, 'customerOrder.orderClosed');
  if (message === CUSTOMER_ORDER_MESSAGES.orderNotFound)
    return t(lang, 'customerOrder.orderNotFound');
  return message;
}

/**
 * `text` (from t(), written with a `{date}` placeholder) with the day set in a left-to-right
 * `<bdi>`: DD/MM and "Nov 12" read left to right inside right-to-left text (CLAUDE.md).
 */
function withDay(text: string, day: string): ReactNode {
  const [before = '', after = ''] = text.split(DAY_PLACEHOLDER);
  return (
    <>
      {before}
      <bdi dir="ltr">{day}</bdi>
      {after}
    </>
  );
}

/** A `{date}` that t() leaves as it is when passed as its own value. */
const DAY_PLACEHOLDER = '{date}';

/** {@link t} with `{date}` left in the text, for {@link withDay}. */
function tWithDay(lang: Lang, key: MessageKey, day: string): ReactNode {
  return withDay(t(lang, key, { date: DAY_PLACEHOLDER }), day);
}

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
  /**
   * Told the language of the order once it is known (Hebrew until then), so the app's frame
   * (the slogan in the header) speaks it too. The page sets the document's own language.
   */
  onLangChange?: (lang: Lang) => void;
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
  onLangChange,
}: OrderPageProps) {
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  // The order's language, kept while the order reloads (a reload must not flash Hebrew). Hebrew
  // until the first order arrives, and for a missing order.
  const [lang, setLang] = useState<Lang>(DEFAULT_LANG);
  useDocumentLanguage(lang);
  useEffect(() => {
    onLangChange?.(lang);
    return () => onLangChange?.(DEFAULT_LANG);
  }, [lang, onLangChange]);
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
          showOrder(outcome.order);
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

  /** Draws `order` and switches the page to its language. */
  function showOrder(order: CustomerOrder): void {
    setLang(order.lang);
    setState({ kind: 'loaded', order });
  }

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
        showOrder(outcome.order);
        setNotice({ role: 'status', text: savedMessage(lang, action), focus: true });
        return;
      case 'closed':
        showClosed(closedMessageText(lang, outcome.message));
        return;
      case 'notFound':
        setState({ kind: 'notFound' });
        return;
      // A button sends no body, so a 400 is nothing the customer can fix: like any failure.
      case 'invalid':
      case 'failed':
        // The page stays as it was, so the same button is one tap away from another try.
        if (action === 'cancel') setCancelError(networkErrorMessage(lang));
        else if (action === 'decline') setDeclineError(networkErrorMessage(lang));
        else setNotice({ role: 'alert', text: networkErrorMessage(lang), focus: false });
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
        showOrder(outcome.order);
        setNotice({
          role: 'status',
          text: leftRound ? t(lang, 'orderPage.leftRound') : savedMessage(lang, 'change'),
          focus: true,
        });
        return null;
      }
      case 'closed':
        showClosed(closedMessageText(lang, outcome.message));
        return null;
      case 'notFound':
        setChanging(false);
        setState({ kind: 'notFound' });
        return null;
      case 'invalid':
        // Next to the fields the api named; a 400 with none (a body refused as a whole) is
        // already UNKNOWN_FIELD_ERROR in `other`, above the save button.
        return localizedFormErrors(lang, outcome.errors);
      case 'failed':
        // Nothing is retried on its own: the change may have arrived. Saving again is harmless.
        return { byField: {}, other: t(lang, 'orderPage.saveFailed') };
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
      <h1>{t(lang, 'orderPage.heading')}</h1>

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

      {state.kind === 'loading' && <p role="status">{t(lang, 'orderPage.loading')}</p>}

      {state.kind === 'failed' && (
        <>
          <p className="form-alert" role="alert">
            {t(lang, 'orderPage.loadFailed')}
          </p>
          <button type="button" className="button button-primary button-block" onClick={reload}>
            {t(lang, 'orderPage.retry')}
          </button>
        </>
      )}

      {state.kind === 'notFound' && (
        <>
          <p className="form-alert" role="alert">
            {t(lang, 'customerOrder.orderNotFound')}
          </p>
          <Link to="/" className="button button-primary button-block">
            {t(lang, 'orderPage.toForm')}
          </Link>
        </>
      )}

      {state.kind === 'loaded' && (
        <>
          <OrderStatus order={state.order} lang={lang} />

          {/* Only an open order can change (spec §3.3); a collected or cancelled one never
              shows the form, even if it closed while the form was open. */}
          {changing && isOpenStatus(state.order.status) ? (
            <ChangeOrderForm
              order={state.order}
              lang={lang}
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
                      t(lang, 'orderPage.sending')
                    ) : (
                      <ConfirmLabel round={state.order.round} lang={lang} />
                    )}
                  </button>
                  <CancelConfirm
                    inline
                    // "Not this time" only sends the order back to waiting: nothing red about it.
                    buttonTone="secondary"
                    buttonLabel={t(lang, 'orderPage.decline')}
                    question={t(lang, 'orderPage.declineQuestion')}
                    confirmLabel={t(lang, 'orderPage.declineConfirm')}
                    busyLabel={t(lang, 'orderPage.sending')}
                    keepLabel={t(lang, 'orderPage.keep')}
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
                  onClick={() => startNewOrder(state.order, lang)}
                >
                  {t(lang, 'orderPage.newOrder')}
                </button>
              )}

              <OrderDetails order={state.order} lang={lang} />

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
                    {t(lang, 'orderPage.change')}
                  </button>
                  <CancelConfirm
                    buttonLabel={t(lang, 'orderPage.cancelOrder')}
                    question={t(lang, 'orderPage.cancelQuestion')}
                    confirmLabel={t(lang, 'orderPage.cancelYes')}
                    busyLabel={t(lang, 'orderPage.cancelling')}
                    keepLabel={t(lang, 'orderPage.keep')}
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
  /** The order's language: the form speaks it. */
  lang: Lang;
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
function ChangeOrderForm({ order, lang, saving, onSave, onClose }: ChangeOrderFormProps) {
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
      showErrors(localizedFormErrors(lang, validation.errors));
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
        {t(lang, 'orderPage.changeHeading')}
      </h2>
      <p>{t(lang, 'orderPage.phoneNotChanged')}</p>

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
          lang={lang}
        />

        {leavesRound && (
          <p id={warningId} className="order-change-warning">
            {order.round === undefined
              ? t(lang, 'orderPage.leavesRound')
              : tWithDay(lang, 'orderPage.leavesRoundDate', formatDayMonth(order.round.date, lang))}
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
            {saving ? t(lang, 'orderPage.saving') : t(lang, 'orderPage.saveChange')}
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
            {t(lang, 'orderPage.keepAsIs')}
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
function startNewOrder(order: CustomerOrder, lang: Lang): void {
  // The booking form of the order's own language; the page itself has no language switch.
  navigate(lang === 'en' ? '/en' : '/', {
    state: orderFormNavigationState({ contact: order.contact, address: order.address }),
  });
}

/**
 * The confirm button's text: what is confirmed, and on which day. DD/MM reads left to right inside
 * the right-to-left text (CLAUDE.md). A pending order whose round the api did not send gets the
 * text without a day.
 */
function ConfirmLabel({ round, lang }: { round: CustomerOrder['round']; lang: Lang }) {
  if (round === undefined) return t(lang, 'orderPage.confirm');
  return tWithDay(lang, 'orderPage.confirmDate', formatDayMonth(round.date, lang));
}

/**
 * The status in plain words, and what it means for the customer now (spec §3.3): one card at the
 * top of the page, the status as a large badge and the sentence that explains it under it, so the
 * customer reads both together (design run 6, section 4).
 */
function OrderStatus({ order, lang }: { order: CustomerOrder; lang: Lang }) {
  return (
    <div className="order-status-card card">
      <p className="order-status">
        {t(lang, 'orderPage.status')} <StatusBadge status={order.status} lang={lang} />
      </p>
      <StatusText order={order} lang={lang} />
    </div>
  );
}

/**
 * The lines under the status. The round's date shows for a pending or confirmed order only, and
 * only when the api sent it: an order whose round is gone has no date to promise.
 */
function StatusText({ order, lang }: { order: CustomerOrder; lang: Lang }) {
  const { round } = order;
  switch (order.status) {
    case 'waiting':
      return <p>{t(lang, 'orderPage.waiting')}</p>;
    case 'pending':
    case 'confirmed':
      if (round === undefined) return null;
      return (
        <>
          <p>
            {/* DD/MM and HH:MM read left to right inside the right-to-left text (CLAUDE.md). */}
            {tWithDay(
              lang,
              order.status === 'pending' ? 'orderPage.pendingDate' : 'orderPage.confirmedDate',
              formatDayMonth(round.date, lang),
            )}
          </p>
          {round.pickupBy !== undefined && (
            <p>
              {round.pickupFrom !== undefined
                ? timesText(t(lang, 'orderPage.pickupWindow', TIME_PLACEHOLDERS), [
                    round.pickupFrom,
                    round.pickupBy,
                  ])
                : timesText(t(lang, 'orderPage.pickupBy', TIME_PLACEHOLDERS), [round.pickupBy])}
            </p>
          )}
        </>
      );
    case 'collected':
      return <p>{t(lang, 'orderPage.collected')}</p>;
    case 'cancelled':
      return <p>{t(lang, 'orderPage.cancelled')}</p>;
  }
}

/** `{from}` and `{by}` left in the text by t(), for {@link timesText} to fill. */
const TIME_PLACEHOLDERS = { from: '{from}', by: '{by}' } as const;

/** `text` with each time (in the order they appear) set in a left-to-right `<bdi>`. */
function timesText(text: string, times: readonly string[]): ReactNode {
  const parts = text.split(/\{(?:from|by)\}/);
  return parts.map((part, index) => (
    // The parts never reorder, so the index is a stable key.
    <Fragment key={index}>
      {part}
      {index < times.length && <bdi dir="ltr">{times[index]}</bdi>}
    </Fragment>
  ));
}

/**
 * The order's details as the customer gave them: only what the api sent, which is the order's
 * own (no id, no region, nothing of another customer). Drawn as settings-style rows: each
 * name/value pair in its own `<div>` inside the `<dl>` (valid HTML), so CSS can lay out a row
 * with the name at the start, the value at the end and a line between rows.
 */
function OrderDetails({ order, lang }: { order: CustomerOrder; lang: Lang }) {
  const headingId = useId();
  const { contact, address } = order;
  // Where at the address: the spot in the form's words, then the floor and apartment if given.
  const spot = [t(lang, `bottlesSpot.${address.bottlesSpot}`), address.floorApt]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');
  // A listed street reads in the page's language; a hand-written one stays as the customer typed it.
  const listedStreet =
    address.streetCode === undefined ? undefined : findStreet(address.streetCode);
  const streetName =
    listedStreet === undefined ? address.streetName : streetDisplayName(listedStreet, lang);

  return (
    <section className="order-details card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t(lang, 'orderPage.details')}</h2>
      <dl>
        <DetailRow label={t(lang, 'orderPage.detailName')}>{contact.name}</DetailRow>
        <DetailRow label={t(lang, 'orderPage.detailPhone')}>
          {/* Digits and hyphens read left to right inside the right-to-left text (CLAUDE.md). */}
          <bdi dir="ltr">{formatIsraeliMobileLocal(contact.phone)}</bdi>
        </DetailRow>
        <DetailRow label={t(lang, 'orderPage.detailAddress')}>
          {streetName} {address.houseNumber}
        </DetailRow>
        <DetailRow label={t(lang, 'orderPage.detailSpot')}>{spot}</DetailRow>
        {address.note !== undefined && address.note !== '' && (
          <DetailRow label={t(lang, 'orderPage.detailNote')}>{address.note}</DetailRow>
        )}
        <DetailRow label={t(lang, 'orderPage.detailBottles')}>{order.bottlesEstimated}</DetailRow>
      </dl>
    </section>
  );
}

/** One row of {@link OrderDetails}: the detail's name (`dt`) and its value (`dd`). */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="order-detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
