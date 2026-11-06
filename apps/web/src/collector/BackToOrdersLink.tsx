// The way back to the orders list from the add, edit and plan screens: a chevron and the word
// "הזמנות", like an iPhone back button, at the start of the title row (styles.css `.back-link`).

import { Icon } from '../components/Icon.tsx';
import { Link } from '../router.tsx';
import { ORDERS_LIST_PATH } from './orderEditing.ts';

/** Its accessible name: what a screen reader says, and what the tests find it by. */
export const BACK_TO_ORDERS_NAME = 'חזרה להזמנות';
/** The short word shown next to the chevron. */
const BACK_TO_ORDERS_VISIBLE = 'הזמנות';

/**
 * A link to the orders list that shows only a chevron and "הזמנות" but is named "חזרה להזמנות":
 * the full name is visually-hidden text, and the short visible word is hidden from screen readers
 * so it is not read twice. Rendered before the screen's `<h1>`; focus after a page change still
 * goes to the `<h1>` (pageChange.ts looks for it, not for the first focusable element).
 */
export function BackToOrdersLink() {
  return (
    <Link to={ORDERS_LIST_PATH} className="back-link">
      <Icon name="back" />
      <span aria-hidden="true">{BACK_TO_ORDERS_VISIBLE}</span>
      <span className="visually-hidden">{BACK_TO_ORDERS_NAME}</span>
    </Link>
  );
}
