// The public booking form at `/` (spec §3.1) and, once the order is in, the thank-you screen in
// its place (spec §3.2). The rules live in the shared schema (formValues.ts), the fields in
// OrderFields.tsx and their state in useOrderForm.ts (both shared with Yoel's add and edit
// screens), the request in api.ts and the returning customer's prefill in savedDetails.ts: this
// file is the screen itself, the parts only the public form has (the honeypot, the privacy line),
// and what happens after each answer.
import { useId, useRef, useState } from 'react';
import {
  DEFAULT_LANG,
  MIN_BOTTLES,
  ORDER_HONEYPOT_FIELD,
  t,
  type CreateOrderRequest,
  type Lang,
} from '@bottlerun/shared';
import { createOrder, networkErrorMessage, type CreateOrderOutcome } from '../api.ts';
import { Link, navigate, useLocation } from '../router.tsx';
import {
  NO_ERRORS,
  emptyOrderFormValues,
  hasEnoughBottles,
  validateOrderForm,
  type OrderFormValues,
} from './formValues.ts';
import { localizedFormErrors } from './formText.ts';
import { OrderFields } from './OrderFields.tsx';
import {
  formValuesFromPrefill,
  loadSavedDetails,
  prefillFromNavigationState,
  saveDetails,
} from './savedDetails.ts';
import { ThankYou } from './ThankYou.tsx';
import { useOrderForm } from './useOrderForm.ts';

/**
 * The values the form opens with. Section 9's "הזמנה חדשה עם אותם פרטים" (the details passed in
 * the navigation state) comes first: the customer just asked for exactly those. Otherwise the
 * details this browser saved after its last order, otherwise a blank form. Never the number of
 * bottles: neither prefill carries it.
 */
function initialFormValues(navigationState: unknown): OrderFormValues {
  const prefill = prefillFromNavigationState(navigationState) ?? loadSavedDetails();
  return prefill === null ? emptyOrderFormValues() : formValuesFromPrefill(prefill);
}

/** Props of {@link OrderFormPage}. */
export interface OrderFormPageProps {
  /**
   * The language of the form: 'he' at `/` (default), 'en' at `/en`. It sets every text, the
   * language of the error messages, and the `lang` sent with the order.
   */
  lang?: Lang;
  /**
   * Sends the validated form. Defaults to {@link createOrder} (POST /api/orders, which owns the
   * one retry on a network error); tests pass a fake that records each request.
   */
  submitOrder?: (request: CreateOrderRequest) => Promise<CreateOrderOutcome>;
}

/**
 * The public booking form page (spec §3.1), and the thank-you screen (spec §3.2) after a
 * successful order. Renders the page's only `<h1>` (Layout's heading rule) on either screen.
 *
 * The form is checked with the shared schema before anything is sent, and every mistake is shown
 * in plain words next to its field, with focus on the first one. Nothing is sent while a field
 * is wrong, or while an earlier request is still on its way: the api counts every request toward
 * its limit of 10 an hour per IP.
 */
