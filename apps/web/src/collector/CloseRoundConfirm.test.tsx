import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  CollectorOrder,
  CollectorRound,
  MessageLink,
  RoundView,
  RouteStopView,
} from '@bottlerun/shared';
import type { MarkMessageOpenedOutcome } from '../api.ts';
import {
  CLOSE_ROUND_NO_LABEL,
  CLOSE_ROUND_TEXTS,
  CloseRoundConfirm,
  UNSENT_THANK_YOUS_HINT,
  UNSENT_THANK_YOUS_TITLE,
  closeRoundQuestion,
  ordersSentBackCount,
  unsentThankYous,
  type CloseRoundConfirmProps,
} from './CloseRoundConfirm.tsx';

/** A confirmed order of the round; overrides change it. */
function makeOrder(overrides: Partial<CollectorOrder> = {}): CollectorOrder {
  return {
    id: 'o1',
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: 201,
      streetName: 'שד נהר הדן',
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
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

const DANA = makeOrder();
const MOSHE = makeOrder({ id: 'o2', contact: { name: 'משה לוי', phone: '+972527654321' } });
const YOSSI = makeOrder({ id: 'o3', contact: { name: 'יוסי מזרחי', phone: '+972501239999' } });
const RINA = makeOrder({ id: 'o4', contact: { name: 'רינה פרץ', phone: '+972541112222' } });

/** Round r1 in `phase`. */
function roundIn(phase: CollectorRound['phase']): CollectorRound {
  return {
    id: 'r1',
    date: '2026-11-19',
    region: 'ramat',
    status: 'open',
    phase,
    createdAt: new Date('2026-10-20T07:00:00Z'),
  };
}

/** A round still in step 1 with these groups; no route yet. */
function confirmingView({
  confirmed = [] as CollectorOrder[],
  pending = [] as CollectorOrder[],
  otherDate = [] as CollectorOrder[],
} = {}): RoundView {
  return {
    round: roundIn('confirming'),
    groups: [
      { key: 'confirmed', orders: confirmed },
      { key: 'pending', orders: pending },
      { key: 'otherDate', orders: otherDate },
    ],
    sendList: [],
    stops: [],
  };
}

/** A routed round with `stops` in their stored driving order. */
function routedView(stops: RouteStopView[]): RoundView {
  return {
    round: roundIn('routed'),
    groups: [
      { key: 'confirmed', orders: stops.map((stop) => stop.order) },
      { key: 'pending', orders: [] },
      { key: 'otherDate', orders: [] },
    ],
    sendList: [],
    stops,
  };
}

/** The "שלח תודה" link of `order`. */
function thankYouUrl(order: CollectorOrder): string {
  return `https://wa.me/${order.contact.phone.slice(1)}?text=${encodeURIComponent('תודה רבה')}`;
}

/** A stop of `order` still to collect. */
function toCollect(order: CollectorOrder): RouteStopView {
  return { order, hasLocation: true, state: 'toCollect' };
}

/** A collected stop of `order`, with its thank-you row unless `thankYou: false`. */
function collected(
  order: CollectorOrder,
  { thankYou = true, openedAt }: { thankYou?: boolean; openedAt?: Date } = {},
): RouteStopView {
  const link: MessageLink = {
    orderId: order.id,
    messageIndex: 1,
    kind: 'thankYou',
    name: order.contact.name,
    url: thankYouUrl(order),
    ...(openedAt === undefined ? {} : { openedAt }),
  };
  return {
    order: { ...order, status: 'collected' },
    hasLocation: true,
    state: 'collected',
    ...(thankYou ? { thankYou: link } : {}),
  };
}

const OPENED_AT = new Date('2026-11-19T09:00:00Z');

/** A fake `markOpened` that records its calls and answers `marked` at {@link OPENED_AT}. */
function fakeMarkOpened(): {
  markOpened: NonNullable<CloseRoundConfirmProps['markOpened']>;
  calls: { orderId: string; messageIndex: number }[];
} {
  const calls: { orderId: string; messageIndex: number }[] = [];
  const markOpened = (orderId: string, messageIndex: number) => {
    calls.push({ orderId, messageIndex });
    return Promise.resolve<MarkMessageOpenedOutcome>({ kind: 'marked', openedAt: OPENED_AT });
  };
  return { markOpened, calls };
}

/** Renders the component with fakes; returns the calls of each callback and `rerender`. */
function renderConfirm(overrides: Partial<CloseRoundConfirmProps> = {}) {
  const calls = { close: 0, openChange: 0 };
  const { markOpened } = fakeMarkOpened();
  const props = (next: Partial<CloseRoundConfirmProps>): CloseRoundConfirmProps => ({
    view: routedView([toCollect(DANA)]),
    closing: false,
    failed: false,
    onClose: () => {
      calls.close += 1;
    },
    onOpenChange: () => {
      calls.openChange += 1;
    },
    markOpened,
    ...overrides,
    ...next,
  });
  const result = render(<CloseRoundConfirm {...props({})} />);
  return {
    calls,
    rerender: (next: Partial<CloseRoundConfirmProps>) =>
      result.rerender(<CloseRoundConfirm {...props(next)} />),
  };
}

/** The close texts of the default (routed) view of {@link renderConfirm}. */
const ROUTED_TEXTS = CLOSE_ROUND_TEXTS.routed;

/** Taps the close button ("סיימתי את הסבב" by default) and returns the question group that opens. */
function openQuestion(buttonName: string = ROUTED_TEXTS.label): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: buttonName }));
  return screen.getByRole('group');
}

