// "הוספת הזמנה" in the collector app (spec §3.5), at /app/orders/new: Yoel books for a customer who
// phoned. The same form and the same rules as the public booking form (OrderFields, checked with
// validateOrderDetails), without the parts only the public form has: no honeypot (the route is
// behind the login) and no privacy line. The api stores the order with `source: 'collector'`.
import { useEffect, useRef, useState } from 'react';
import type { AddOrderRequest } from '@bottlerun/shared';
import { addCollectorOrder, type CollectorOrderWriteOutcome } from '../api.ts';
import { NO_ERRORS, emptyOrderFormValues, validateOrderDetails } from '../orderForm/formValues.ts';
import { OrderFields } from '../orderForm/OrderFields.tsx';
import { useOrderForm } from '../orderForm/useOrderForm.ts';
import { Link, navigate } from '../router.tsx';
import { FLASH_NOTICES, flashNoticeState } from './flashNotice.ts';
import { ORDERS_LIST_PATH, saveErrors } from './orderEditing.ts';

const SAVE_LABEL = 'שמירת ההזמנה';
const SAVING_LABEL = 'שומר...';

/** Props of {@link AddOrderScreen}. */
export interface AddOrderScreenProps {
  /** Sends the new order. Defaults to {@link addCollectorOrder}; tests pass a fake. */
  addOrder?: (request: AddOrderRequest) => Promise<CollectorOrderWriteOutcome>;
}

/**
 * The add screen. Renders the page's only `<h1>` (Layout's heading rule), a way back to the list,
 * and a blank booking form. Every mistake shows next to its field before anything is sent; a saved
 * order returns to the list, where it now waits in its region's group.
 */
export function AddOrderScreen({ addOrder = addCollectorOrder }: AddOrderScreenProps) {
  const { values, errors, setErrors, setField, formRef, showErrors } =
    useOrderForm(emptyOrderFormValues);
  const [saving, setSaving] = useState(false);
  // The state above reaches the handler only after a re-render; this ref stops a second tap or
  // Enter that comes before it, so one phone call does not add two orders.
  const savingRef = useRef(false);
  // False once the screen is gone: an answer that comes after Yoel left (the bottom navigation)
  // must not pull him back to the list, or to the login, from the screen he went to.
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function save(): Promise<void> {
    if (savingRef.current) return;
    const validation = validateOrderDetails(values);
    if (!validation.ok) {
      showErrors(validation.errors);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setErrors(NO_ERRORS);
    let outcome: CollectorOrderWriteOutcome;
    try {
      outcome = await addOrder(validation.request);
    } catch {
      // addCollectorOrder never rejects, but a rejection must not leave the button on "שומר...".
      outcome = { kind: 'failed' };
    }
    savingRef.current = false;
    if (!mountedRef.current) return;
    setSaving(false);

    switch (outcome.kind) {
      case 'saved':
        // Replace, not push: "back" from the list must not reopen a form already sent, whose
        // second save would only answer that the phone has an open order.
        navigate(ORDERS_LIST_PATH, {
          replace: true,
          state: flashNoticeState(FLASH_NOTICES.orderAdded),
        });
        return;
      case 'loggedOut':
        navigate('/login', { replace: true });
        return;
      default:
        showErrors(saveErrors(outcome));
        return;
    }
  }

  return (
    <>
      <h1>הוספת הזמנה</h1>
      <Link to={ORDERS_LIST_PATH} className="back-link">
        חזרה להזמנות
      </Link>

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

        {errors.other && (
          <p className="form-alert" role="alert">
            {errors.other}
          </p>
        )}

        {/* aria-disabled, not disabled, while saving: the button keeps focus and is announced
            as unavailable; savingRef ignores the extra taps. */}
        <button
          type="submit"
          className="button button-primary button-block"
          aria-disabled={saving ? true : undefined}
        >
          {saving ? SAVING_LABEL : SAVE_LABEL}
        </button>
      </form>
    </>
  );
}
