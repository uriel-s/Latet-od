import { StrictMode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wazeUrl } from './routeStops.ts';
import {
  COLLECT_STOP_ERRORS,
  MAX_BOTTLES,
  type CollectorOrder,
  type RouteStopView,
} from '@bottlerun/shared';
import type { MarkMessageOpenedOutcome } from '../api/collectorOrdersApi.ts';
import { renderWithApi } from '../api/renderWithApi.tsx';
import {
  BOTTLES_COLLECTED_LABEL,
  NEXT_STOP_EYEBROW,
  NOT_FOUND_QUESTION,
  SEND_THANKS_TITLE,
  StopCard,
  parseBottlesCollected,
  type StopCardProps,
} from './StopCard.tsx';

/** A confirmed order in רמת בית שמש, on an apartment door with floor and note; overrides change it. */
function makeOrder(overrides: Partial<CollectorOrder> = {}): CollectorOrder {
  return {
    id: 'o1',
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: 201,
      streetName: 'שד נהר הדן',
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3, דירה 12',
      note: 'ליד העגלה',
    },
    bottlesEstimated: 40,
    status: 'confirmed',
    region: 'ramat',
    source: 'form',
    createdAt: new Date('2026-10-01T08:00:00Z'),
    hasLocation: true,
    ...overrides,
  };
}

/** A stop still to collect, with a map point; overrides change it. */
function makeStop(overrides: Partial<RouteStopView> = {}): RouteStopView {
  return { order: makeOrder(), hasLocation: true, state: 'toCollect', ...overrides };
}

const THANK_YOU_URL = 'https://wa.me/972501234567?text=%D7%AA%D7%95%D7%93%D7%94';

/** A collected stop with its unsent thank-you. */
const COLLECTED: RouteStopView = makeStop({
  order: makeOrder({ status: 'collected' }),
  state: 'collected',
  thankYou: {
    orderId: 'o1',
    messageIndex: 1,
    kind: 'thankYou',
    name: 'דנה כהן',
    url: THANK_YOU_URL,
  },
});

/** What the card called back, in order. */
interface Calls {
  moves: ('up' | 'down')[];
  collects: number[];
  notFounds: number;
  typing: boolean[];
}

/**
 * The client's `markMessageOpened`, which the "שלח תודה" row (SendList) takes from useApi. No test
 * here taps it; faked anyway, so no request can leave the test.
 */
const markMessageOpened = (): Promise<MarkMessageOpenedOutcome> =>
  Promise.resolve({ kind: 'marked', openedAt: new Date('2026-10-20T08:00:00Z') });

/**
 * Renders one card inside a list, as the route screen does, recording every callback. Under an
 * ApiProvider whose `markMessageOpened` is the fake above; `rerender` keeps it.
 */
function renderCard(overrides: Partial<StopCardProps> = {}): {
  calls: Calls;
  rerender: (next: Partial<StopCardProps>) => void;
  unmount: () => void;
} {
  const calls: Calls = { moves: [], collects: [], notFounds: 0, typing: [] };
  const props = (next: Partial<StopCardProps>): StopCardProps => ({
    stop: makeStop(),
    position: 2,
    // The big card by default: it has "אספתи" itself. The compact card is asked for with current: false.
    current: true,
    canMoveUp: true,
    canMoveDown: true,
    busy: false,
    onMove: (direction) => calls.moves.push(direction),
    onCollect: (bottles) => calls.collects.push(bottles),
    onNotFound: () => {
      calls.notFounds += 1;
    },
    onTypingChange: (typing) => calls.typing.push(typing),
    ...overrides,
    ...next,
  });
  const result = renderWithApi(
    <ol>
      <StopCard {...props({})} />
    </ol>,
    { markMessageOpened },
  );
  return {
    calls,
    rerender: (next) =>
      result.rerender(
        <ol>
          <StopCard {...props(next)} />
        </ol>,
      ),
    unmount: result.unmount,
  };
}

function button(name: string | RegExp): HTMLElement {
  return screen.getByRole('button', { name });
}

function quantityField(): HTMLInputElement {
  return screen.getByLabelText(BOTTLES_COLLECTED_LABEL);
}

/** Taps "אספתי", types `text` into the quantity field, and taps "שמור". */
function collectWith(text: string): void {
  fireEvent.click(button('אספתי, דנה כהן'));
  fireEvent.change(quantityField(), { target: { value: text } });
  fireEvent.click(button('שמור'));
}