describe('unsentThankYous', () => {
  it('lists the unopened thank-yous of collected stops, in route order', () => {
    const view = routedView([
      collected(MOSHE),
      toCollect(DANA),
      collected(YOSSI, { openedAt: OPENED_AT }),
      collected(RINA, { thankYou: false }),
      collected(DANA),
    ]);

    expect(unsentThankYous(view).map((row) => row.orderId)).toEqual(['o2', 'o1']);
  });

  it('ignores a thankYou on a stop that is not collected', () => {
    const odd: RouteStopView = { ...collected(MOSHE), state: 'notFound' };

    expect(unsentThankYous(routedView([odd]))).toEqual([]);
  });

  it('is empty for a round with no route', () => {
    expect(unsentThankYous(confirmingView({ confirmed: [DANA] }))).toEqual([]);
  });
});

describe('ordersSentBackCount', () => {
  it('counts the confirmed and pending orders of a confirming round, not "ביקשו מועד אחר"', () => {
    const view = confirmingView({
      confirmed: [DANA],
      pending: [
        makeOrder({ ...MOSHE, status: 'pending' }),
        makeOrder({ ...YOSSI, status: 'pending' }),
      ],
      otherDate: [makeOrder({ ...RINA, status: 'waiting' })],
    });

    expect(ordersSentBackCount(view)).toBe(3);
  });

  it('does not count a collected order in the "אישרו" group', () => {
    const view = confirmingView({
      confirmed: [DANA, makeOrder({ ...MOSHE, status: 'collected' })],
    });

    expect(ordersSentBackCount(view)).toBe(1);
  });

  it('counts only the stops still to collect in a routed round', () => {
    const view = routedView([
      collected(DANA),
      toCollect(MOSHE),
      { order: YOSSI, hasLocation: true, state: 'notFound' },
      toCollect(RINA),
    ]);

    expect(ordersSentBackCount(view)).toBe(2);
  });
});

describe('closeRoundQuestion', () => {
  it('says no one goes back when the count is 0, in both phases', () => {
    expect(closeRoundQuestion(0, 'confirming')).toBe('אף לקוח לא יחזור לחכות. לבטל את הסבב?');
    expect(closeRoundQuestion(0, 'routed')).toBe('אף לקוח לא יחזור לחכות. לסיים את הסבב?');
  });

  it('counts the customers of a confirming round, singular and plural', () => {
    expect(closeRoundQuestion(1, 'confirming')).toBe(
      'לקוח אחד יחזור לחכות לסבב הבא. לבטל את הסבב?',
    );
    expect(closeRoundQuestion(4, 'confirming')).toBe(
      '4 לקוחות יחזרו לחכות לסבב הבא. לבטל את הסבב?',
    );
  });

  it('names the customers not collected yet in a routed round, singular and plural', () => {
    expect(closeRoundQuestion(1, 'routed')).toBe(
      'לקוח אחד שעוד לא אספנו ממנו יחזור לחכות לסבב הבא. לסיים את הסבב?',
    );
    expect(closeRoundQuestion(2, 'routed')).toBe(
      '2 לקוחות שעוד לא אספנו מהם יחזרו לחכות לסבב הבא. לסיים את הסבב?',
    );
  });
});

