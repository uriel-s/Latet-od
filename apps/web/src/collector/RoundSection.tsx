import { Icon } from '../components/Icon.tsx';
import { useEffect, useId, useRef } from 'react';
import {
  REGION_LABELS,
  ROUND_GROUP_KEYS,
  ROUND_GROUP_LABELS,
  formatDayMonth,
  formatIsraeliMobileLocal,
  type CollectorOrder,
  type RoundGroupKey,
  type RoundOrderGroup,
  type RoundView,
} from '@bottlerun/shared';
import {
  BuildRouteConfirm,
  buildRouteQuestion,
  type BuildRouteControl,
} from './BuildRouteConfirm.tsx';
import { CloseRoundConfirm, type CloseRoundConfirmProps } from './CloseRoundConfirm.tsx';
import { bottlesText, ordersText } from './countText.ts';
import { orderTags } from './orderTags.ts';
import { RouteScreen, type RouteScreenProps } from './RouteScreen.tsx';
import { SendList } from './SendList.tsx';

/** The summary of a group with no orders, in place of its count and list. */
export const EMPTY_ROUND_GROUP_TEXT = 'אין';

/** Above the "שלח" list: what one tap does, and the second tap that is left to Yoel (ADR-0003). */
export const SEND_LIST_HINT =
  'לחיצה על "שלח" פותחת את WhatsApp עם ההודעה כבר כתובה, ושם לוחצים "שלח".';

/** The heading of the round's "שלח" list in step 1. */
export const SEND_LIST_HEADING = 'הודעות ללקוחות';

/**
 * The colour of each group's count tile and badge (the `round-tile-*` / `badge-*` suffix): green for
 * the customers in the round, gray for another date. Decoration only: the words say which count it
 * is.
 */
const GROUP_COLOURS: Readonly<Record<RoundGroupKey, 'green' | 'gray'>> = {
  inRound: 'green',
  otherDate: 'gray',
};

/**
 * The orders of the group `key`, as the api listed them (plan order). The api always sends every
 * group; a missing one shows as empty rather than breaking the screen.
 */
function ordersOfGroup(groups: readonly RoundOrderGroup[], key: RoundGroupKey): CollectorOrder[] {
  return groups.find((group) => group.key === key)?.orders ?? [];
}

/**
 * The round's groups at a glance, in words and in {@link ROUND_GROUP_KEYS} order, e.g.
 * "בסבב: 5 · ביקשו מועד אחר: 1".
 */
export function roundGroupsSummary(groups: readonly RoundOrderGroup[]): string {
  return ROUND_GROUP_KEYS.map(
    (key) => `${ROUND_GROUP_LABELS[key]}: ${ordersOfGroup(groups, key).length}`,
  ).join(' · ');
}

/**
 * What a section needs for the close button, in either phase: everything of {@link CloseRoundConfirm}
 * but the view, which the section has already. RoundsScreen sends the request.
 */
type SectionCloseRound = Omit<CloseRoundConfirmProps, 'view'>;

/** What a step-2 section passes to its {@link RouteScreen}: everything but the view. */
type SectionRoute = Omit<RouteScreenProps, 'view'>;

/** Props of {@link RoundSection}. */
interface RoundSectionProps {
  view: RoundView;
  /** Step 1's last button. */
  buildRoute: BuildRouteControl;
  /** Step 2's route. */
  route: SectionRoute;
  /** The close button, the last button of either step. */
  closeRound: SectionCloseRound;
}