describe('parseBottlesCollected', () => {
  it('accepts a whole number from 1 up, below the booking minimum too', () => {
    expect(parseBottlesCollected(' 42 ')).toEqual({ ok: true, bottlesCollected: 42 });
    expect(parseBottlesCollected('1')).toEqual({ ok: true, bottlesCollected: 1 });
    expect(parseBottlesCollected(String(MAX_BOTTLES))).toEqual({
      ok: true,
      bottlesCollected: MAX_BOTTLES,
    });
  });

  it.each(['', '  ', '0', '2.5', '4,5', '1e3', '-3', 'abc'])('refuses "%s"', (text) => {
    expect(parseBottlesCollected(text)).toEqual({
      ok: false,
      message: COLLECT_STOP_ERRORS.bottlesInvalid,
    });
  });

  it('refuses more than MAX_BOTTLES with its own message', () => {
    expect(parseBottlesCollected(String(MAX_BOTTLES + 1))).toEqual({
      ok: false,
      message: COLLECT_STOP_ERRORS.bottlesTooMany,
    });
  });
});

describe('StopCard compact (upcoming stop)', () => {
  it('shows the number in a dot, the name as a heading, the street and the estimate', () => {
    renderCard({ current: false });

    const card = screen.getByRole('listitem');
    expect(within(card).getByText('2')).toBeTruthy();
    expect(within(card).getByRole('heading', { level: 3, name: 'דנה כהן' })).toBeTruthy();
    expect(within(card).getByText('שד נהר הדן 12')).toBeTruthy();
    expect(within(card).getByText('40 בקבוקים')).toBeTruthy();
    expect(within(card).queryByText('בלי מיקום')).toBeNull();
    expect(card.className).toContain('stop-card-compact');
  });

  it('tags "בלי מיקום" by the stored flag of the stop, not the order', () => {
    renderCard({
      current: false,
      stop: makeStop({ hasLocation: false, order: makeOrder({ hasLocation: true }) }),
    });
    expect(screen.getByText('בלי מיקום')).toBeTruthy();
  });

  it('shows no "בלי מיקום" when the stop had a point, although the order has none now', () => {
    renderCard({
      current: false,
      stop: makeStop({ hasLocation: true, order: makeOrder({ hasLocation: false }) }),
    });
    expect(screen.queryByText('בלי מיקום')).toBeNull();
  });

  it('has only "⋯" on the card itself; every action is in its sheet', () => {
    renderCard({ current: false });
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'עוד פעולות, דנה כהן',
    ]);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('puts "אספתי", "נווט" and "חייג" in the sheet', () => {
    renderCard({ current: false });
    openSheet();

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'אספתי' })).toBeTruthy();
    const waze = within(dialog).getByRole('link', { name: 'נווט' });
    expect(waze.getAttribute('href')).toBe(wazeUrl(makeOrder().address));
    expect(waze.getAttribute('target')).toBe('_blank');
    expect(waze.getAttribute('rel')?.split(' ')).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer']),
    );
    expect(within(dialog).getByRole('link', { name: 'חייג' }).getAttribute('href')).toBe(
      'tel:+972501234567',
    );
  });

  it('collects out of order: the sheet closes and the stepper opens with the estimate', () => {
    const { calls } = renderCard({ current: false });
    openSheet();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'אספתי' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(quantityField().value).toBe('40');
    expect(document.activeElement).toBe(quantityField());
    fireEvent.change(quantityField(), { target: { value: '33' } });
    fireEvent.click(button('שמור'));
    expect(calls.collects).toEqual([33]);
  });

  it('gives the focus back to "⋯" when the stepper is cancelled', () => {
    renderCard({ current: false });
    openSheet();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'אספתי' }));
    fireEvent.click(button('ביטול'));
    expect(document.activeElement).toBe(button('עוד פעולות, דנה כהן'));
  });
});

