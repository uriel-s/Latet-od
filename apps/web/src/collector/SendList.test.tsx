import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MessageLink } from '@bottlerun/shared';
import type { MarkMessageOpenedOutcome } from '../api.ts';
import {
  EMPTY_SEND_LIST_TEXT,
  MARK_OPENED_FAILED_MESSAGE,
  SendList,
  type SendListProps,
} from './SendList.tsx';

/** A row of the "שלח" list, not opened yet; overrides change it. */
function makeRow(overrides: Partial<MessageLink> = {}): MessageLink {
  return {
    orderId: 'o1',
    messageIndex: 0,
    kind: 'confirmRequest',
    name: 'דנה כהן',
    url: 'https://wa.me/972501234567?text=%D7%A9%D7%9C%D7%95%D7%9D',
    ...overrides,
  };
}

/** 22:30 UTC on 19/10 is already 01:30 on 20/10 in Israel: the row shows 20/10. */
const OPENED_AT = new Date('2026-10-19T22:30:00.000Z');

const ROWS: MessageLink[] = [
  makeRow(),
  makeRow({
    orderId: 'o2',
    messageIndex: 3,
    name: 'משה לוי',
    url: 'https://wa.me/972527654321?text=x',
  }),
];

/** A promise the test settles by hand, to look at the list while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * One answer of the fake `markOpened`: an outcome, a promise the test settles, or `'rejects'`
 * (created at call time, so no rejected promise waits unhandled before the call).
 */
type FakeAnswer = MarkMessageOpenedOutcome | Promise<MarkMessageOpenedOutcome> | 'rejects';

/**
 * A fake `markOpened` that records its calls and answers each with the next answer given (the
 * last one repeats; with none, `marked` at {@link OPENED_AT}).
 */
function fakeMarkOpened(...answers: FakeAnswer[]): {
  markOpened: NonNullable<SendListProps['markOpened']>;
  calls: { orderId: string; messageIndex: number }[];
} {
  const calls: { orderId: string; messageIndex: number }[] = [];
  const markOpened = (orderId: string, messageIndex: number) => {
    calls.push({ orderId, messageIndex });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer === 'rejects') return Promise.reject(new Error('boom'));
    return Promise.resolve(answer ?? { kind: 'marked' as const, openedAt: OPENED_AT });
  };
  return { markOpened, calls };
}

/** Lets every pending promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The row (list item) of the customer named `name`. */
function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole('listitem')
    .find((item) => within(item).queryByText(name) !== null);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
}

/**
 * The whole text of a row's "נפתח ✓" mark (the ✓ and the day sit in elements of their own, which
 * a plain text query would miss), or null when the row is not opened.
 */
function openedMarkOf(row: HTMLElement): string | null {
  return within(row).queryByText(/^נפתח/)?.textContent ?? null;
}

/** Shows the list at /app/rounds, where a planned round will host it. */
function renderList(props: SendListProps): ReturnType<typeof render> {
  window.history.replaceState(null, '', '/app/rounds');
  return render(<SendList {...props} />);
}

