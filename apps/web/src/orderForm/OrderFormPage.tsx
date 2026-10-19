// The public booking form at `/` (spec §3.1) and, once the order is in, the thank-you screen in
// its place (spec §3.2). The rules live in the shared schema (formValues.ts), the request in
// api.ts and the returning customer's prefill in savedDetails.ts: this file is the screen itself,
// its state, and where focus goes after each answer.
import { useId, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  BOTTLES_SPOT_LABELS,
  FORM_TEXT_MAX_LENGTH,
  MIN_BOTTLES,
  ORDER_HONEYPOT_FIELD,
  bottlesSpotSchema,
  type CreateOrderRequest,
} from '@bottlerun/shared';
import { NETWORK_ERROR_MESSAGE, createOrder, type CreateOrderOutcome } from '../api.ts';
import { navigate, useLocation } from '../router.tsx';
import { StreetPicker } from '../streetPicker/StreetPicker.tsx';
import {
  emptyOrderFormValues,
  validateOrderForm,
  type FormErrors,
  type OrderFormField,
  type OrderFormValues,
} from './formValues.ts';
import {
  formValuesFromPrefill,
  loadSavedDetails,
  prefillFromNavigationState,
  saveDetails,
} from './savedDetails.ts';
import { ThankYou } from './ThankYou.tsx';

const SUBMIT_LABEL = 'שליחת הזמנה';
const SENDING_LABEL = 'שולח...';

/** No error anywhere: the form as it opens, and while a request is on its way. */
const NO_ERRORS: FormErrors = { byField: {} };

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

/** The ids for `aria-describedby`, space-separated; undefined when there is none. */
function describedBy(...ids: (string | undefined)[]): string | undefined {
  const present = ids.filter((id) => id !== undefined);
  return present.length === 0 ? undefined : present.join(' ');
}