describe('StopCard "אספתי"', () => {
  it('opens the quantity field with the estimate, on the numeric keyboard, with the focus', () => {
    const { calls } = renderCard();

    fireEvent.click(button('אספתי, דנה כהן'));

    const field = quantityField();
    expect(field.value).toBe('40');
    expect(field.getAttribute('inputmode')).toBe('numeric');
    expect(field.getAttribute('dir')).toBe('ltr');
    expect(document.activeElement).toBe(field);
    expect(screen.queryByRole('button', { name: /^אספתי/ })).toBeNull();
    expect(calls.typing).toEqual([true]);
  });

  it('saves the estimate as it is', () => {
    const { calls } = renderCard();
    fireEvent.click(button('אספתי, דנה כהן'));
    fireEvent.click(button('שמור'));
    expect(calls.collects).toEqual([40]);
  });

  it('saves the corrected quantity', () => {
    const { calls } = renderCard();
    collectWith('42');
    expect(calls.collects).toEqual([42]);
  });

  it('saves from the keyboard\'s "Go" too', () => {
    const { calls } = renderCard();
    fireEvent.click(button('אספתי, דנה כהן'));
    fireEvent.change(quantityField(), { target: { value: '25' } });
    fireEvent.submit(quantityField());
    expect(calls.collects).toEqual([25]);
  });

  it.each([
    ['0', COLLECT_STOP_ERRORS.bottlesInvalid],
    ['2.5', COLLECT_STOP_ERRORS.bottlesInvalid],
    ['', COLLECT_STOP_ERRORS.bottlesInvalid],
    [String(MAX_BOTTLES + 1), COLLECT_STOP_ERRORS.bottlesTooMany],
  ])('refuses "%s" next to the field and does not save', (text, message) => {
    const { calls } = renderCard();

    collectWith(text);

    const field = quantityField();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const error = screen.getByText(message);
    expect(field.getAttribute('aria-describedby')).toBe(error.id);
    expect(calls.collects).toEqual([]);
  });

  it('clears the message once the quantity is typed again', () => {
    renderCard();
    collectWith('0');
    fireEvent.change(quantityField(), { target: { value: '30' } });
    expect(screen.queryByText(COLLECT_STOP_ERRORS.bottlesInvalid)).toBeNull();
  });

  it("shows the api's message for the quantity next to the field", () => {
    renderCard({ bottlesError: COLLECT_STOP_ERRORS.bottlesTooMany });
    fireEvent.click(button('אספתי, דנה כהן'));
    expect(screen.getByText(COLLECT_STOP_ERRORS.bottlesTooMany)).toBeTruthy();
    expect(quantityField().getAttribute('aria-invalid')).toBe('true');
  });

  it('closes on "ביטול", with the focus back on "אספתי"', () => {
    const { calls } = renderCard();
    fireEvent.click(button('אספתי, דנה כהן'));

    fireEvent.click(button('ביטול'));

    expect(screen.queryByLabelText(BOTTLES_COLLECTED_LABEL)).toBeNull();
    expect(document.activeElement).toBe(button('אספתי, דנה כהן'));
    expect(calls.typing).toEqual([true, false]);
    expect(calls.collects).toEqual([]);
  });

  it('opens again with the estimate after "ביטול"', () => {
    renderCard();
    fireEvent.click(button('אספתי, דנה כהן'));
    fireEvent.change(quantityField(), { target: { value: '7' } });
    fireEvent.click(button('ביטול'));
    fireEvent.click(button('אספתי, דנה כהן'));
    expect(quantityField().value).toBe('40');
  });

  it('keeps the field open while the save is on its way, and closes it once collected', () => {
    const { calls, rerender } = renderCard();
    collectWith('42');

    rerender({ busy: true });
    expect(quantityField().value).toBe('42');
    expect(button('שומר...').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button('שומר...'));
    fireEvent.click(button('ביטול'));
    expect(quantityField()).toBeTruthy();
    expect(calls.collects).toEqual([42]);

    rerender({ busy: false, stop: COLLECTED, justSaved: 'collected' });
    expect(screen.queryByLabelText(BOTTLES_COLLECTED_LABEL)).toBeNull();
    expect(calls.typing).toEqual([true, false]);
    // Yoel's own save (the screen says so): the focus goes to the thank-you he sends next.
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 4, name: SEND_THANKS_TITLE }),
    );
  });

  it('tells the screen typing stopped when the card leaves with the field open', () => {
    const { calls, unmount } = renderCard();
    fireEvent.click(button('אספתי, דנה כהן'));
    unmount();
    expect(calls.typing).toEqual([true, false]);
  });

  it('reports each change of typing once under StrictMode', () => {
    const typing: boolean[] = [];
    render(
      <StrictMode>
        <ol>
          <StopCard
            stop={makeStop()}
            position={1}
            current
            canMoveUp={false}
            canMoveDown={false}
            busy={false}
            onMove={() => undefined}
            onCollect={() => undefined}
            onNotFound={() => undefined}
            onTypingChange={(value) => typing.push(value)}
          />
        </ol>
      </StrictMode>,
    );
    expect(typing).toEqual([]);
    fireEvent.click(button('אספתי, דנה כהן'));
    expect(typing).toEqual([true]);
  });
});

