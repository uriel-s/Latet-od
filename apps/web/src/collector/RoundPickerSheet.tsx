// The rounds tab's round picker: one wide button that shows the round on screen, and a bottom
// sheet to pick another open round. Presentational and controlled: the screen owns which round is
// selected (the `?round=` of the URL) and shows it below; this component owns only whether the
// sheet is open, the region filter (a view filter, not part of the URL) and where the focus goes.
// The words and rules of a row come from roundPicker.ts.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { REGION_LABELS, type RoundView } from '@bottlerun/shared';
import {
  filterRoundsByRegion,
  regionsPresent,
  roundPhaseLabel,
  roundPickerParts,
  type RegionFilter,
} from './roundPicker.ts';

/** Accessible name of the sheet (a dialog) and of nothing else on screen. */
export const ROUND_PICKER_TITLE = 'בחירת סבב';
/** The chip that shows every round. */
export const ROUND_PICKER_ALL_LABEL = 'הכל';
/** The button that closes the sheet without choosing. */
export const ROUND_PICKER_CLOSE_LABEL = 'סגור';

/** Props of {@link RoundPicker}. */
export interface RoundPickerProps {
  /** Every open round, in the api's order (nearest date first). */
  rounds: readonly RoundView[];
  /** Id of the round the screen shows now; marked in the list and written on the button. */
  selectedId: string;
  /** Yoel chose a round (also called for the one already selected); the sheet closes itself. */
  onSelect: (roundId: string) => void;
}

/** One round as "DD/MM · region · summary"; the date stays left-to-right inside the Hebrew. */
function RoundText({ view }: { view: RoundView }) {
  const { date, region, summary } = roundPickerParts(view);
  return (
    <>
      <bdi dir="ltr">{date}</bdi> · {region} · {summary}
    </>
  );
}

/**
 * The picker. With fewer than two open rounds there is nothing to choose, so it renders nothing
 * and the screen shows the single round on its own.
 *
 * The sheet is a modal dialog named by {@link ROUND_PICKER_TITLE}. The title is a plain paragraph,
 * not a heading: the page keeps one <h1> and a round's own <h2>, and a second <h2> would blur
 * that outline. On opening the focus moves to the dialog itself (tabIndex -1), so a screen
 * reader reads its name first; Tab then stays inside it; Escape, "סגור", a tap on the dark
 * background and choosing a row all close it, and the focus goes back to the button that
 * opened it. While it is open the page behind does not scroll.
 */
export function RoundPicker({ rounds, selectedId, onSelect }: RoundPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<RegionFilter>('all');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    dialogRef.current?.focus();
    // Lock the page's scroll while the sheet is open; put back whatever was there.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const first = rounds[0];
  if (rounds.length < 2 || first === undefined) return null;

  // An unknown id (a round closed meanwhile) shows the first round, as pickSelectedRound does.
  const selected = rounds.find((view) => view.round.id === selectedId) ?? first;
  const regions = regionsPresent(rounds);
  // A remembered region can lose its last round (it was closed meanwhile): show everything then,
  // instead of an empty list under a chip that no longer exists.
  const activeFilter: RegionFilter = filter !== 'all' && regions.includes(filter) ? filter : 'all';
  const visibleRounds = filterRoundsByRegion(rounds, activeFilter);

  /** Closes the sheet and gives the focus back to the button, which stays on the page. */
  function close(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function choose(roundId: string): void {
    onSelect(roundId);
    close();
  }

  /** Escape closes; Tab wraps from the last control to the first and back, so it cannot leave. */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button'));
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="round-picker">
      <button
        ref={triggerRef}
        type="button"
        className="button button-secondary round-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="round-picker-trigger-text">
          <RoundText view={selected} />
        </span>
        <span className="round-picker-chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <>
          <div className="round-picker-backdrop" onClick={close} />
          {/* The key handler sits on the dialog, where the keys of its buttons bubble to. */}
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="round-picker-sheet"
            onKeyDown={handleKeyDown}
          >
            <p id={titleId} className="round-picker-title">
              {ROUND_PICKER_TITLE}
            </p>

            {regions.length >= 2 && (
              <div className="round-picker-chips">
                <button
                  type="button"
                  className="round-picker-chip"
                  aria-pressed={activeFilter === 'all'}
                  onClick={() => setFilter('all')}
                >
                  {ROUND_PICKER_ALL_LABEL}
                </button>
                {regions.map((region) => (
                  <button
                    key={region}
                    type="button"
                    className="round-picker-chip"
                    aria-pressed={activeFilter === region}
                    onClick={() => setFilter(region)}
                  >
                    {REGION_LABELS[region]}
                  </button>
                ))}
              </div>
            )}

            <ul className="round-picker-list">
              {visibleRounds.map((view) => {
                const isSelected = view.round.id === selected.round.id;
                return (
                  <li key={view.round.id}>
                    <button
                      type="button"
                      className="round-picker-row"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => choose(view.round.id)}
                    >
                      <span className="round-picker-row-text">
                        {/* The mark is decorative: aria-current already says "selected". */}
                        {isSelected && (
                          <span className="round-picker-check" aria-hidden="true">
                            ✓{' '}
                          </span>
                        )}
                        <RoundText view={view} />
                      </span>
                      <span className="tag">{roundPhaseLabel(view)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <button
              type="button"
              className="button button-secondary button-block round-picker-close"
              onClick={close}
            >
              {ROUND_PICKER_CLOSE_LABEL}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
