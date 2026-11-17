import { useId, type ReactNode } from 'react';
import {
  findStreet,
  formatIsraeliMobileLocal,
  streetDisplayName,
  t,
  type CustomerOrder,
  type Lang,
} from '@bottlerun/shared';

/**
 * The order's details as the customer gave them: only what the api sent, which is the order's
 * own (no id, no region, nothing of another customer). Drawn as settings-style rows: each
 * name/value pair in its own `<div>` inside the `<dl>` (valid HTML), so CSS can lay out a row
 * with the name at the start, the value at the end and a line between rows.
 */
export function OrderDetails({ order, lang }: { order: CustomerOrder; lang: Lang }) {
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