/** Taps "⋯" on the card. */
function openSheet(): void {
  fireEvent.click(button('עוד פעולות, דנה כהן'));
}

describe.each([
  ['compact', false],
  ['current', true],
])('StopCard "⋯" sheet (%s card)', (_label, current) => {
  it('opens a dialog with the focus inside and closes on "סגור", focus back on "⋯"', () => {
    renderCard({ current });
    const more = button('עוד פעולות, דנה כהן');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(more);

    const dialog = screen.getByRole('dialog', { name: 'עוד פעולות, דנה כהן' });
    expect(document.activeElement).toBe(dialog);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(within(dialog).getByRole('button', { name: 'לא נמצא' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /^הזז למעלה/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /^הזז למטה/ })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'סגור' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button('עוד פעולות, דנה כהן'));
  });

  it('closes on Escape and on the dark background, focus back on "⋯"', () => {
    renderCard({ current });
    openSheet();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button('עוד פעולות, דנה כהן'));

    openSheet();
    fireEvent.click(document.querySelector('.round-picker-backdrop') as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button('עוד פעולות, דנה כהן'));
  });

  it('calls onMove from the arrows and closes', () => {
    const { calls } = renderCard({ current });
    openSheet();
    fireEvent.click(button(/^הזז למעלה/));
    openSheet();
    fireEvent.click(button(/^הזז למטה/));
    expect(calls.moves).toEqual(['up', 'down']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows only the arrows that can move', () => {
    renderCard({ current, canMoveUp: false, canMoveDown: true });
    openSheet();
    expect(screen.queryByRole('button', { name: /^הזז למעלה/ })).toBeNull();
    expect(button(/^הזז למטה/)).toBeTruthy();
  });

  it('shows no arrow for the only stop left', () => {
    renderCard({ current, canMoveUp: false, canMoveDown: false });
    openSheet();
    expect(screen.queryByRole('button', { name: /^הזז/ })).toBeNull();
    expect(button('לא נמצא')).toBeTruthy();
  });

  it('asks first, then calls onNotFound only on "כן, לא נמצא"', () => {
    const { calls } = renderCard({ current });
    openSheet();

    fireEvent.click(button('לא נמצא'));
    const question = screen.getByRole('group', { name: NOT_FOUND_QUESTION });
    expect(document.activeElement).toBe(within(question).getByText(NOT_FOUND_QUESTION));
    expect(calls.notFounds).toBe(0);

    fireEvent.click(within(question).getByRole('button', { name: 'כן, לא נמצא' }));
    expect(calls.notFounds).toBe(1);
  });

  it('goes back to the actions on "לא" without calling onNotFound', () => {
    const { calls } = renderCard({ current });
    openSheet();
    fireEvent.click(button('לא נמצא'));

    fireEvent.click(button('לא'));

    expect(screen.queryByRole('group', { name: NOT_FOUND_QUESTION })).toBeNull();
    expect(button('לא נמצא')).toBeTruthy();
    expect(calls.notFounds).toBe(0);
  });

  it('closes when the stop is not found', () => {
    const { rerender } = renderCard({ current });
    openSheet();
    fireEvent.click(button('לא נמצא'));
    rerender({ stop: makeStop({ state: 'notFound' }) });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('לא נמצא')).toBeTruthy();
  });

  it('ignores every tap in the question while busy', () => {
    const { calls, rerender } = renderCard({ current });
    openSheet();
    fireEvent.click(button('לא נמצא'));
    rerender({ busy: true });

    fireEvent.click(button('שומר...'));
    fireEvent.click(button('לא'));

    expect(screen.getByRole('group', { name: NOT_FOUND_QUESTION })).toBeTruthy();
    expect(calls.notFounds).toBe(0);
  });

  it('shows a failed "כן, לא נמצא" inside the sheet, not behind it', () => {
    const { rerender } = renderCard({ current });
    openSheet();
    fireEvent.click(button('לא נמצא'));
    fireEvent.click(button('כן, לא נמצא'));

    rerender({ error: 'לא הצלחנו לשמור. נא לנסות שוב.' });

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(
      'לא הצלחנו לשמור. נא לנסות שוב.',
    );

    // Closed, the card shows it again.
    fireEvent.click(button('סגור'));
    expect(screen.getByRole('alert').textContent).toBe('לא הצלחנו לשמור. נא לנסות שוב.');
  });

  it('does not open while busy', () => {
    renderCard({ current, busy: true });
    expect(button('עוד פעולות, דנה כהן').getAttribute('aria-disabled')).toBe('true');
    openSheet();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('StopCard bottles stepper', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has big − and + buttons around the digit field, starting at the estimate', () => {
    renderCard();
    fireEvent.click(button('אספתי, דנה כהן'));
    expect(quantityField().value).toBe('40');
    expect(button('הפחת בקבוק').textContent).toBe('−');
    expect(button('הוסף בקבוק').textContent).toBe('+');
  });

  it('changes the value by one and never goes below 1', () => {
    renderCard({ stop: makeStop({ order: makeOrder({ bottlesEstimated: 2 }) }) });
    fireEvent.click(button('אספתי, דנה כהן'));

    fireEvent.click(button('הוסף בקבוק'));
    expect(quantityField().value).toBe('3');
    fireEvent.click(button('הפחת בקבוק'));
    fireEvent.click(button('הפחת בקבוק'));
    expect(quantityField().value).toBe('1');
    fireEvent.click(button('הפחת בקבוק'));
    expect(quantityField().value).toBe('1');
  });

  it('never goes above MAX_BOTTLES, and steps from the estimate when the field is blank', () => {
    renderCard();
    fireEvent.click(button('אספתי, דנה כהן'));
    fireEvent.change(quantityField(), { target: { value: String(MAX_BOTTLES) } });
    fireEvent.click(button('הוסף בקבוק'));
    expect(quantityField().value).toBe(String(MAX_BOTTLES));

    fireEvent.change(quantityField(), { target: { value: '' } });
    fireEvent.click(button('הוסף בקבוק'));
    expect(quantityField().value).toBe('41');
  });

  it('saves the stepped value through onCollect', () => {
    const { calls } = renderCard();
    fireEvent.click(button('אספתי, דנה כהן'));
    fireEvent.click(button('הפחת בקבוק'));
    fireEvent.click(button('שמור'));
    expect(calls.collects).toEqual([39]);
  });

  it('vibrates once the save succeeded, not before', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, vibrate });
    const { rerender } = renderCard();
    collectWith('42');
    expect(vibrate).not.toHaveBeenCalled();

    rerender({ stop: COLLECTED, justSaved: 'collected' });
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(30);
  });

  it('does not fail where vibrate does not exist', () => {
    vi.stubGlobal('navigator', { ...navigator, vibrate: undefined });
    const { rerender } = renderCard();
    collectWith('42');
    rerender({ stop: COLLECTED, justSaved: 'collected' });
    expect(screen.getByText('נאסף')).toBeTruthy();
  });

  it('does not vibrate for a stop collected elsewhere', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, vibrate });
    const { rerender } = renderCard();
    rerender({ stop: COLLECTED });
    expect(vibrate).not.toHaveBeenCalled();
  });
});