export function OrderFormPage({
  lang = DEFAULT_LANG,
  submitOrder = createOrder,
}: OrderFormPageProps) {
  // Where the language button leads: the other language's address (no detection by browser).
  const homePath = lang === 'en' ? '/en' : '/';
  const otherLangPath = lang === 'en' ? '/' : '/en';
  // Under the greyed send button: a button that looks dead with no reason would stump the customer.
  const notEnoughBottlesText = t(lang, 'form.notEnoughBottles', { min: MIN_BOTTLES });
  const { state: navigationState } = useLocation();
  const { values, setValues, errors, setErrors, setField, formRef, showErrors } = useOrderForm(() =>
    initialFormValues(navigationState),
  );
  const [sending, setSending] = useState(false);
  // Set by a successful order: the thank-you screen replaces the form.
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  // The estimate the order was sent with, for the thank-you screen's donation line.
  const [createdBottles, setCreatedBottles] = useState(0);
  // The state above reaches the handler only after a re-render; this ref stops a second tap or
  // Enter that comes before it.
  const sendingRef = useRef(false);
  const honeypotId = useId();
  const notReadyId = useId();
  // Below the minimum the button looks unavailable. It stays tappable: a tap still validates and
  // shows every mistake of the form, and validation sends nothing while the bottles are too few.
  const notReady = !hasEnoughBottles(values.bottlesEstimated);

  if (createdToken !== null)
    return <ThankYou token={createdToken} bottlesEstimated={createdBottles} lang={lang} />;

  async function send(): Promise<void> {
    if (sendingRef.current) return;
    const validation = validateOrderForm(values);
    if (!validation.ok) {
      showErrors(localizedFormErrors(lang, validation.errors));
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setErrors(NO_ERRORS);
    let outcome: CreateOrderOutcome;
    try {
      // `lang` rides with the order: its WhatsApp messages and texts use it later.
      outcome = await submitOrder({ ...validation.request, lang });
    } catch {
      // createOrder never rejects, but a rejection must not leave the button on "שולח..." forever.
      outcome = { kind: 'failed' };
    }
    sendingRef.current = false;
    setSending(false);

    // Every case but `created` keeps what the customer typed: they fix one thing and send again.
    switch (outcome.kind) {
      case 'created':
        saveDetails(outcome.response.order);
        // A reload must show the form filled with the details just saved, not with the older
        // ones section 9 passed in this history entry's state.
        if (prefillFromNavigationState(navigationState) !== null)
          navigate(homePath, { replace: true });
        setCreatedBottles(outcome.response.order.bottlesEstimated);
        setCreatedToken(outcome.response.token);
        return;
      case 'invalid':
        showErrors(localizedFormErrors(lang, outcome.errors));
        return;
      case 'duplicate':
        // Next to the phone, not above the form: the number is what the customer can check.
        showErrors({ byField: { phone: t(lang, 'createOrder.duplicateOpenOrder') } });
        return;
      case 'rateLimited':
        setErrors({ byField: {}, other: t(lang, 'createOrder.rateLimited') });
        return;
      case 'failed':
        setErrors({ byField: {}, other: networkErrorMessage(lang) });
        return;
    }
  }

  return (
    <>
      {/* The big button at the top: a plain link, so it works as a direct address too. */}
      <Link
        to={otherLangPath}
        className="button button-secondary button-block lang-switch"
        // The button is written in the other language, so it is read in it.
        lang={lang === 'en' ? 'he' : 'en'}
      >
        {t(lang, 'form.switchLanguage')}
      </Link>
      <h1>{t(lang, 'form.title')}</h1>
      <p>{t(lang, 'form.intro')}</p>

      {/* noValidate: the browser's own bubbles would show English-shaped messages in the wrong
          place; the form shows its Hebrew messages next to each field instead. */}
      <form
        ref={formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <OrderFields values={values} errors={errors.byField} onFieldChange={setField} lang={lang} />

        {/* The spam trap (spec §7): off-screen and hidden from screen readers, so only a bot
            fills it, and the api then answers with a fake success and stores nothing. So it must
            stay empty for people: out of the tab order, and autoComplete off, because a browser
            or password manager that filled it would silently drop a real customer's order. The
            label stays: bots read labels to decide what to type. */}
        <div className="honeypot" aria-hidden="true">
          <label htmlFor={honeypotId}>{t(lang, 'form.honeypotLabel')}</label>
          <input
            id={honeypotId}
            type="text"
            name={ORDER_HONEYPOT_FIELD}
            value={values.website}
            onChange={(event) => {
              const website = event.target.value;
              setValues((previous) => ({ ...previous, website }));
            }}
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        <p>{t(lang, 'form.privacy')}</p>

        {errors.other && (
          <p className="form-alert" role="alert">
            {errors.other}
          </p>
        )}

        {notReady && !sending && (
          <p id={notReadyId} className="field-hint">
            {notEnoughBottlesText}
          </p>
        )}
        {/* aria-disabled, not disabled, while sending or below the minimum: a disabled button
            drops focus to the page itself, and a keyboard or screen-reader user would lose their
            place; this one keeps focus and is announced as unavailable. sendingRef ignores the
            extra taps while sending, and validation refuses too few bottles. */}
        <button
          type="submit"
          className={`button button-primary button-big button-block${notReady && !sending ? ' button-not-ready' : ''}`}
          aria-disabled={sending || notReady ? true : undefined}
          aria-describedby={notReady && !sending ? notReadyId : undefined}
        >
          {sending ? t(lang, 'form.sending') : t(lang, 'form.submit')}
        </button>
      </form>
    </>
  );
}
