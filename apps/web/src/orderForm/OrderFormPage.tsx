// The public booking form at `/` (spec §3.1) and, once the order is in, the thank-you screen in
// its place (spec §3.2). The rules live in the shared schema (formValues.ts), the fields in
// OrderFields.tsx and their state in useOrderForm.ts (both shared with Yoel's add and edit
// screens), the request in api.ts and the returning customer's prefill in savedDetails.ts: this
// file is the screen itself, the parts only the public form has (the honeypot, the privacy line),
// and what happens after each answer.
import { useEffect, useId, useRef, useState } from 'react';
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
import { RulesNotice } from './RulesNotice.tsx';
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
 * The public booking form page (spec §3.1), preceded by the rules notice, and followed by the
 * thank-you screen (spec §3.2) after a successful order. Renders the page's only `<h1>` (Layout's
 * heading rule) on each of the three screens.
 *
 * The notice comes first on EVERY entry, also when the form opens filled in from "order again with
 * the same details", and nothing remembers that it was read: the rules reach everyone, and a
 * stored flag would be one more thing to go stale.
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
  // Plain component state, not storage: false on every visit (see the doc comment above).
  const [noticeAccepted, setNoticeAccepted] = useState(false);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  // Set by a successful order: the thank-you screen replaces the form.
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  // The state above reaches the handler only after a re-render; this ref stops a second tap or
  // Enter that comes before it.
  const sendingRef = useRef(false);
  const honeypotId = useId();
  const notReadyId = useId();
  // Below the minimum the button looks unavailable. It stays tappable: a tap still validates and
  // shows every mistake of the form, and validation sends nothing while the bottles are too few.
  const notReady = !hasEnoughBottles(values.bottlesEstimated);

  // The notice's button is gone when the form replaces it, and focus would fall back to the page.
  // Moving it to the form's heading announces the form and scrolls the phone to the top (the
  // heading is what ThankYou focuses too). Not on a first render: only once the notice is accepted.
  useEffect(() => {
    if (noticeAccepted) formHeadingRef.current?.focus();
  }, [noticeAccepted]);

  // The big button at the top: a plain link, so it works as a direct address too. It stays on the
  // notice as well, so someone who lands on the wrong language can switch before reading on.
  const languageSwitch = (
    <Link
      to={otherLangPath}
      className="button button-secondary button-block lang-switch"
      // The button is written in the other language, so it is read in it.
      lang={lang === 'en' ? 'he' : 'en'}
    >
      {t(lang, 'form.switchLanguage')}
    </Link>
  );

  if (createdToken !== null) return <ThankYou token={createdToken} lang={lang} />;

  if (!noticeAccepted) {
    return (
      <>
        {languageSwitch}
        <RulesNotice lang={lang} onAccept={() => setNoticeAccepted(true)} />
      </>
    );
  }

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
      {languageSwitch}
      {/* tabIndex -1: focusable from code (see the effect above), not a stop when tabbing. */}
      <h1 ref={formHeadingRef} tabIndex={-1}>
        {t(lang, 'form.title')}
      </h1>
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
