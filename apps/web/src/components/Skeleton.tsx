// Loading placeholder (ADR-0011): grey cards that pulse gently instead of a "טוען..." line. The
// words stay in a visually hidden role="status" so screen readers (and tests) still find them; the
// grey blocks are decoration and hidden from assistive tech. The pulse stops under
// prefers-reduced-motion (see `.skeleton-block` in styles.css).

/** Text announced while loading; shared so screens and tests use the same words. */
export const LOADING_TEXT = 'טוען...';

/** Props of {@link Skeleton}. */
export interface SkeletonProps {
  /** How many grey cards to draw (default 3). */
  cards?: number;
}

/** Pulsing grey cards plus the hidden "טוען..." status. */
export function Skeleton({ cards = 3 }: SkeletonProps) {
  return (
    <div className="skeleton">
      <p role="status" className="visually-hidden">
        {LOADING_TEXT}
      </p>
      <div aria-hidden="true">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="card skeleton-block" />
        ))}
      </div>
    </div>
  );
}