describe('SendList', () => {
  it('shows one row per customer, each with a "שלח" link to its wa.me url', () => {
    renderList({ rows: ROWS, markOpened: fakeMarkOpened().markOpened });

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const dana = within(rowOf('דנה כהן')).getByRole('link', { name: 'שלח לדנה כהן' });
    expect(dana.getAttribute('href')).toBe(ROWS[0]?.url);
    expect(dana.textContent).toMatch(/^שלח/);
    const moshe = within(rowOf('משה לוי')).getByRole('link', { name: 'שלח למשה לוי' });
    expect(moshe.getAttribute('href')).toBe('https://wa.me/972527654321?text=x');
  });

  it('opens each link in a new tab or the app, with no handle back to the list', () => {
    renderList({ rows: ROWS, markOpened: fakeMarkOpened().markOpened });

    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')?.split(' ')).toContain('noopener');
      expect(link.getAttribute('rel')?.split(' ')).toContain('noreferrer');
    }
  });

  it('shows no row as opened before a tap, and has no heading of its own', () => {
    renderList({ rows: ROWS, markOpened: fakeMarkOpened().markOpened });

    expect(openedMarkOf(rowOf('דנה כהן'))).toBeNull();
    expect(openedMarkOf(rowOf('משה לוי'))).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('marks the row at once on a tap, leaves the url to the browser, and stores the opening', async () => {
    const answer = deferred<MarkMessageOpenedOutcome>();
    const { markOpened, calls } = fakeMarkOpened(answer.promise);
    renderList({ rows: ROWS, markOpened });

    const link = screen.getByRole('link', { name: 'שלח למשה לוי' });
    // fireEvent answers false when a handler called preventDefault: the browser must open it.
    expect(fireEvent.click(link)).toBe(true);

    expect(calls).toEqual([{ orderId: 'o2', messageIndex: 3 }]);
    // Opened before the api answers, without a day yet.
    const row = rowOf('משה לוי');
    expect(openedMarkOf(row)).toBe('נפתח ✓');
    expect(row.className).toContain('send-row-opened');
    expect(within(row).getByRole('link', { name: 'שלח שוב למשה לוי' })).toBeDefined();
    expect(openedMarkOf(rowOf('דנה כהן'))).toBeNull();

    answer.resolve({ kind: 'marked', openedAt: OPENED_AT });

    await waitFor(() => expect(openedMarkOf(row)).toBe('נפתח ✓ · 20/10'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(window.location.pathname).toBe('/app/rounds');
  });

  it('shows the first day the api answers, not the day of the tap, for a link opened before', async () => {
    const firstOpened = new Date('2026-10-12T09:00:00.000Z');
    renderList({
      rows: ROWS,
      markOpened: fakeMarkOpened({ kind: 'marked', openedAt: firstOpened }).markOpened,
    });

    fireEvent.click(screen.getByRole('link', { name: 'שלח לדנה כהן' }));

    await waitFor(() => expect(openedMarkOf(rowOf('דנה כהן'))).toBe('נפתח ✓ · 12/10'));
  });

  it('starts a row whose openedAt is set as opened, with its day left to right', () => {
    renderList({
      rows: [makeRow({ openedAt: OPENED_AT }), ROWS[1] ?? makeRow()],
      markOpened: fakeMarkOpened().markOpened,
    });

    const row = rowOf('דנה כהן');
    expect(row.className).toContain('send-row-opened');
    expect(openedMarkOf(row)).toBe('נפתח ✓ · 20/10');
    expect(within(row).getByText('20/10').closest('[dir="ltr"]')).not.toBeNull();
    // Still there to send again, its name still starting with the visible "שלח".
    const again = within(row).getByRole('link', { name: 'שלח שוב לדנה כהן' });
    expect(again.getAttribute('href')).toBe(ROWS[0]?.url);
    expect(rowOf('משה לוי').className).not.toContain('send-row-opened');
  });

  it('keeps the row opened and says the opening was not saved when the save fails', async () => {
    const answers: FakeAnswer[] = [{ kind: 'failed' }, { kind: 'notFound' }, 'rejects'];
    for (const answer of answers) {
      const { unmount } = renderList({ rows: ROWS, markOpened: fakeMarkOpened(answer).markOpened });

      fireEvent.click(screen.getByRole('link', { name: 'שלח לדנה כהן' }));

      const row = rowOf('דנה כהן');
      expect((await within(row).findByRole('alert')).textContent).toBe(MARK_OPENED_FAILED_MESSAGE);
      expect(openedMarkOf(row)).toBe('נפתח ✓');
      expect(within(rowOf('משה לוי')).queryByRole('alert')).toBeNull();
      expect(window.location.pathname).toBe('/app/rounds');
      unmount();
    }
    expect(MARK_OPENED_FAILED_MESSAGE).toBe('לא הצלחנו לשמור שההודעה נפתחה.');
  });

  it('clears the note when a second tap is saved', async () => {
    const { markOpened, calls } = fakeMarkOpened(
      { kind: 'failed' },
      { kind: 'marked', openedAt: OPENED_AT },
    );
    renderList({ rows: ROWS, markOpened });
    fireEvent.click(screen.getByRole('link', { name: 'שלח לדנה כהן' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('link', { name: 'שלח שוב לדנה כהן' }));

    await waitFor(() => expect(openedMarkOf(rowOf('דנה כהן'))).toBe('נפתח ✓ · 20/10'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('shows no note when the opening was already stored and a second save fails', async () => {
    renderList({
      rows: [makeRow({ openedAt: OPENED_AT })],
      markOpened: fakeMarkOpened({ kind: 'failed' }).markOpened,
    });

    fireEvent.click(screen.getByRole('link', { name: 'שלח שוב לדנה כהן' }));
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(openedMarkOf(rowOf('דנה כהן'))).toBe('נפתח ✓ · 20/10');
  });

  it('goes to the login, replacing the screen, when the session ended', async () => {
    const historyLength = window.history.length;
    renderList({ rows: ROWS, markOpened: fakeMarkOpened({ kind: 'loggedOut' }).markOpened });

    fireEvent.click(screen.getByRole('link', { name: 'שלח לדנה כהן' }));

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    // Replaced, not pushed: "back" from the login does not bounce off the screen again.
    expect(window.history.length).toBe(historyLength);
  });

  it('stays where Yoel went when the answer comes after he left the screen', async () => {
    const answer = deferred<MarkMessageOpenedOutcome>();
    const { unmount } = renderList({
      rows: ROWS,
      markOpened: fakeMarkOpened(answer.promise).markOpened,
    });
    fireEvent.click(screen.getByRole('link', { name: 'שלח לדנה כהן' }));
    unmount();
    window.history.replaceState(null, '', '/app/orders');

    answer.resolve({ kind: 'loggedOut' });
    await settle();

    expect(window.location.pathname).toBe('/app/orders');
  });

  it('keeps a tapped row opened when the screen passes new rows', async () => {
    const { markOpened } = fakeMarkOpened({ kind: 'marked', openedAt: OPENED_AT });
    const { rerender } = renderList({ rows: ROWS, markOpened });
    fireEvent.click(screen.getByRole('link', { name: 'שלח לדנה כהן' }));
    await waitFor(() => expect(openedMarkOf(rowOf('דנה כהן'))).toBe('נפתח ✓ · 20/10'));

    // The same rows as new objects, in another order, with one more customer.
    const third = makeRow({ orderId: 'o3', messageIndex: 1, name: 'רחל אברהם' });
    rerender(<SendList rows={[third, makeRow(), makeRow(ROWS[1])]} markOpened={markOpened} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(openedMarkOf(rowOf('דנה כהן'))).toBe('נפתח ✓ · 20/10');
    expect(openedMarkOf(rowOf('משה לוי'))).toBeNull();
    expect(openedMarkOf(rowOf('רחל אברהם'))).toBeNull();
  });

  it('treats another message of the same order as a row of its own', () => {
    renderList({
      rows: [makeRow({ openedAt: OPENED_AT }), makeRow({ messageIndex: 2, kind: 'thankYou' })],
      markOpened: fakeMarkOpened().markOpened,
    });

    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['שלח שוב לדנה כהן', 'שלח לדנה כהן']);
  });

  it('says there is nothing to send, with no list, when there are no rows', () => {
    renderList({ rows: [], markOpened: fakeMarkOpened().markOpened });

    expect(screen.getByText(EMPTY_SEND_LIST_TEXT)).toBeDefined();
    expect(EMPTY_SEND_LIST_TEXT).toBe('אין הודעות לשליחה.');
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