/**
 * One open round as a named region (its `<h2>`, the half of the city and the day, labels it), top
 * to bottom: the pickup times and the personal text that went into the messages, then the round's
 * step (spec §3.6).
 *
 * Step 1 (phase `confirming`, "תכנון", a stored name from before ADR-0012): the heading, the pickup
 * times (with a clock icon) and the personal text sit in ONE details card, which ends with coloured
 * count tiles (בסבב / ביקשו מועד אחר). The tiles are aria-hidden: a visually hidden live sentence
 * ({@link roundGroupsSummary}) says the same counts in words, so a screen reader hears them once and
 * hears the new counts after a reload. Then the grouped "שלח" list, the groups of orders as grouped
 * lists (every group shows, an empty one too, so the layout does not jump), and last "התחל מסלול":
 * the step that ends step 1 comes after everything Yoel checks before it. Nobody has to confirm
 * (ADR-0012): messages only announce the pickup, so there is no "did not confirm" group and no
 * "confirmed by phone" button.
 *
 * Step 2 (phase `routed`): the route alone, under the heading and texts as plain lines (no card,
 * no tiles). Its own summary takes the place of the group counts (one live summary per round, not
 * two), and the groups and the "שלח" list are gone.
 *
 * The details wrapper is rendered in both steps (only its class changes), so the `<h2>` stays
 * mounted across the build and the focus effect below can still reach it.
 *
 * Both steps end with the close button (CloseRoundConfirm.tsx), after the step's own last part (the
 * build question, or the route), so the quieter way out of the round comes after the way on. It
 * is rendered outside the step's branch, at one place in the section, so an open question (and the
 * thank-you rows Yoel tapped in it) stays mounted across every swapped view, a build included.
 *
 * When a build swaps step 1 for step 2, the question Yoel answered is gone, so the focus goes to
 * the round's heading, at the top of its route. Only when the focus was lost that way (on the page
 * itself, or still in this section): a notice the screen focused meanwhile keeps it, and so does
 * an open close question, which stays where it was.
 */