describe('CloseRoundConfirm', () => {
  it('starts as one outline "סיימתי את הסבב" button in a routed round', () => {
    renderConfirm();

    const button = screen.getByRole('button', { name: 'סיימתי את הסבב' });
    expect(button.className).toContain('button-secondary');
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('asks first, counting from the view, with the focus on the question', () => {
    const { calls } = renderConfirm({
      view: routedView([collected(DANA, { thankYou: false }), toCollect(MOSHE), toCollect(YOSSI)]),
    });

    const question = openQuestion();

    const text = '2 לקוחות שעוד לא אספנו מהם יחזרו לחכות לסבב הבא. לסיים את הסבב?';
    expect(screen.getByRole('group', { name: text })).toBe(question);
    expect(within(question).getByText(text)).toBe(document.activeElement);
    expect(within(question).getByRole('button', { name: 'כן, לסיים' })).toBeDefined();
    expect(within(question).getByRole('button', { name: CLOSE_ROUND_NO_LABEL })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'סיימתי את הסבב' })).toBeNull();
    expect(calls.openChange).toBe(1);
    // No thank-you to send: no list and no heading.
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('asks about every order still in a confirming round, as "בטל את הסבב"', () => {
    renderConfirm({
      view: confirmingView({
        confirmed: [DANA],
        pending: [makeOrder({ ...MOSHE, status: 'pending' })],
      }),
    });

    openQuestion('בטל את הסבב');

    expect(
      screen.getByRole('group', { name: '2 לקוחות יחזרו לחכות לסבב הבא. לבטל את הסבב?' }),
    ).toBeDefined();
  });

  it('closes on "לא, עוד לא" without closing the round, the focus back on the button', () => {
    const { calls } = renderConfirm();
    openQuestion();

    fireEvent.click(screen.getByRole('button', { name: CLOSE_ROUND_NO_LABEL }));

    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: ROUTED_TEXTS.label }));
    expect(calls.close).toBe(0);
    expect(calls.openChange).toBe(2);
  });

  it('calls onClose on "כן, לסיים", every tap', () => {
    const { calls } = renderConfirm();
    openQuestion();

    const yes = screen.getByRole('button', { name: ROUTED_TEXTS.yesLabel });
    fireEvent.click(yes);
    fireEvent.click(yes);

    expect(calls.close).toBe(2);
  });

  it('shows the busy label while closing, both answers aria-disabled, and "לא" does nothing', () => {
    const { rerender } = renderConfirm();
    openQuestion();

    rerender({ closing: true });

    const busy = screen.getByRole('button', { name: ROUTED_TEXTS.busyLabel });
    expect(ROUTED_TEXTS.busyLabel).toBe('מסיים סבב...');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    const no = screen.getByRole('button', { name: CLOSE_ROUND_NO_LABEL });
    expect(no.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(no);
    expect(screen.getByRole('group')).toBeDefined();
  });

  it('shows a failed close inside the question, which stays open', () => {
    const { rerender } = renderConfirm();
    const question = openQuestion();

    rerender({ failed: true });

    expect(within(question).getByRole('alert').textContent).toBe(ROUTED_TEXTS.failedMessage);
    expect(ROUTED_TEXTS.failedMessage).toBe('לא הצלחנו לסיים את הסבב. נא לנסות שוב.');
    expect(within(question).getByRole('button', { name: ROUTED_TEXTS.yesLabel })).toBeDefined();
  });

  describe('texts by phase', () => {
    const CONFIRMING = confirmingView({ confirmed: [DANA] });

    it('reads "סיימתי את הסבב" / "לסיים את הסבב?" / "כן, לסיים" once the round is routed', () => {
      renderConfirm({ view: routedView([toCollect(DANA)]) });

      const question = openQuestion('סיימתי את הסבב');

      expect(within(question).getByText(/לסיים את הסבב\?$/)).toBeDefined();
      expect(within(question).getByRole('button', { name: 'כן, לסיים' })).toBeDefined();
    });

    it('reads "בטל את הסבב" / "לבטל את הסבב?" / "כן, לבטל את הסבב" while confirming', () => {
      renderConfirm({ view: CONFIRMING });

      expect(screen.queryByRole('button', { name: 'סיימתי את הסבב' })).toBeNull();
      const question = openQuestion('בטל את הסבב');

      expect(within(question).getByText(/לבטל את הסבב\?$/)).toBeDefined();
      expect(within(question).getByRole('button', { name: 'כן, לבטל את הסבב' })).toBeDefined();
      expect(within(question).getByRole('button', { name: CLOSE_ROUND_NO_LABEL })).toBeDefined();
    });

    it('has the busy and failed texts of each phase', () => {
      expect(CLOSE_ROUND_TEXTS.routed.busyLabel).toBe('מסיים סבב...');
      expect(CLOSE_ROUND_TEXTS.routed.failedMessage).toBe('לא הצלחנו לסיים את הסבב. נא לנסות שוב.');
      expect(CLOSE_ROUND_TEXTS.confirming.busyLabel).toBe('מבטל סבב...');
      expect(CLOSE_ROUND_TEXTS.confirming.failedMessage).toBe(
        'לא הצלחנו לבטל את הסבב. נא לנסות שוב.',
      );

      const { rerender } = renderConfirm({ view: CONFIRMING });
      const question = openQuestion('בטל את הסבב');
      rerender({ closing: true });
      expect(within(question).getByRole('button', { name: 'מבטל סבב...' })).toBeDefined();
      rerender({ closing: false, failed: true });
      expect(within(question).getByRole('alert').textContent).toBe(
        'לא הצלחנו לבטל את הסבב. נא לנסות שוב.',
      );
    });
  });

  describe('"תודות שלא נשלחו"', () => {
    const VIEW = routedView([
      collected(DANA),
      collected(MOSHE, { openedAt: OPENED_AT }),
      collected(YOSSI, { thankYou: false }),
      toCollect(RINA),
    ]);

    it('lists only the collected stops with an unopened thank-you, the focus on its heading', () => {
      renderConfirm({ view: VIEW });

      const question = openQuestion();

      const heading = within(question).getByRole('heading', { name: UNSENT_THANK_YOUS_TITLE });
      expect(heading.tagName).toBe('H3');
      expect(document.activeElement).toBe(heading);
      expect(within(question).getByText(UNSENT_THANK_YOUS_HINT)).toBeDefined();
      const items = within(question).getAllByRole('listitem');
      expect(items).toHaveLength(1);
      const link = within(items[0]!).getByRole('link', { name: 'שלח לדנה כהן' });
      expect(link.getAttribute('href')).toBe(thankYouUrl(DANA));
    });

    it('comes before the question in the group', () => {
      renderConfirm({ view: VIEW });

      const question = openQuestion();

      const list = within(question).getByRole('list');
      const text = within(question).getByText(/לסיים את הסבב\?$/);
      expect(list.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });

    it('marks a row opened through markOpened', async () => {
      const { markOpened, calls } = fakeMarkOpened();
      renderConfirm({ view: VIEW, markOpened });
      openQuestion();

      fireEvent.click(screen.getByRole('link', { name: 'שלח לדנה כהן' }));

      expect(calls).toEqual([{ orderId: 'o1', messageIndex: 1 }]);
      await waitFor(() => {
        expect(screen.getByRole('link', { name: 'שלח שוב לדנה כהן' })).toBeDefined();
      });
    });

    it('keeps a row opened in a newer view, marked opened, and adds a newly unsent one', () => {
      const { rerender } = renderConfirm({ view: VIEW });
      openQuestion();

      // Back from WhatsApp: the reload's view has דנה opened, and רינה collected meanwhile.
      rerender({
        view: routedView([
          collected(DANA, { openedAt: OPENED_AT }),
          collected(MOSHE, { openedAt: OPENED_AT }),
          collected(YOSSI, { thankYou: false }),
          collected(RINA),
        ]),
      });

      const items = within(screen.getByRole('group')).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(within(items[0]!).getByText('דנה כהן')).toBeDefined();
      expect(within(items[0]!).getByText(/נפתח/)).toBeDefined();
      expect(within(items[0]!).getByRole('link', { name: 'שלח שוב לדנה כהן' })).toBeDefined();
      expect(within(items[1]!).getByRole('link', { name: 'שלח לרינה פרץ' })).toBeDefined();
      // The count follows the newer view: no stop is left to collect.
      expect(
        screen.getByRole('group', { name: 'אף לקוח לא יחזור לחכות. לסיים את הסבב?' }),
      ).toBeDefined();
    });

    it('forgets the kept rows when the question closes', () => {
      const { rerender } = renderConfirm({ view: VIEW });
      openQuestion();
      rerender({ view: routedView([collected(DANA, { openedAt: OPENED_AT })]) });
      fireEvent.click(screen.getByRole('button', { name: CLOSE_ROUND_NO_LABEL }));

      openQuestion();

      expect(screen.queryByRole('heading', { name: UNSENT_THANK_YOUS_TITLE })).toBeNull();
      expect(screen.queryByRole('list')).toBeNull();
    });
  });
});
