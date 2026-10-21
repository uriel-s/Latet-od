import { StrictMode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  COLLECT_STOP_ERRORS,
  MAX_BOTTLES,
  type CollectorOrder,
  type RouteStopView,
} from '@bottlerun/shared';
import type { MarkMessageOpenedOutcome } from '../api.ts';
import {
  BOTTLES_COLLECTED_LABEL,
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

const markOpened = (): Promise<MarkMessageOpenedOutcome> =>
  Promise.resolve({ kind: 'marked', openedAt: new Date('2026-10-20T08:00:00Z') });

/** Renders one card inside a list, as the route screen does, recording every callback. */
function renderCard(overrides: Partial<StopCardProps> = {}): {
  calls: Calls;
  rerender: (next: Partial<StopCardProps>) => void;
  unmount: () => void;
} {
  const calls: Calls = { moves: [], collects: [], notFounds: 0, typing: [] };
  const props = (next: Partial<StopCardProps>): StopCardProps => ({
    stop: makeStop(),
    position: 2,
    canMoveUp: true,
    canMoveDown: true,
    busy: false,
    onMove: (direction) => calls.moves.push(direction),
    onCollect: (bottles) => calls.collects.push(bottles),
    onNotFound: () => {
      calls.notFounds += 1;
    },
    onTypingChange: (typing) => calls.typing.push(typing),
    markOpened,
    ...overrides,
    ...next,
  });
  const result = render(
    <ol>
      <StopCard {...props({})} />
    </ol>,
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

describe('StopCard to collect', () => {
  it('shows the position, the name as a heading, the full address and the bottles', () => {
    renderCard();

    const card = screen.getByRole('listitem');
    expect(within(card).getByText('עצירה 2')).toBeTruthy();
    expect(within(card).getByRole('heading', { level: 3, name: 'דנה כהן' })).toBeTruthy();
    expect(within(card).getByText('שד נהר הדן 12')).toBeTruthy();
    expect(within(card).getByText('בבניין - ליד דלת הדירה · קומה 3, דירה 12')).toBeTruthy();
    expect(within(card).getByText('הערה: ליד העגלה')).toBeTruthy();
    expect(within(card).getByText('40 בקבוקים')).toBeTruthy();
    expect(within(card).queryByText('בלי מיקום')).toBeNull();
    expect(card.className).toBe('stop-card');
  });

  it('leaves out the floor and the note when there are none', () => {
    renderCard({
      stop: makeStop({
        order: makeOrder({
          address: {
            streetName: 'הרצל',
            houseNumber: '5',
            bottlesSpot: 'privateHouse',
          },
        }),
      }),
    });

    expect(screen.queryByText(/^הערה:/)).toBeNull();
    expect(screen.getByText('הרצל 5')).toBeTruthy();
    expect(screen.getByText('בכניסה לבית פרטי')).toBeTruthy();
  });

  it('tags "בלי מיקום" by the stored flag of the stop, not the order', () => {
    renderCard({ stop: makeStop({ hasLocation: false, order: makeOrder({ hasLocation: true }) }) });
    expect(screen.getByText('בלי מיקום')).toBeTruthy();
  });

  it('shows no "בלי מיקום" when the stop had a point, although the order has none now', () => {
    renderCard({ stop: makeStop({ hasLocation: true, order: makeOrder({ hasLocation: false }) }) });
    expect(screen.queryByText('בלי מיקום')).toBeNull();
  });

  it('links "נווט" to Waze with the address and the city encoded, in a new tab', () => {
    renderCard();

    const link = screen.getByRole('link', { name: 'נווט, דנה כהן' });
    expect(link.getAttribute('href')).toBe(
      `https://waze.com/ul?q=${encodeURIComponent('שד נהר הדן 12, בית שמש')}&navigate=yes`,
    );
    expect(link.getAttribute('href')).toContain('%D7%A9%D7%93');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')?.split(' ')).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer']),
    );
  });

  it('links "חייג" to the phone, with the number shown left to right', () => {
    renderCard();

    const link = screen.getByRole('link', { name: /^חייג 050-1234567/ });
    expect(link.getAttribute('href')).toBe('tel:+972501234567');
    const digits = within(link).getByText('050-1234567');
    expect(digits.tagName).toBe('BDI');
    expect(digits.getAttribute('dir')).toBe('ltr');
  });

  it('shows both arrows and moves the stop up or down', () => {
    const { calls } = renderCard();

    const up = button('הזז למעלה, דנה כהן');
    expect(up.textContent).toContain('הזז למעלה');
    fireEvent.click(up);
    fireEvent.click(button('הזז למטה, דנה כהן'));

    expect(calls.moves).toEqual(['up', 'down']);
  });

  it('shows only the arrows that can move', () => {
    renderCard({ canMoveUp: false, canMoveDown: true });
    expect(screen.queryByRole('button', { name: /^הזז למעלה/ })).toBeNull();
    expect(button(/^הזז למטה/)).toBeTruthy();
  });

  it('shows no arrow for the only stop left', () => {
    renderCard({ canMoveUp: false, canMoveDown: false });
    expect(screen.queryByRole('button', { name: /^הזז/ })).toBeNull();
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

    rerender({ busy: false, stop: COLLECTED });
    expect(screen.queryByLabelText(BOTTLES_COLLECTED_LABEL)).toBeNull();
    expect(calls.typing).toEqual([true, false]);
    // Yoel's own save: the focus goes to the thank-you he sends next.
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

describe('StopCard "לא נמצא"', () => {
  it('asks first, then calls onNotFound on "כן, לא נמצא"', () => {
    const { calls } = renderCard();

    fireEvent.click(button('לא נמצא, דנה כהן'));
    const question = screen.getByRole('group', { name: NOT_FOUND_QUESTION });
    expect(document.activeElement).toBe(within(question).getByText(NOT_FOUND_QUESTION));
    expect(calls.notFounds).toBe(0);

    fireEvent.click(within(question).getByRole('button', { name: 'כן, לא נמצא' }));
    expect(calls.notFounds).toBe(1);
  });

  it('closes the question on "לא", with the focus back on "לא נמצא"', () => {
    const { calls } = renderCard();
    fireEvent.click(button('לא נמצא, דנה כהן'));

    fireEvent.click(button('לא'));

    expect(screen.queryByRole('group', { name: NOT_FOUND_QUESTION })).toBeNull();
    expect(document.activeElement).toBe(button('לא נמצא, דנה כהן'));
    expect(calls.notFounds).toBe(0);
    expect(calls.typing).toEqual([]);
  });
});

describe('StopCard busy', () => {
  it('marks every button aria-disabled and ignores the taps', () => {
    const { calls } = renderCard({ busy: true });

    for (const name of ['אספתי, דנה כהן', 'לא נמצא, דנה כהן', 'הזז למעלה, דנה כהן']) {
      expect(button(name).getAttribute('aria-disabled')).toBe('true');
    }
    fireEvent.click(button('אספתי, דנה כהן'));
    fireEvent.click(button('לא נמצא, דנה כהן'));
    fireEvent.click(button('הזז למעלה, דנה כהן'));
    fireEvent.click(button('הזז למטה, דנה כהן'));

    expect(screen.queryByLabelText(BOTTLES_COLLECTED_LABEL)).toBeNull();
    expect(screen.queryByRole('group', { name: NOT_FOUND_QUESTION })).toBeNull();
    expect(calls).toEqual({ moves: [], collects: [], notFounds: 0, typing: [] });
  });

  it('ignores "כן, לא נמצא" and "לא" while the answer is on its way', () => {
    const { calls, rerender } = renderCard();
    fireEvent.click(button('לא נמצא, דנה כהן'));
    rerender({ busy: true });

    fireEvent.click(button('שומר...'));
    fireEvent.click(button('לא'));

    expect(screen.getByRole('group', { name: NOT_FOUND_QUESTION })).toBeTruthy();
    expect(calls.notFounds).toBe(0);
  });
});

describe('StopCard error', () => {
  it('shows why the last action failed, as an alert in the card', () => {
    renderCard({ error: 'לא הצלחנו לשמור. נא לנסות שוב.' });
    expect(screen.getByRole('alert').textContent).toBe('לא הצלחנו לשמור. נא לנסות שוב.');
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

  it('closes the "לא נמצא" question once the stop is not found', () => {
    const { rerender } = renderCard();
    fireEvent.click(button('לא נמצא, דנה כהן'));
    rerender({ stop: makeStop({ state: 'notFound' }) });
    expect(screen.queryByRole('group', { name: NOT_FOUND_QUESTION })).toBeNull();
    expect(screen.getByText('לא נמצא')).toBeTruthy();
  });

  it('shows an error in a handled card too', () => {
    renderCard({ stop: COLLECTED, error: 'העצירה הזאת כבר טופלה. נא לרענן את המסך.' });
    expect(screen.getByRole('alert').textContent).toBe('העצירה הזאת כבר טופלה. נא לרענן את המסך.');
  });
});
