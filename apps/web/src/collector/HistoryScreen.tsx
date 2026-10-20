// The "היסטוריה" tab of the collector app (spec §3.7): one calendar month in Israel at a time,
// picked with "החודש הקודם" / "החודש הבא" (it opens on the current month), the month's three
// totals at the top (bottles collected, addresses collected, their value) and, under them, the
// orders closed in that month, collected and cancelled, newest first. GET /api/collector/history
// sends it all already counted (the shared buildHistory), so this screen only shows it. Read-only:
// nothing here changes an order.
import { useEffect, useState } from 'react';
import {
  ORDER_STATUS_LABELS,
  addMonths,
  formatDayMonth,
  formatShekels,
  monthInAppZone,
  type HistoryOrder,
  type HistoryResponse,
} from '@bottlerun/shared';
import { fetchHistory, type HistoryOutcome } from '../api.ts';
import { navigate } from '../router.tsx';
import { bottlesText } from './OrdersScreen.tsx';
import { useReloadOnReturn } from './useReloadOnReturn.ts';

/** Shown when the month got no usable answer (network error, 5xx, unreadable body). */
export const HISTORY_LOAD_FAILED_MESSAGE =
  'לא הצלחנו לטעון את ההיסטוריה. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

/** Shown in place of the list for a month in which no order was collected or cancelled. */
export const EMPTY_MONTH_TEXT = 'לא נסגרו הזמנות בחודש הזה.';

// The picker's month name, such as "אוקטובר 2026". The month is a calendar month, not an instant,
// so it is formatted from the 1st at UTC midnight with the UTC zone: no zone can then move it
// into the month before.
const monthNameFormat = new Intl.DateTimeFormat('he-IL', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * The Hebrew name of a calendar month `YYYY-MM`, such as "אוקטובר 2026". The screen only passes
 * months built by `monthInAppZone` and `addMonths`, so the string is always well formed.
 */
export function monthName(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return monthNameFormat.format(new Date(Date.UTC(year ?? 0, (monthNumber ?? 1) - 1, 1)));
}

/** Props of {@link HistoryScreen}. */
export interface HistoryScreenProps {
  /**
   * Loads one month's history. Defaults to {@link fetchHistory}; tests pass a fake. Must keep its
   * identity across renders (a module function, not an inline arrow): a new one loads again.
   */
  loadHistory?: (month: string) => Promise<HistoryOutcome>;
  /** The clock that decides the current month (in Israel). Tests pin it; defaults to now. */
  now?: () => Date;
}

/** What the screen shows under the picker. A logged-out answer leaves for /login instead. */
type ScreenState =
  { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; history: HistoryResponse };

const systemNow = (): Date => new Date();

/**
 * The history tab. Renders the page's only `<h1>` (Layout's heading rule) and the month picker in
 * every state, so Yoel can move to another month even while one fails to load.
 *
 * The month loads once per visit to the tab, again on every switch of month, on "לנסות שוב", and
 * when Yoel comes back to the app ({@link useReloadOnReturn}): the current month changes with every
 * "אספתי". A switch of month or a retry shows "טוען..." first, so the totals of one month never
 * stand under the name of another; coming back keeps what is shown until the new answer replaces
 * it. "החודש הבא" is off on the current month: a month that has not started has nothing closed.
 *
 * A 401 means the session ended: to the login, like the other tabs. A failed load stays here with
 * a retry: a dropped connection is not a logout.
 */
export function HistoryScreen({ loadHistory = fetchHistory, now = systemNow }: HistoryScreenProps) {
  // The current month in Israel: the picker's start and its upper end.
  const [currentMonth, setCurrentMonth] = useState(() => monthInAppZone(now()));
  // The month shown; the load below follows it.
  const [month, setMonth] = useState(currentMonth);
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  // Counts the loads of the same month asked for after the first ("לנסות שוב", or Yoel coming
  // back to the app): a new value runs the load below again.
  const [attempt, setAttempt] = useState(0);

  // Back in the app: load again without blanking the screen first. The app may have stayed open
  // across the 1st of a month, so the current month is read again too, and "החודש הבא" reaches it.
  useReloadOnReturn(() => {
    setCurrentMonth(monthInAppZone(now()));
    setAttempt((previous) => previous + 1);
  });

  useEffect(() => {
    // False once this load's answer no longer matters: Yoel moved to another month, a retry
    // started a newer load, he left the tab, or StrictMode ran the effect twice (dev only). A late
    // answer for a month no longer shown must not replace the month on screen, and a late "logged
    // out" must not pull him to the login from another screen.
    let current = true;

    function settle(outcome: HistoryOutcome): void {
      if (!current) return;
      switch (outcome.kind) {
        case 'loaded':
          setState({ kind: 'loaded', history: outcome.history });
          return;
        case 'loggedOut':
          // Replace, not push: "back" from the login must not land on a screen that needs it.
          navigate('/login', { replace: true });
          return;
        case 'failed':
          setState({ kind: 'failed' });
          return;
      }
    }

    // fetchHistory never rejects; a rejection is a failed load like any other.
    loadHistory(month).then(settle, () => settle({ kind: 'failed' }));
    return () => {
      current = false;
    };
  }, [loadHistory, month, attempt]);

  function showMonth(next: string): void {
    setState({ kind: 'loading' });
    setMonth(next);
  }

  function retry(): void {
    setState({ kind: 'loading' });
    setAttempt((previous) => previous + 1);
  }

  // YYYY-MM strings sort as the months do.
  const isCurrentMonth = month >= currentMonth;

  return (
    <>
      <h1>היסטוריה</h1>
      {/* Announced when it changes, since the tap that changes it stays on the button. */}
      <h2 className="month-name" aria-live="polite">
        {monthName(month)}
      </h2>
      {/* In the right-to-left row the first button is on the right: the earlier month, as a
          Hebrew calendar reads. */}
      <div className="month-picker">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => showMonth(addMonths(month, -1))}
        >
          החודש הקודם
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={isCurrentMonth}
          onClick={() => showMonth(addMonths(month, 1))}
        >
          החודש הבא
        </button>
      </div>

      {state.kind === 'loading' && <p role="status">טוען...</p>}

      {state.kind === 'failed' && (
        <>
          <p className="form-alert" role="alert">
            {HISTORY_LOAD_FAILED_MESSAGE}
          </p>
          <button type="button" className="button button-primary button-block" onClick={retry}>
            לנסות שוב
          </button>
        </>
      )}

      {state.kind === 'loaded' && <MonthHistory history={state.history} />}
    </>
  );
}

