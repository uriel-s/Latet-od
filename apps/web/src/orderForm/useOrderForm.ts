// The state of a form built from the order's fields (OrderFields): the values, the errors next to
// each field, and moving focus to the first wrong one. The public booking form (OrderFormPage)
// and Yoel's add and edit screens (spec §3.5) share it, so their fields behave the same way.
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { flushSync } from 'react-dom';
import {
  NO_ERRORS,
  type FormErrors,
  type OrderFormField,
  type OrderFormValues,
} from './formValues.ts';

/** What {@link useOrderForm} returns. */
export interface OrderFormState {
  values: OrderFormValues;
  /** For a value that is not a field shown with an error (the honeypot), or a whole refill. */
  setValues: Dispatch<SetStateAction<OrderFormValues>>;
  errors: FormErrors;
  /** For errors that move no focus: a message above the form, or clearing them all. */
  setErrors: Dispatch<SetStateAction<FormErrors>>;
  /** Changes one field and clears that field's error (only that one: the rest still hold). */
  setField: <F extends OrderFormField>(field: F, value: OrderFormValues[F]) => void;
  /** Goes on the page's `<form>`: {@link OrderFormState.showErrors} looks for fields inside it. */
  formRef: RefObject<HTMLFormElement | null>;
  /** Shows `next`, then moves focus to the first field that has an error, in form order. */
  showErrors: (next: FormErrors) => void;
}

/**
 * The state of an order form. `initialValues` is called once, on the first render (a lazy
 * `useState` initializer): reading saved details or the navigation state happens only then.
 * The form starts with no errors.
 */
export function useOrderForm(initialValues: () => OrderFormValues): OrderFormState {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const formRef = useRef<HTMLFormElement>(null);

  // Stable across renders (they use only setters and the ref), so a screen may list them as
  // effect dependencies.
  const setField = useCallback(
    <F extends OrderFormField>(field: F, value: OrderFormValues[F]): void => {
      setValues((previous) => ({ ...previous, [field]: value }));
      setErrors((previous) =>
        previous.byField[field] === undefined
          ? previous
          : { ...previous, byField: { ...previous.byField, [field]: undefined } },
      );
    },
    [],
  );

  const showErrors = useCallback((next: FormErrors): void => {
    // Rendered first, so the field is focused (and announced) together with its message, and
    // the focus call stays inside the tap's handler, which is what lets iOS open the keyboard.
    flushSync(() => setErrors(next));
    // Every field with an error carries aria-invalid, the street picker's input too: the first
    // one in the document is the first wrong field of the form.
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, []);

  return { values, setValues, errors, setErrors, setField, formRef, showErrors };
}
