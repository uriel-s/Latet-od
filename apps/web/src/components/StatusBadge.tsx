// The order-status pill (ADR-0011): one tone (green / amber / gray, the `.badge-*` classes in
// styles.css), one icon and the status's Hebrew words. Every status has its own icon and its own
// words, so colour is never the only signal (WCAG 1.4.1): amber "waiting" and amber "pending" differ
// by clock vs calendar and by text, green "confirmed" and green "collected" by check vs heart.
//
// Not used by any screen yet: later sections swap it in where a status is shown as plain text.
// Hebrew only, for the collector app; the customer page follows the order's `lang` (ADR-0010), so
// when it adopts this badge it needs the label from the i18n `t()` dictionary (`orderStatus.*`)
// instead of ORDER_STATUS_LABELS.

import { ORDER_STATUS_LABELS, type OrderStatus } from '@bottlerun/shared';
import { Icon, type IconName } from './Icon.tsx';

/** A badge colour; each one is a `.badge-<tone>` class in styles.css. */
export type BadgeTone = 'green' | 'amber' | 'gray';

/**
 * Tone and icon of each status. A Record, so a new status without a look is a type error.
 * - waiting: amber clock, waiting for a round.
 * - pending: amber calendar, in a round and waiting for the customer's reply.
 * - confirmed: green check.
 * - collected: green heart, the thank-you; distinct from confirmed's check.
 * - cancelled: gray minus, final and quiet.
 */
export const STATUS_BADGE_STYLES: Readonly<
  Record<OrderStatus, { tone: BadgeTone; icon: IconName }>
> = {
  waiting: { tone: 'amber', icon: 'clock' },
  pending: { tone: 'amber', icon: 'calendar' },
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
}

/**
 * An order's status as a coloured pill: icon, then the Hebrew status name. The visible text is the
 * accessible name and the icon is hidden from screen readers, so no role or aria-label is needed.
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const { tone, icon } = STATUS_BADGE_STYLES[status];
  const classes = ['badge', `badge-${tone}`, className].filter(Boolean).join(' ');
  return (
    <span className={classes}>
      <Icon name={icon} />
      {ORDER_STATUS_LABELS[status]}
    </span>
  );
}
