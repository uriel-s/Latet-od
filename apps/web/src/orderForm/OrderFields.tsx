// The order's fields (spec §3.1): contact, address, where the bottles wait, and how many. The
// public booking form (OrderFormPage) renders them, and so do Yoel's add and edit screens (spec
// §3.5: the same form), so all three ask the same questions in the same words. The page owns the
// <form>, its state (useOrderForm), the honeypot and the submit button.
import { useId } from 'react';
import {
  BOTTLES_SPOT_LABELS,
  FORM_TEXT_MAX_LENGTH,
  MIN_BOTTLES,
  bottlesSpotSchema,
} from '@bottlerun/shared';
import { TextField } from '../components/TextField.tsx';
import { StreetPicker } from '../streetPicker/StreetPicker.tsx';
import type { FormErrors, OrderFormField, OrderFormValues } from './formValues.ts';

/** Props of {@link OrderFields}. */
export interface OrderFieldsProps {
  values: OrderFormValues;
  /** The message to show next to each field; a field with one is marked aria-invalid. */
  errors: FormErrors['byField'];
  /** Called with the field and its new value on every change; useOrderForm's `setField`. */
  onFieldChange: <F extends OrderFormField>(field: F, value: OrderFormValues[F]) => void;
}

/**
 * The order's fields, in form order: שם, טלפון נייד, רחוב, מספר בית, איפה הבקבוקים, קומה ודירה
 * (only for the apartment door), הערה, כמות בקבוקים. A fragment, to be placed inside the page's
 * `<form>`. Every field shows its error next to it and carries aria-invalid while it has one,
 * which is how useOrderForm's `showErrors` finds the first wrong field.
 *
 * The street picker reads `values.street` once, when it mounts: give OrderFields its values
 * before the first render (a saved prefill, a loaded order), or remount it with a new `key` to
 * refill it.
 */
export function OrderFields({ values, errors, onFieldChange }: OrderFieldsProps) {
  const spotGroupName = useId();
  const spotErrorId = useId();
  const spotError = errors.bottlesSpot;

  return (
    <>
      <TextField
        label="שם"
        value={values.name}
        onChange={(name) => onFieldChange('name', name)}
        error={errors.name}
        autoComplete="name"
        maxLength={FORM_TEXT_MAX_LENGTH.name}
      />

      <TextField
        label="טלפון נייד"
        type="tel"
        digits
        value={values.phone}
        onChange={(phone) => onFieldChange('phone', phone)}
        error={errors.phone}
        hint={
          <>
            למשל <bdi dir="ltr">050-1234567</bdi>
          </>
        }
        autoComplete="tel"
      />

      {/* The picker reads `value` once, when it mounts. A prefill exists before the first
          render, so the saved street shows without a remount `key`. */}
      <StreetPicker
        label="רחוב"
        value={values.street}
        onChange={(street) => onFieldChange('street', street)}
        error={errors.street}
      />

      <TextField
        // Not numeric: a house number may carry a letter ("12א").
        label="מספר בית"
        value={values.houseNumber}
        onChange={(houseNumber) => onFieldChange('houseNumber', houseNumber)}
        error={errors.houseNumber}
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
                onChange={() => onFieldChange('bottlesSpot', spot)}
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
          value stays in state but is not sent (validateOrderDetails). */}
      {values.bottlesSpot === 'apartmentDoor' && (
        <TextField
          label="קומה ודירה"
          value={values.floorApt}
          onChange={(floorApt) => onFieldChange('floorApt', floorApt)}
          error={errors.floorApt}
          hint="למשל: כניסה ב', קומה 3, דירה 12"
          autoComplete="off"
          maxLength={FORM_TEXT_MAX_LENGTH.floorApt}
        />
      )}

      <TextField
        label="הערה (לא חובה)"
        value={values.note}
        onChange={(note) => onFieldChange('note', note)}
        error={errors.note}
        hint="למשל: ליד השער, קוד לבניין"
        autoComplete="off"
        maxLength={FORM_TEXT_MAX_LENGTH.note}
      />

      <TextField
        label="כמות בקבוקים"
        digits
        value={values.bottlesEstimated}
        onChange={(bottlesEstimated) => onFieldChange('bottlesEstimated', bottlesEstimated)}
        error={errors.bottlesEstimated}
        hint={`לפחות ${MIN_BOTTLES} בקבוקים`}
        autoComplete="off"
      />
    </>
  );
}
