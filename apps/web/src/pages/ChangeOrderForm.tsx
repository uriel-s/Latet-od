import { useId, useLayoutEffect, useRef } from 'react';
import {
  formatDayMonth,
  isLocationChange,
  t,
  type CustomerOrder,
  type CustomerUpdateOrderRequest,
  type Lang,
} from '@bottlerun/shared';
import {
  NO_ERRORS,
  addressPlaceOf,
  validateCustomerChange,
  type FormErrors,
  type OrderFormValues,
} from '../orderForm/formValues.ts';
import { localizedFormErrors } from '../orderForm/formText.ts';
import { OrderFields } from '../orderForm/OrderFields.tsx';
import { formValuesFromPrefill } from '../orderForm/savedDetails.ts';
import { useOrderForm } from '../orderForm/useOrderForm.ts';
import { tWithDay } from './bidiText.tsx';

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
 * While the order is in a round (confirmed) and the street or house number differs
 * from the stored one, a line above the save button says that saving takes the order out of the
 * round (the api's rule, shared `isLocationChange`), before the customer saves.
 */
export function ChangeOrderForm({ order, lang, saving, onSave, onClose }: ChangeOrderFormProps) {
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

  // A confirmed order is in a round; the api takes it out on a new street or house number. The
  // round's date shows when the api sent it.
  const inRound = order.status === 'confirmed';
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
