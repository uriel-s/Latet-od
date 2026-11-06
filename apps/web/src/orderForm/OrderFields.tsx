// The order's fields (spec §3.1): contact, address, where the bottles wait, and how many. The
// public booking form (OrderFormPage) renders them, and so do Yoel's add and edit screens (spec
// §3.5: the same form) and the customer's "שינוי" on their own page (spec §3.3, without the
// contact), so all of them ask the same questions in the same words. The page owns the <form>,
// its state (useOrderForm), the honeypot and the submit button.
import { useId, type ReactNode } from 'react';
import {
  DEFAULT_LANG,
  FORM_TEXT_MAX_LENGTH,
  MIN_BOTTLES,
  bottlesSpotSchema,
  t,
  type Lang,
} from '@bottlerun/shared';
import { Icon, type IconName } from '../components/Icon.tsx';
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
  /**
   * Show the name and phone fields. Default true. The customer's "שינוי" passes false: the phone
   * keeps one open order per phone and cannot be changed there (spec §3.3), and neither can the
   * name, so neither field is offered.
   */
  showContact?: boolean;
  /**
   * The language of labels, hints and answers. Default Hebrew; the English booking form passes
   * 'en'. Error messages arrive already in the right language (`errors`).
   */
  lang?: Lang;
  /**
   * More cards to show between the address and the bottles, such as Yoel's "מיקום" card on the
   * edit screen (רחוב קרוב, אזור): they belong with the address, and the form keeps one level of
   * cards. Wrap each one in {@link FormCard}.
   */
  afterAddress?: ReactNode;
}

/**
 * The order's fields, in form order: שם and טלפון נייד (unless `showContact` is false), רחוב,
 * מספר בית, איפה הבקבוקים, קומה ודירה (only for the apartment door), כמות בקבוקים, הערה, in three titled cards (פרטים, כתובת, בקבוקים), with any `afterAddress` cards before בקבוקים. A
 * fragment, to be placed inside the page's `<form>`. Every field shows its error next to it and carries aria-invalid while it has one,
 * which is how useOrderForm's `showErrors` finds the first wrong field.
 *
 * The street picker reads `values.street` once, when it mounts: give OrderFields its values
 * before the first render (a saved prefill, a loaded order), or remount it with a new `key` to
 * refill it.
 */
export function OrderFields({
  values,
  errors,
  onFieldChange,
  showContact = true,
  lang = DEFAULT_LANG,
  afterAddress,
}: OrderFieldsProps) {
  const spotGroupName = useId();
  const spotErrorId = useId();
  const spotError = errors.bottlesSpot;

  return (
    <>
      {showContact && (
        <FormCard title={t(lang, 'form.sectionDetails')}>
          <TextField
            label={t(lang, 'form.name')}
            value={values.name}
            onChange={(name) => onFieldChange('name', name)}
            error={errors.name}
            autoComplete="name"
            maxLength={FORM_TEXT_MAX_LENGTH.name}
          />

          <TextField
            label={t(lang, 'form.phone')}
            type="tel"
            digits
            value={values.phone}
            onChange={(phone) => onFieldChange('phone', phone)}
            error={errors.phone}
            hint={
              <>
                {t(lang, 'form.phoneExample')} <bdi dir="ltr">050-1234567</bdi>
              </>
            }
            autoComplete="tel"
          />
        </FormCard>
      )}

      <FormCard title={t(lang, 'form.sectionAddress')}>
        {/* The picker reads `value` once, when it mounts. A prefill exists before the first
          render, so the saved street shows without a remount `key`. */}
        <StreetPicker
          label={t(lang, 'form.street')}
          lang={lang}
          value={values.street}
          onChange={(street) => onFieldChange('street', street)}
          error={errors.street}
        />

        <TextField
          // Not numeric: a house number may carry a letter ("12א").
          label={t(lang, 'form.houseNumber')}
          value={values.houseNumber}
          onChange={(houseNumber) => onFieldChange('houseNumber', houseNumber)}
          error={errors.houseNumber}
          // The street is a custom picker the browser cannot fill, so its address autofill would
          // put a whole "street and number" line here, which the house number then rejects.
          autoComplete="off"
          maxLength={FORM_TEXT_MAX_LENGTH.houseNumber}
        />

        <fieldset className="field" aria-describedby={spotError ? spotErrorId : undefined}>
          <legend className="field-label">{t(lang, 'form.bottlesSpot')}</legend>
          <div className="choice-cards">
            {bottlesSpotSchema.options.map((spot) => (
              <label key={spot} className="choice-card">
                <input
                  type="radio"
                  name={spotGroupName}
                  value={spot}
                  checked={values.bottlesSpot === spot}
                  onChange={() => onFieldChange('bottlesSpot', spot)}
                  aria-invalid={spotError ? true : undefined}
                />
                <Icon name={SPOT_ICONS[spot]} />
                <span>{t(lang, `bottlesSpot.${spot}`)}</span>
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
            label={t(lang, 'form.floorApt')}
            value={values.floorApt}
            onChange={(floorApt) => onFieldChange('floorApt', floorApt)}
            error={errors.floorApt}
            hint={t(lang, 'form.floorAptHint')}
            autoComplete="off"
            maxLength={FORM_TEXT_MAX_LENGTH.floorApt}
          />
        )}
      </FormCard>

      {afterAddress}

      <FormCard title={t(lang, 'form.sectionBottles')}>
        <TextField
          label={t(lang, 'form.bottles')}
          digits
          value={values.bottlesEstimated}
          onChange={(bottlesEstimated) => onFieldChange('bottlesEstimated', bottlesEstimated)}
          error={errors.bottlesEstimated}
          hint={t(lang, 'form.bottlesHint', { min: MIN_BOTTLES })}
          autoComplete="off"
        />

        <TextField
          label={t(lang, 'form.note')}
          value={values.note}
          onChange={(note) => onFieldChange('note', note)}
          error={errors.note}
          hint={t(lang, 'form.noteHint')}
          autoComplete="off"
          maxLength={FORM_TEXT_MAX_LENGTH.note}
        />
      </FormCard>
    </>
  );
}

// Which icon draws each bottlesSpot choice. A Record, so a new spot without an icon is a type error.
const SPOT_ICONS: Record<(typeof bottlesSpotSchema.options)[number], IconName> = {
  privateHouse: 'home',
  apartmentDoor: 'door',
  buildingEntrance: 'building',
};

/** Props of {@link FormCard}. */
export interface FormCardProps {
  /** The group's heading, which also names the section for screen readers. */
  title: string;
  /** A decorative icon before the title (the planning screen's "איפה" / "מתי" / "הודעה"). */
  icon?: IconName;
  children: ReactNode;
}

/**
 * One titled group of fields on a white card; the heading names the group for screen readers.
 * The form's only level of cards: the page's <form> around them is not a card itself.
 */
export function FormCard({ title, icon, children }: FormCardProps) {
  const headingId = useId();
  return (
    <section className="card form-card" aria-labelledby={headingId}>
      <h2 id={headingId} className="form-card-title">
        {/* Hidden from screen readers (Icon), so the heading's name stays the title alone. */}
        {icon !== undefined && <Icon name={icon} />}
        {title}
      </h2>
      {children}
    </section>
  );
}
