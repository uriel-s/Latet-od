// The order-status pill (ADR-0011): one tone (green / amber / gray, the `.badge-*` classes in
// styles.css), one icon and the status's Hebrew words. Every status has its own icon and its own
// words, so colour is never the only signal (WCAG 1.4.1): green "confirmed" and green "collected"
// differ by check vs heart. The legacy "pending" looks exactly like "confirmed" (ADR-0012).
//
// The words come from the i18n `t()` dictionary (`orderStatus.*`): Hebrew by default (collector app),
// the order's `lang` on the customer page (ADR-0010).

import { DEFAULT_LANG, t, type Lang, type OrderStatus } from '@bottlerun/shared';
import { Icon, type IconName } from './Icon.tsx';

/** A badge colour; each one is a `.badge-<tone>` class in styles.css. */
export type BadgeTone = 'green' | 'amber' | 'gray';

/**
 * Tone and icon of each status. A Record, so a new status without a look is a type error.
 * - waiting: amber clock, waiting for a round.
 * - confirmed: green check, in a round.
 * - pending: legacy (ADR-0012), the same look as confirmed: nothing left to confirm.
 * - collected: green heart, the thank-you; distinct from confirmed's check.
 * - cancelled: gray minus, final and quiet.
 */
export const STATUS_BADGE_STYLES: Readonly<
  Record<OrderStatus, { tone: BadgeTone; icon: IconName }>
> = {
  waiting: { tone: 'amber', icon: 'clock' },
  pending: { tone: 'green', icon: 'check' },
  confirmed: { tone: 'green', icon: 'check' },
  collected: { tone: 'green', icon: 'heart' },
  cancelled: { tone: 'gray', icon: 'minus' },
};

/** Props of {@link StatusBadge}. */
export interface StatusBadgeProps {
  /** The order status to show. */
  status: OrderStatus;
  /** Extra class for the badge, e.g. for spacing in its row. */
  className?: string;
  /** Language of the status words: the order's `lang` on the customer page. Defaults to Hebrew. */
  lang?: Lang;
}

/**
 * An order's status as a coloured pill: icon, then the Hebrew status name. The visible text is the
 * accessible name and the icon is hidden from screen readers, so no role or aria-label is needed.
 */
export function StatusBadge({ status, className, lang = DEFAULT_LANG }: StatusBadgeProps) {
  const { tone, icon } = STATUS_BADGE_STYLES[status];
  const classes = ['badge', `badge-${tone}`, className].filter(Boolean).join(' ');
  return (
    <span className={classes}>
      <Icon name={icon} />
      {t(lang, `orderStatus.${status}`)}
    </span>
  );
}