export function RoundSection({ view, buildRoute, route, closeRound }: RoundSectionProps) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLDivElement>(null);
  const { round, groups, sendList } = view;
  const routed = round.phase === 'routed';
  const wasRoutedRef = useRef(routed);

  useEffect(() => {
    const becameRouted = routed && !wasRoutedRef.current;
    wasRoutedRef.current = routed;
    if (!becameRouted) return;
    const active = document.activeElement;
    const focusLost =
      active === null ||
      active === document.body ||
      (sectionRef.current?.contains(active) === true &&
        closeRef.current?.contains(active) !== true);
    if (focusLost) headingRef.current?.focus();
  }, [routed]);

  // With both times, the start is when the bottles must be out AND when Yoel starts coming; the
  // window is his arrival (ADR-0012), as the customers' message says it.
  const pickupText =
    round.pickupBy === undefined ? null : round.pickupFrom !== undefined ? (
      <>
        להוציא את הבקבוקים עד <bdi dir="ltr">{round.pickupFrom}</bdi> · מגיעים בין{' '}
        <bdi dir="ltr">{round.pickupFrom}</bdi> ל-<bdi dir="ltr">{round.pickupBy}</bdi>
      </>
    ) : (
      <>
        להוציא את הבקבוקים עד <bdi dir="ltr">{round.pickupBy}</bdi>
      </>
    );

  return (
    <section ref={sectionRef} className="round" aria-labelledby={headingId}>
      {/* Always rendered, so the h2 inside stays mounted across the build (see the effect above);
          a card only in step 1; step 2 keeps the plain lines above its route. */}
      <div className={routed ? undefined : 'card round-details'}>
        {/* tabIndex -1: focused from code after the route is built, never a Tab stop. */}
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>
          {REGION_LABELS[round.region]} ·{' '}
          {/* DD/MM reads left to right inside the right-to-left text (CLAUDE.md). */}
          <bdi dir="ltr">{formatDayMonth(round.date)}</bdi>
        </h2>
        {pickupText !== null &&
          (routed ? (
            <p>{pickupText}</p>
          ) : (
            <p className="round-pickup">
              <Icon name="clock" />
              <span>{pickupText}</span>
            </p>
          ))}
        {round.personalText !== undefined && (
          <p className="round-personal-text">טקסט אישי: {round.personalText}</p>
        )}

        {!routed && (
          <>
            {/* Polite live text: a screen reader hears the new counts after a reload. Hidden,
                because the tiles below show the same counts to the eye. */}
            <p className="round-summary visually-hidden" aria-live="polite">
              {roundGroupsSummary(groups)}
            </p>
            {/* The same counts as coloured tiles; aria-hidden so they are not read twice. */}
            <div className="round-tiles" aria-hidden="true">
              {ROUND_GROUP_KEYS.map((key) => (
                <div key={key} className={`round-tile round-tile-${GROUP_COLOURS[key]}`}>
                  <b>{ordersOfGroup(groups, key).length}</b>
                  <span>{ROUND_GROUP_LABELS[key]}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {routed ? (
        // Not keyed by anything that changes: it stays mounted across every swapped view, so an
        // open quantity field and the "שלח תודה" rows Yoel tapped stay as they are.
        <RouteScreen view={view} {...route} />
      ) : (
        <>
          <h3>{SEND_LIST_HEADING}</h3>
          {sendList.length > 0 && <p className="round-hint">{SEND_LIST_HINT}</p>}
          {/* Always rendered at this place, so it stays mounted across a swapped view; it shows its
              own text when no message is left to send. */}
          <SendList rows={sendList} grouped />

          {ROUND_GROUP_KEYS.map((key) => (
            <RoundGroupSection key={key} groupKey={key} orders={ordersOfGroup(groups, key)} />
          ))}

          <BuildRouteConfirm
            question={buildRouteQuestion(ordersOfGroup(groups, 'inRound').length)}
            {...buildRoute}
          />
        </>
      )}

      {/* Outside the branch above, so it stays mounted when the build swaps the step. The wrapper
          lets the effect above tell focus in this question from focus lost. */}
      <div ref={closeRef}>
        <CloseRoundConfirm view={view} {...closeRound} />
      </div>
    </section>
  );
}

/** Props of {@link RoundGroupSection}. */
interface RoundGroupSectionProps {
  groupKey: RoundGroupKey;
  orders: readonly CollectorOrder[];
}

/**
 * One group of the round ("בסבב", "ביקשו מועד אחר") as a named region: its title
 * with a coloured count badge next to it, then ONE grouped-list card with a thin row per order, or
 * a quiet card with {@link EMPTY_ROUND_GROUP_TEXT} and no list. The badge is aria-hidden (a bare
 * number), so a visually hidden "2 הזמנות" beside it says the count in words; it sits outside the
 * `<h3>`, so the region's name stays the group's title.
 */
function RoundGroupSection({ groupKey, orders }: RoundGroupSectionProps) {
  const headingId = useId();

  return (
    <section className="round-group" aria-labelledby={headingId}>
      <div className="group-head">
        <h3 id={headingId}>{ROUND_GROUP_LABELS[groupKey]}</h3>
        <span className={`badge badge-${GROUP_COLOURS[groupKey]}`} aria-hidden="true">
          {orders.length}
        </span>
        {orders.length > 0 && <span className="visually-hidden">{ordersText(orders.length)}</span>}
      </div>
      {orders.length === 0 ? (
        <p className="card grouped-empty">{EMPTY_ROUND_GROUP_TEXT}</p>
      ) : (
        <ul className="card grouped-list">
          {orders.map((order) => (
            <RoundOrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One order of the round as a thin row of its group's list: the customer's name (the row's `<h4>`,
 * under the group's `<h3>`) over "street · bottles", and at the row's end a round call button that
 * dials. Under them, on a full line: its tags (in "ביקשו מועד אחר", why it left the round and the
 * day). The call button shows only a phone icon; the number, visually
 * hidden inside it, is its accessible name.
 */
function RoundOrderCard({ order }: { order: CollectorOrder }) {
  const { contact, address } = order;
  const tags = orderTags(order);

  return (
    <li className="grouped-row">
      <div className="grouped-row-main">
        <h4 className="grouped-row-title">{contact.name}</h4>
        <p className="grouped-row-meta">
          <span>
            {address.streetName} {address.houseNumber}
          </span>
          {' · '}
          <span>{bottlesText(order.bottlesEstimated)}</span>
        </p>
      </div>
      <a className="call-button" href={`tel:${contact.phone}`}>
        <Icon name="phone" />
        {/* Digits and hyphens read left to right inside the right-to-left text (CLAUDE.md). */}
        <span className="visually-hidden">
          <bdi dir="ltr">{formatIsraeliMobileLocal(contact.phone)}</bdi>
        </span>
      </a>
      {tags.length > 0 && (
        <p className="tag-list grouped-row-full">
          {tags.map((tag) => (
            <span key={tag} className="badge">
              {tag}
            </span>
          ))}
        </p>
      )}
    </li>
  );
}
