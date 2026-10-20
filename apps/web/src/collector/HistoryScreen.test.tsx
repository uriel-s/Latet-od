import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { HistoryOrder, HistoryResponse } from '@bottlerun/shared';
import type { HistoryOutcome } from '../api.ts';
import {
  EMPTY_MONTH_TEXT,
  HISTORY_LOAD_FAILED_MESSAGE,
  HistoryScreen,
  monthName,
} from './HistoryScreen.tsx';
import { returnToApp } from './visibilityTestHelper.ts';

/** "Now" for most tests: 21/10/2026 in Israel, so the current month is October 2026. */
const NOW = new Date('2026-10-21T09:00:00Z');
const fixedNow = (): Date => NOW;

/** A collected order of October; overrides change it. */
function makeHistoryOrder(overrides: Partial<HistoryOrder> = {}): HistoryOrder {
  return {
    id: 'o1',
    status: 'collected',
    contact: { name: 'דנה כהן' },
    address: { streetName: 'שד נהר הדן', houseNumber: '12' },
    bottlesEstimated: 40,
    bottlesCollected: 45,
    closedAt: new Date('2026-10-12T07:30:00Z'),
    ...overrides,
  };
}

/** October 2026: two collected orders and one cancelled, newest first. */
const OCTOBER: HistoryResponse = {
  month: '2026-10',
  totals: { bottlesCollected: 105, addressesCollected: 2, valueAgorot: 2100 },
  orders: [
    makeHistoryOrder({
      id: 'o3',
      status: 'cancelled',
      contact: { name: 'משה לוי' },
      address: { streetName: 'הרצל', houseNumber: '5' },
      bottlesCollected: undefined,
      closedAt: new Date('2026-10-18T09:00:00Z'),
    }),
    makeHistoryOrder({
      id: 'o2',
      contact: { name: 'רחל אברהם' },
      address: { streetName: 'נחל לכיש', houseNumber: '7' },
      bottlesCollected: 60,
      // 01:00 on 15/10 in Israel, still the 14th in UTC: the day shown is Israel's.
      closedAt: new Date('2026-10-14T22:00:00Z'),
    }),
    makeHistoryOrder(),
  ],
};

/** September 2026: one collected order, worth 9.60 ₪. */
const SEPTEMBER: HistoryResponse = {
  month: '2026-09',
  totals: { bottlesCollected: 48, addressesCollected: 1, valueAgorot: 960 },
  orders: [
    makeHistoryOrder({
      id: 's1',
      contact: { name: 'יוסי מזרחי' },
      bottlesCollected: 48,
      closedAt: new Date('2026-09-03T09:00:00Z'),
    }),
  ],
};

/** A month in which nothing was collected or cancelled. */
function emptyMonth(month: string): HistoryResponse {
  return {
    month,
    totals: { bottlesCollected: 0, addressesCollected: 0, valueAgorot: 0 },
    orders: [],
  };
}

const LOGGED_OUT: HistoryOutcome = { kind: 'loggedOut' };
const FAILED: HistoryOutcome = { kind: 'failed' };

function loaded(history: HistoryResponse): HistoryOutcome {
  return { kind: 'loaded', history };
}

/** A promise the test settles by hand, to look at the screen while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * A fake `loadHistory` that records the month of every call and answers each call with the next
 * answer given (the last one repeats). With no answers, every month is October's.
 */
function fakeLoad(...answers: (HistoryOutcome | Promise<HistoryOutcome>)[]): {
  load: (month: string) => Promise<HistoryOutcome>;
  months: string[];
} {
  const months: string[] = [];
  const load = (month: string): Promise<HistoryOutcome> => {
    const answer = answers[Math.min(months.length, answers.length - 1)] ?? loaded(OCTOBER);
    months.push(month);
    return Promise.resolve(answer);
  };
  return { load, months };
}

/** Opens the history tab at /app/history with `loadHistory`, "now" pinned to `now`. */
function renderScreen(
  loadHistory: (month: string) => Promise<HistoryOutcome>,
  { strict = false, now = fixedNow }: { strict?: boolean; now?: () => Date } = {},
): { unmount: () => void } {
  window.history.replaceState(null, '', '/app/history');
  const screenElement = <HistoryScreen loadHistory={loadHistory} now={now} />;
  return render(strict ? <StrictMode>{screenElement}</StrictMode> : screenElement);
}

/** Renders October's history and waits for it; the next loads answer September, then October. */
async function renderOctober(): Promise<{ months: string[] }> {
  const history = fakeLoad(loaded(OCTOBER), loaded(SEPTEMBER), loaded(OCTOBER));
  renderScreen(history.load);
  await screen.findByRole('list', { name: 'ההזמנות שנסגרו בחודש' });
  return history;
}