describe('StopCard busy', () => {
  it('marks the buttons aria-disabled and ignores the taps', () => {
    const { calls } = renderCard({ busy: true });

    for (const name of ['אספתי, דנה כהן', 'עוד פעולות, דנה כהן']) {
      expect(button(name).getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(button(name));
    }

    expect(screen.queryByLabelText(BOTTLES_COLLECTED_LABEL)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toEqual({ moves: [], collects: [], notFounds: 0, typing: [] });
  });
});

describe('StopCard error', () => {
  it('shows why the last action failed, as an alert in the card', () => {
    renderCard({ error: 'לא הצלחנו לשמור. נא לנסות שוב.' });
    expect(screen.getByRole('alert').textContent).toBe('לא הצלחנו לשמור. נא לנסות שוב.');
  });
});

// The route screen mounts a NEW card when a save moves a stop into another list; these render the
// card straight in its saved state, as that new card is.
describe('StopCard justSaved', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('buzzes and focuses "שלח תודה" when mounted collected right after Yoel\'s "אספתי"', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, vibrate });
    const seen = vi.fn();

    renderCard({ stop: COLLECTED, justSaved: 'collected', onJustSavedSeen: seen });

    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 4, name: SEND_THANKS_TITLE }),
    );
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('focuses its name, not a Tab stop, when mounted not found right after Yoel\x27s "כן, לא נמצא"', () => {
    const seen = vi.fn();

    renderCard({
      stop: makeStop({ state: 'notFound' }),
      justSaved: 'notFound',
      onJustSavedSeen: seen,
    });

    const name = screen.getByRole('heading', { level: 3, name: 'דנה כהן' });
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute('tabindex')).toBe('-1');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('takes no focus when shown not found with nothing just saved (a reload)', () => {
    const seen = vi.fn();
    renderCard({ stop: makeStop({ state: 'notFound' }), onJustSavedSeen: seen });
    expect(document.activeElement).toBe(document.body);
    expect(seen).not.toHaveBeenCalled();
  });

  it('puts a lost focus back on "⋯" when mounted after a saved move', () => {
    const seen = vi.fn();
    renderCard({ current: false, justSaved: 'moved', onJustSavedSeen: seen });
    expect(document.activeElement).toBe(button('עוד פעולות, דנה כהן'));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('does not take the focus from elsewhere after a saved move', () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    renderCard({ justSaved: 'moved' });

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe('StopCard handled', () => {
  it('shows a collected stop coloured, in words, with no action and its "שלח תודה" row', () => {
    renderCard({ stop: COLLECTED });

    const card = screen.getAllByRole('listitem')[0];
    expect(card?.className).toBe('stop-card stop-card-handled');
    expect(screen.getByRole('heading', { level: 3, name: 'דנה כהן' })).toBeTruthy();
    expect(screen.getByText('נאסף')).toBeTruthy();
    expect(screen.getByText('שד נהר הדן 12')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link', { name: /^נווט/ })).toBeNull();
    expect(screen.queryByText('עצירה 2')).toBeNull();

    expect(screen.getByRole('heading', { level: 4, name: SEND_THANKS_TITLE })).toBeTruthy();
    const send = screen.getByRole('link', { name: 'שלח לדנה כהן' });
    expect(send.getAttribute('href')).toBe(THANK_YOU_URL);
  });

  it('does not take the focus when it is shown collected from the start', () => {
    renderCard({ stop: COLLECTED });
    expect(document.activeElement).toBe(document.body);
  });

  it('shows a collected stop without a thank-you to send with no row', () => {
    renderCard({ stop: { ...COLLECTED, thankYou: undefined } });
    expect(screen.getByText('נאסף')).toBeTruthy();
    expect(screen.queryByText(SEND_THANKS_TITLE)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it.each([
    ['notFound', 'לא נמצא'],
    ['cancelled', 'בוטלה'],
    ['left', 'יצאה מהסבב'],
  ] as const)('shows %s in words, with no action', (state, label) => {
    renderCard({ stop: makeStop({ state }) });

    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(SEND_THANKS_TITLE)).toBeNull();
  });

  it('shows an error in a handled card too', () => {
    renderCard({ stop: COLLECTED, error: 'העצירה הזאת כבר טופלה. נא לרענן את המסך.' });
    expect(screen.getByRole('alert').textContent).toBe('העצירה הזאת כבר טופלה. נא לרענן את המסך.');
  });
});

describe('StopCard current', () => {
  it('shows the "העצירה הבאה" card: name, address, spot, tags and the main buttons', () => {
    renderCard({ current: true });

    expect(screen.getByText(NEXT_STOP_EYEBROW)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'דנה כהן' })).toBeTruthy();
    expect(screen.getByText('שד נהר הדן 12')).toBeTruthy();
    expect(screen.getByText(/דלת הדירה/)).toBeTruthy();
    expect(screen.getByText('בסבב')).toBeTruthy();
    expect(screen.queryByText('בלי מיקום')).toBeNull();
    // Same Waze link as the plain card, and every name still carries the customer.
    expect(screen.getByRole('link', { name: 'נווט, דנה כהן' }).getAttribute('href')).toBe(
      wazeUrl(makeOrder().address),
    );
    expect(screen.getByRole('link', { name: /^חייג/ }).getAttribute('href')).toBe(
      'tel:+972501234567',
    );
    expect(button('אספתי, דנה כהן')).toBeTruthy();
    expect(button('עוד פעולות, דנה כהן')).toBeTruthy();
  });

  it('shows "בלי מיקום" for a stop without a map point', () => {
    renderCard({ current: true, stop: makeStop({ hasLocation: false }) });
    expect(screen.getByText('בלי מיקום')).toBeTruthy();
  });

  it('keeps "אספתי" working: the quantity field opens with the estimate', () => {
    const { calls } = renderCard({ current: true });
    fireEvent.click(button('אספתי, דנה כהן'));
    expect(quantityField().value).toBe('40');
    fireEvent.click(button('שמור'));
    expect(calls.collects).toEqual([40]);
  });
});