/** The month's three totals, then its closed orders (or {@link EMPTY_MONTH_TEXT}). */
function MonthHistory({ history }: { history: HistoryResponse }) {
  const { totals, orders } = history;

  return (
    <>
      <dl className="history-totals">
        <HistoryTotal label="בקבוקים שנאספו" value={String(totals.bottlesCollected)} />
        <HistoryTotal label="כתובות שנאספו" value={String(totals.addressesCollected)} />
        <HistoryTotal label="שווי" value={formatShekels(totals.valueAgorot)} />
      </dl>

      {orders.length === 0 ? (
        <p>{EMPTY_MONTH_TEXT}</p>
      ) : (
        <ul className="order-list" aria-label="ההזמנות שנסגרו בחודש">
          {orders.map((order) => (
            <HistoryOrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </>
  );
}

/** One total: its name, and under it the number, large. */
function HistoryTotal({ label, value }: { label: string; value: string }) {
  return (
    <div className="history-total">
      <dt>{label}</dt>
      {/* Digits (and "9.60 ₪") read left to right inside the right-to-left page (CLAUDE.md). */}
      <dd>
        <bdi dir="ltr">{value}</bdi>
      </dd>
    </div>
  );
}

/**
 * What became of a closed order: the bottles Yoel counted on "אספתי", or "בוטלה". A collected
 * order without a count (an old or broken document) still says it was collected.
 */
function outcomeText(order: HistoryOrder): string {
  if (order.status === 'cancelled') return ORDER_STATUS_LABELS.cancelled;
  return order.bottlesCollected === undefined
    ? ORDER_STATUS_LABELS.collected
    : bottlesText(order.bottlesCollected);
}

/**
 * One closed order: who (its `<h3>`, so a screen reader jumps from order to order, as on the
 * orders tab), the day it closed as DD/MM in Israel, the address, and what became of it.
 */
function HistoryOrderCard({ order }: { order: HistoryOrder }) {
  return (
    <li className="order-card">
      <h3 className="order-card-name">{order.contact.name}</h3>
      <p>
        <bdi dir="ltr">{formatDayMonth(order.closedAt)}</bdi>
      </p>
      <p>
        {order.address.streetName} {order.address.houseNumber}
      </p>
      <p className="order-card-bottles">{outcomeText(order)}</p>
    </li>
  );
}
