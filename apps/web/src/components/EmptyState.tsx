// The "nothing here yet" block (ADR-0011): an icon, one plain sentence and an optional action (a
// button or link), so an empty list says what to do next instead of leaving a bare line of text.
// The icon is decoration (Icon hides it from screen readers); the sentence carries the meaning.

import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  icon: IconName;
  /** The sentence shown; kept as the only text node of its element so tests find it by text. */
  text: string;
  /** Optional next step, e.g. a link styled as a button. */
  action?: ReactNode;
}

/** An icon, a sentence and an optional action, centred in a card. */
export function EmptyState({ icon, text, action }: EmptyStateProps) {
  return (
    <div className="card empty-state">
      <Icon name={icon} />
      <p className="empty-state-text">{text}</p>
      {action}
    </div>
  );
}