/** Props of {@link OrderFormPage}. */
export interface OrderFormPageProps {
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
export function OrderFormPage({ submitOrder = createOrder }: OrderFormPageProps) {
  const { state: navigationState } = useLocation();
  const [values, setValues] = useState(() => initialFormValues(navigationState));
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [sending, setSending] = useState(false);
  // Set by a successful order: the thank-you screen replaces the form.
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  // The state above reaches the handler only after a re-render; this ref stops a second tap or
  // Enter that comes before it.
  const sendingRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const spotGroupName = useId();
  const spotErrorId = useId();
  const honeypotId = useId();

  if (createdToken !== null) return <ThankYou token={createdToken} />;

  /** Changes one field and clears that field's error (only that one: the rest still hold). */
  function setField<F extends OrderFormField>(field: F, value: OrderFormValues[F]): void {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) =>
      previous.byField[field] === undefined
        ? previous
        : { ...previous, byField: { ...previous.byField, [field]: undefined } },
    );
  }

  /** Shows `nextErrors`, then moves focus to the first field that has one, in form order. */
  function showErrors(nextErrors: FormErrors): void {
    // Rendered first, so the field is focused (and announced) together with its message, and
    // the focus call stays inside the tap's handler, which is what lets iOS open the keyboard.
    flushSync(() => setErrors(nextErrors));
    // Every field with an error carries aria-invalid, the street picker's input too: the first
    // one in the document is the first wrong field of the form.
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }

  async function send(): Promise<void> {
    if (sendingRef.current) return;
    const validation = validateOrderForm(values);
    if (!validation.ok) {
      showErrors(validation.errors);
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setErrors(NO_ERRORS);
    let outcome: CreateOrderOutcome;
    try {
      outcome = await submitOrder(validation.request);
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
        if (prefillFromNavigationState(navigationState) !== null) navigate('/', { replace: true });
        setCreatedToken(outcome.response.token);
        return;
      case 'invalid':
        showErrors(outcome.errors);
        return;
      case 'duplicate':
        // Next to the phone, not above the form: the number is what the customer can check.
        showErrors({ byField: { phone: outcome.message } });
        return;
      case 'rateLimited':
        setErrors({ byField: {}, other: outcome.message });
        return;
      case 'failed':
        setErrors({ byField: {}, other: NETWORK_ERROR_MESSAGE });
        return;
    }
  }

  const spotError = errors.byField.bottlesSpot;

  return (
    <>
      <h1>הזמנת איסוף בקבוקים</h1>
      <p>ממלאים את הפרטים, ויואל יבוא לאסוף את הבקבוקים.</p>

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
        <TextField
          label="שם"
          value={values.name}
          onChange={(name) => setField('name', name)}
          error={errors.byField.name}
          autoComplete="name"
          maxLength={FORM_TEXT_MAX_LENGTH.name}
        />

        <TextField
          label="טלפון נייד"
          type="tel"
          digits
          value={values.phone}
          onChange={(phone) => setField('phone', phone)}
          error={errors.byField.phone}
          hint={
            <>
              למשל <bdi dir="ltr">050-1234567</bdi>
            </>
          }
          autoComplete="tel"
        />

        {/* The picker reads `value` once, when it mounts. The prefill exists before the first
            render, so the saved street shows without a remount `key`. */}
        <StreetPicker
          label="רחוב"
          value={values.street}
          onChange={(street) => setField('street', street)}
          error={errors.byField.street}
        />

        <TextField
          // Not numeric: a house number may carry a letter ("12א").
          label="מספר בית"
          value={values.houseNumber}
          onChange={(houseNumber) => setField('houseNumber', houseNumber)}
          error={errors.byField.houseNumber}
          // The street is a custom picker the browser cannot fill, so its address autofill would
          // put a whole "street and number" line here, which the house number then rejects.
          autoComplete="off"
          maxLength={FORM_TEXT_MAX_LENGTH.houseNumber}
        />

        <fieldset className="field" aria-describedby={spotError ? spotErrorId : undefined}>
          <legend className="field-label">איפה הבקבוקים</legend>
          <div className="choice-list">
            {bottlesSpotSchema.options.map((spot) => (
              <label key={spot} className="choice">
                <input
                  type="radio"
                  name={spotGroupName}
                  value={spot}
                  checked={values.bottlesSpot === spot}
                  onChange={() => setField('bottlesSpot', spot)}
                  aria-invalid={spotError ? true : undefined}
                />
                {BOTTLES_SPOT_LABELS[spot]}
              </label>
            ))}
          </div>
          {spotError && (
            <p id={spotErrorId} className="field-error">
              {spotError}
            </p>
          )}
        </fieldset>

        {/* Only the apartment door needs a floor and apartment (Yoel goes up). When hidden, the
            value stays in state but is not sent (validateOrderForm). */}
        {values.bottlesSpot === 'apartmentDoor' && (
          <TextField
            label="קומה ודירה"
            value={values.floorApt}
            onChange={(floorApt) => setField('floorApt', floorApt)}
            error={errors.byField.floorApt}
            hint="למשל: כניסה ב', קומה 3, דירה 12"
            autoComplete="off"
            maxLength={FORM_TEXT_MAX_LENGTH.floorApt}
          />
        )}

        <TextField
          label="הערה (לא חובה)"
          value={values.note}
          onChange={(note) => setField('note', note)}
          error={errors.byField.note}
          hint="למשל: ליד השער, קוד לבניין"
          autoComplete="off"
          maxLength={FORM_TEXT_MAX_LENGTH.note}
        />

        <TextField
          label="כמות בקבוקים"
          digits
          value={values.bottlesEstimated}
          onChange={(bottlesEstimated) => setField('bottlesEstimated', bottlesEstimated)}
          error={errors.byField.bottlesEstimated}
          hint={`לפחות ${MIN_BOTTLES} בקבוקים`}
          autoComplete="off"
        />

        {/* The spam trap (spec §7): off-screen and hidden from screen readers, so only a bot
            fills it, and the api then answers with a fake success and stores nothing. So it must
            stay empty for people: out of the tab order, and autoComplete off, because a browser
            or password manager that filled it would silently drop a real customer's order. The
            label stays: bots read labels to decide what to type. */}
        <div className="honeypot" aria-hidden="true">
          <label htmlFor={honeypotId}>אתר אינטרנט</label>
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

        <p>הפרטים משמשים רק לתיאום האיסוף</p>

        {errors.other && (
          <p className="form-alert" role="alert">
            {errors.other}
          </p>
        )}

        {/* aria-disabled, not disabled, while sending: a disabled button drops focus to the
            page itself, and a keyboard or screen-reader user would lose their place; this one
            keeps focus and is announced as unavailable. sendingRef ignores the extra taps. */}
        <button
          type="submit"
          className="button button-primary button-block"
          aria-disabled={sending ? true : undefined}
        >
          {sending ? SENDING_LABEL : SUBMIT_LABEL}
        </button>
      </form>
    </>
  );
}

/** Props of {@link TextField}. */
interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Plain-Hebrew message shown under the input; the input is then marked invalid. */
  error: string | undefined;
  /** A short example or rule shown between the label and the input. */
  hint?: ReactNode;
  autoComplete: string;
  maxLength?: number;
  /** 'tel' for the phone: phones offer their own number. */
  type?: 'text' | 'tel';
  /**
   * Digits (phone, number of bottles): the phone opens its numeric keyboard, and the digits read
   * left to right inside the right-to-left page (CLAUDE.md).
   */
  digits?: boolean;
}

/**
 * One text field of the form: a visible label, an optional hint, the input, and its error next
 * to it. The hint and the error are linked to the input with aria-describedby, so a screen
 * reader reads them with the field.
 */
function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  autoComplete,
  maxLength,
  type = 'text',
  digits = false,
}: TextFieldProps) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const hasHint = hint !== undefined;

  return (
    <div className="field">
      <label htmlFor={inputId} className="field-label">
        {label}
      </label>
      {hasHint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      <input
        id={inputId}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        maxLength={maxLength}
        inputMode={digits ? 'numeric' : undefined}
        dir={digits ? 'ltr' : undefined}
        className={digits ? 'ltr' : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hasHint ? hintId : undefined, error ? errorId : undefined)}
      />
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