/** The value shown next to the total named `label`. */
function totalOf(label: string): HTMLElement {
  const value = screen.getByText(label, { selector: 'dt' }).nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value for ${label}`);
  return value;
}

/** The card (list item) of the customer named `name`, found by its heading. */
function cardOf(name: string): HTMLElement {
  const card = screen
    .getAllByRole('listitem')
    .find((item) => within(item).queryByRole('heading', { level: 3, name }) !== null);
  if (card === undefined) throw new Error(`no card for ${name}`);
  return card;
}

function previousButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'החודש הקודם' });
}

function nextButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'החודש הבא' });
}

/** The month the picker shows. */
function shownMonth(): string | null {
  return screen.getByRole('heading', { level: 2 }).textContent;
}

/** The page has exactly one h1, and it is the tab's name. */
function expectOneH1(): void {
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1, name: 'היסטוריה' })).toBeDefined();
}

describe('monthName', () => {
  it.each([
    ['2026-10', 'אוקטובר 2026'],
    ['2026-01', 'ינואר 2026'],
    ['2025-12', 'דצמבר 2025'],
  ])('names %s in Hebrew as "%s"', (month, expected) => {
    expect(monthName(month)).toBe(expected);
  });
});

describe('HistoryScreen', () => {
  describe('while the month loads', () => {
    it('shows the heading, the current month and a loading status', () => {
      const history = fakeLoad(deferred<HistoryOutcome>().promise);
      renderScreen(history.load);

      expectOneH1();
      expect(shownMonth()).toBe('אוקטובר 2026');
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByText('בקבוקים שנאספו')).toBeNull();
      expect(history.months).toEqual(['2026-10']);
    });

    it('opens on the month in Israel, not in UTC', () => {
      // 00:30 on 1/11 in Israel is still 31/10 in UTC.
      const history = fakeLoad(deferred<HistoryOutcome>().promise);
      renderScreen(history.load, { now: () => new Date('2026-10-31T22:30:00Z') });

      expect(shownMonth()).toBe('נובמבר 2026');
      expect(history.months).toEqual(['2026-11']);
    });
  });

  describe('loaded', () => {
    it('shows the three totals of the month, each number left to right', async () => {
      await renderOctober();

      expectOneH1();
      expect(screen.queryByRole('status')).toBeNull();
      expect(totalOf('בקבוקים שנאספו').textContent).toBe('105');
      expect(totalOf('כתובות שנאספו').textContent).toBe('2');
      expect(totalOf('שווי').textContent).toBe('21 ₪');
      for (const label of ['בקבוקים שנאספו', 'כתובות שנאספו', 'שווי']) {
        expect(totalOf(label).querySelector('[dir="ltr"]'), label).not.toBeNull();
      }
    });

    it('lists the closed orders in the order the api gave them, newest first', async () => {
      await renderOctober();

      const list = screen.getByRole('list', { name: 'ההזמנות שנסגרו בחודש' });
      expect(
        within(list)
          .getAllByRole('heading', { level: 3 })
          .map((heading) => heading.textContent),
      ).toEqual(['משה לוי', 'רחל אברהם', 'דנה כהן']);
    });

    it('shows a collected order with its day, address and the bottles counted', async () => {
      await renderOctober();

      const card = cardOf('דנה כהן');
      const day = within(card).getByText('12/10');
      expect(day.closest('[dir="ltr"]')).not.toBeNull();
      expect(within(card).getByText('שד נהר הדן 12')).toBeDefined();
      // The count recorded on "אספתי", not the customer's estimate (40).
      expect(within(card).getByText('45 בקבוקים')).toBeDefined();
      expect(within(card).queryByText('בוטלה')).toBeNull();
    });

    it('shows the day an order closed as a day in Israel', async () => {
      await renderOctober();

      expect(within(cardOf('רחל אברהם')).getByText('15/10')).toBeDefined();
      expect(within(cardOf('משה לוי')).getByText('18/10')).toBeDefined();
    });

    it('says "בוטלה" for a cancelled order, with no bottle count', async () => {
      await renderOctober();

      const card = cardOf('משה לוי');
      expect(within(card).getByText('בוטלה')).toBeDefined();
      expect(within(card).getByText('הרצל 5')).toBeDefined();
      expect(within(card).queryByText(/בקבוק/)).toBeNull();
    });

    it('says "נאספה" for a collected order that has no count', async () => {
      const order = makeHistoryOrder({ bottlesCollected: undefined });
      renderScreen(fakeLoad(loaded({ ...OCTOBER, orders: [order] })).load);

      expect(within(await screen.findByRole('listitem')).getByText('נאספה')).toBeDefined();
    });

    it('says a month with nothing closed has no orders, with zero totals and no list', async () => {
      renderScreen(fakeLoad(loaded(emptyMonth('2026-10'))).load);

      expect(await screen.findByText(EMPTY_MONTH_TEXT)).toBeDefined();
      expect(EMPTY_MONTH_TEXT).toBe('לא נסגרו הזמנות בחודש הזה.');
      expect(totalOf('בקבוקים שנאספו').textContent).toBe('0');
      expect(totalOf('כתובות שנאספו').textContent).toBe('0');
      expect(totalOf('שווי').textContent).toBe('0 ₪');
      expect(screen.queryByRole('list')).toBeNull();
    });
  });

  describe('switching months', () => {
    it('turns "החודש הבא" off on the current month', async () => {
      await renderOctober();

      expect(nextButton().disabled).toBe(true);
      expect(previousButton().disabled).toBe(false);
    });

    it('loads the previous month, showing it in place of this one', async () => {
      const history = await renderOctober();

      fireEvent.click(previousButton());

      expect(shownMonth()).toBe('ספטמבר 2026');
      expect(history.months).toEqual(['2026-10', '2026-09']);
      // October's totals do not stand under September's name while it loads.
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByText('בקבוקים שנאספו')).toBeNull();

      expect(await screen.findByRole('heading', { level: 3, name: 'יוסי מזרחי' })).toBeDefined();
      expect(totalOf('בקבוקים שנאספו').textContent).toBe('48');
      expect(totalOf('כתובות שנאספו').textContent).toBe('1');
      expect(totalOf('שווי').textContent).toBe('9.60 ₪');
      expect(screen.queryByRole('heading', { level: 3, name: 'דנה כהן' })).toBeNull();
      expectOneH1();
    });

    it('turns "החודש הבא" on after going back, and it returns to the current month', async () => {
      const history = await renderOctober();

      fireEvent.click(previousButton());
      await screen.findByRole('heading', { level: 3, name: 'יוסי מזרחי' });

      expect(nextButton().disabled).toBe(false);

      fireEvent.click(nextButton());

      expect(shownMonth()).toBe('אוקטובר 2026');
      expect(nextButton().disabled).toBe(true);
      expect(history.months).toEqual(['2026-10', '2026-09', '2026-10']);
      expect(await screen.findByRole('heading', { level: 3, name: 'דנה כהן' })).toBeDefined();
    });

    it('steps back across the year', async () => {
      const history = fakeLoad(loaded(emptyMonth('2026-01')));
      renderScreen(history.load, { now: () => new Date('2026-01-10T10:00:00Z') });
      await screen.findByText(EMPTY_MONTH_TEXT);

      fireEvent.click(previousButton());

      expect(shownMonth()).toBe('דצמבר 2025');
      expect(history.months).toEqual(['2026-01', '2025-12']);
    });

    it('ignores a late answer for a month no longer shown', async () => {
      const october = deferred<HistoryOutcome>();
      const september = deferred<HistoryOutcome>();
      const history = fakeLoad(october.promise, september.promise);
      renderScreen(history.load);

      fireEvent.click(previousButton());
      september.resolve(loaded(SEPTEMBER));
      expect(await screen.findByRole('heading', { level: 3, name: 'יוסי מזרחי' })).toBeDefined();

      // October's answer arrives after Yoel moved on to September: it changes nothing.
      october.resolve(loaded(OCTOBER));
      await new Promise((settle) => setTimeout(settle, 0));

      expect(shownMonth()).toBe('ספטמבר 2026');
      expect(totalOf('בקבוקים שנאספו').textContent).toBe('48');
      expect(screen.queryByRole('heading', { level: 3, name: 'דנה כהן' })).toBeNull();
    });

    it('ignores a late "logged out" for a month no longer shown', async () => {
      const october = deferred<HistoryOutcome>();
      const history = fakeLoad(october.promise, loaded(SEPTEMBER));
      renderScreen(history.load);

      fireEvent.click(previousButton());
      await screen.findByRole('heading', { level: 3, name: 'יוסי מזרחי' });
      october.resolve(LOGGED_OUT);
      await new Promise((settle) => setTimeout(settle, 0));

      expect(window.location.pathname).toBe('/app/history');
    });
  });

  describe('logged out', () => {
    it('goes to the login in place of the history tab', async () => {
      const historyLength = window.history.length;
      renderScreen(fakeLoad(LOGGED_OUT).load);

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      // Replaced, not pushed: "back" from the login does not bounce off the tab again.
      expect(window.history.length).toBe(historyLength);
    });

    it('stays where Yoel went when the answer comes after he left the tab', async () => {
      const answer = deferred<HistoryOutcome>();
      const { unmount } = renderScreen(fakeLoad(answer.promise).load);
      unmount();
      window.history.replaceState(null, '', '/app/rounds');

      answer.resolve(LOGGED_OUT);
      await new Promise((settle) => setTimeout(settle, 0));

      expect(window.location.pathname).toBe('/app/rounds');
    });
  });

  describe('when the load fails', () => {
    it('says so in plain words with a retry, keeping the picker', async () => {
      renderScreen(fakeLoad(FAILED).load);

      expect((await screen.findByRole('alert')).textContent).toBe(HISTORY_LOAD_FAILED_MESSAGE);
      expect(HISTORY_LOAD_FAILED_MESSAGE).toBe(
        'לא הצלחנו לטעון את ההיסטוריה. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
      );
      expectOneH1();
      expect(screen.getByRole('button', { name: 'לנסות שוב' })).toBeDefined();
      expect(previousButton().disabled).toBe(false);
      expect(screen.queryByText('בקבוקים שנאספו')).toBeNull();
      expect(window.location.pathname).toBe('/app/history');
    });

    it('treats a rejected load like a failed one', async () => {
      renderScreen(() => Promise.reject(new Error('boom')));

      expect((await screen.findByRole('alert')).textContent).toBe(HISTORY_LOAD_FAILED_MESSAGE);
    });

    it('loads the same month again on "לנסות שוב", and shows it when that load succeeds', async () => {
      const second = deferred<HistoryOutcome>();
      const history = fakeLoad(FAILED, second.promise);
      renderScreen(history.load);
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'לנסות שוב' }));

      expect(history.months).toEqual(['2026-10', '2026-10']);
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByRole('alert')).toBeNull();

      second.resolve(loaded(OCTOBER));

      expect(await screen.findByRole('heading', { level: 3, name: 'דנה כהן' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'לנסות שוב' })).toBeNull();
    });

    it('can still move to another month, which loads', async () => {
      const history = fakeLoad(FAILED, loaded(SEPTEMBER));
      renderScreen(history.load);
      await screen.findByRole('alert');

      fireEvent.click(previousButton());

      expect(await screen.findByRole('heading', { level: 3, name: 'יוסי מזרחי' })).toBeDefined();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(history.months).toEqual(['2026-10', '2026-09']);
    });
  });

  describe('coming back to the app', () => {
    it('loads the shown month again, keeping it on screen until the answer replaces it', async () => {
      const second = deferred<HistoryOutcome>();
      const history = fakeLoad(loaded(OCTOBER), second.promise);
      renderScreen(history.load);
      await screen.findByRole('heading', { level: 3, name: 'דנה כהן' });

      returnToApp();

      expect(history.months).toEqual(['2026-10', '2026-10']);
      expect(screen.queryByRole('status')).toBeNull();
      expect(cardOf('דנה כהן')).toBeDefined();

      const newer: HistoryResponse = {
        ...OCTOBER,
        totals: { bottlesCollected: 135, addressesCollected: 3, valueAgorot: 2700 },
      };
      second.resolve(loaded(newer));

      await waitFor(() => expect(totalOf('בקבוקים שנאספו').textContent).toBe('135'));
      expect(totalOf('שווי').textContent).toBe('27 ₪');
    });

    it('moves the current month on when the app stayed open into a new month', async () => {
      let now = new Date('2026-10-31T20:00:00Z'); // 23:00 on 31/10 in Israel
      const history = fakeLoad(loaded(emptyMonth('2026-10')));
      renderScreen(history.load, { now: () => now });
      await screen.findByText(EMPTY_MONTH_TEXT);
      expect(nextButton().disabled).toBe(true);

      now = new Date('2026-11-01T08:00:00Z');
      returnToApp();

      // Still October on screen, but November can now be reached.
      expect(shownMonth()).toBe('אוקטובר 2026');
      expect(nextButton().disabled).toBe(false);

      fireEvent.click(nextButton());

      expect(shownMonth()).toBe('נובמבר 2026');
      expect(nextButton().disabled).toBe(true);
      expect(history.months.at(-1)).toBe('2026-11');
    });
  });

  describe('in StrictMode (development)', () => {
    it('ignores the answer of the first, discarded run of the load', async () => {
      // StrictMode mounts, unmounts and mounts again: two loads, and only the second counts.
      const history = fakeLoad(LOGGED_OUT, loaded(OCTOBER));
      renderScreen(history.load, { strict: true });

      expect(await screen.findByRole('heading', { level: 3, name: 'דנה כהן' })).toBeDefined();
      expect(history.months).toEqual(['2026-10', '2026-10']);
      expect(window.location.pathname).toBe('/app/history');
    });
  });
});
