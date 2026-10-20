// The "שלח" list of the collector app (ADR-0003): one row per customer with a link that opens
// WhatsApp with the message already written (a wa.me url), for Yoel to tap "send" there. Tapping
// marks the row opened at once and tells the api (markMessageOpened), so a row he already sent
// stands out. Reusable: the hosting screen (a planned round, section 8) owns the heading and
// passes the rows (`MessageLink`, built by the api with `toMessageLink`).
import { useEffect, useRef, useState } from 'react';
import { formatDayMonth, type MessageLink } from '@bottlerun/shared';
import { markMessageOpened, type MarkMessageOpenedOutcome } from '../api.ts';
import { navigate } from '../router.tsx';

/** Shown in place of the list when there is no message to send. */
export const EMPTY_SEND_LIST_TEXT = 'אין הודעות לשליחה.';

/**
 * Shown in a row whose opening the api did not store (no answer, a 5xx, or the message is gone).
 * The row still shows as opened: Yoel did open the link, whatever the api answered.
 */
export const MARK_OPENED_FAILED_MESSAGE = 'לא הצלחנו לשמור שההודעה נפתחה.';

/** Props of {@link SendList}. */
export interface SendListProps {
  /** The rows to show, in the order given; a row whose `openedAt` is set starts as opened. */
  rows: readonly MessageLink[];
  /** Stores that a row's link was opened. Defaults to {@link markMessageOpened}; tests pass a fake. */
  markOpened?: (orderId: string, messageIndex: number) => Promise<MarkMessageOpenedOutcome>;
}

/**
 * What the list knows about a row beyond its props, once Yoel tapped it here: the row is opened.
 * `openedAt` is the api's answer (undefined until it comes, or when it did not); `saveFailed` is
 * true when the api did not store the opening.
 */
interface OpenedLocally {
  openedAt: Date | undefined;
  saveFailed: boolean;
}

/**
 * The key of a row, in React and in the local state: one message of one order. A round planned
 * again gives the order a new entry, so a new index and a new row. Unambiguous although an id
 * could hold a ':', since the index after the last ':' is a whole number.
 */
function rowKey(row: Pick<MessageLink, 'orderId' | 'messageIndex'>): string {
  return `${row.orderId}:${row.messageIndex}`;
}

/**
 * The "שלח" list: each row the customer's name and a "שלח" link to the row's wa.me url, opened in
 * a new tab or the WhatsApp app. A real `<a href>` that the browser follows, never `window.open`
 * after an await: a tap on a link is what mobile browsers reliably hand to WhatsApp, and it is
 * never blocked as a popup.
 *
 * The tap marks the row opened at once, then calls `markOpened`. `marked` shows the api's
 * `openedAt` as DD/MM; `loggedOut` goes to /login; `notFound` and `failed` keep the row opened
 * and add {@link MARK_OPENED_FAILED_MESSAGE}. An opened row keeps its link, as "שלח שוב", for a
 * message that did not go. The local state is kept by row key, so new `rows` from the hosting
 * screen keep what was tapped. No `<h1>`: the hosting screen has the page's heading.
 */
export function SendList({ rows, markOpened = markMessageOpened }: SendListProps) {
  const [openedLocally, setOpenedLocally] = useState<Readonly<Record<string, OpenedLocally>>>({});
  // False once the list is gone: an answer that comes after Yoel left the screen must not pull
  // him to the login from the screen he went to.
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** The local state of `key` after `change`; the other rows stay as they are. */
  function updateRow(key: string, change: (previous: OpenedLocally | undefined) => OpenedLocally) {
    setOpenedLocally((previous) => ({ ...previous, [key]: change(previous[key]) }));
  }

  /**
   * Yoel tapped "שלח": the browser opens the url by itself (no preventDefault), and this marks the
   * row and stores the opening. Every tap calls the api, a second one too: the api answers the
   * first `openedAt` and writes nothing, and a tap that failed before gets another chance.
   */
  function handleOpen(row: MessageLink): void {
    const key = rowKey(row);
    updateRow(key, (previous) => ({ openedAt: previous?.openedAt, saveFailed: false }));

    function settle(outcome: MarkMessageOpenedOutcome): void {
      if (!mountedRef.current) return;
      switch (outcome.kind) {
        case 'marked':
          updateRow(key, () => ({ openedAt: outcome.openedAt, saveFailed: false }));
          return;
        case 'loggedOut':
          // Replace, not push: "back" from the login must not land on a screen that needs it.
          navigate('/login', { replace: true });
          return;
        case 'notFound':
        case 'failed':
          updateRow(key, (previous) => ({ openedAt: previous?.openedAt, saveFailed: true }));
          return;
      }
    }

    // markMessageOpened never rejects; a rejection is a failed save like any other.
    markOpened(row.orderId, row.messageIndex).then(settle, () => settle({ kind: 'failed' }));
  }

  if (rows.length === 0) return <p>{EMPTY_SEND_LIST_TEXT}</p>;

  return (
    <ul className="send-list">
      {rows.map((row) => {
        const key = rowKey(row);
        return (
          <SendRow key={key} row={row} local={openedLocally[key]} onOpen={() => handleOpen(row)} />
        );
      })}
    </ul>
  );
}

/** Props of {@link SendRow}. */
interface SendRowProps {
  row: MessageLink;
  /** What this list knows of the row beyond its props; undefined until Yoel taps it here. */
  local: OpenedLocally | undefined;
  onOpen: () => void;
}

/**
 * One customer. Opened (by the props or by a tap here) shows "נפתח ✓" with the day when it is
 * known, a modifier class, and the link as "שלח שוב" in the quieter outline style, so the rows
 * still to send are the filled ones. The words carry the meaning, never the colour alone.
 */
function SendRow({ row, local, onOpen }: SendRowProps) {
  const opened = row.openedAt !== undefined || local !== undefined;
  // The stored value first: once set, the api never changes it, so both agree when both exist.
  const openedAt = row.openedAt ?? local?.openedAt;
  // A failed save of an opening the api already stored loses nothing: no note then.
  const showSaveFailed = local?.saveFailed === true && openedAt === undefined;
  const linkText = opened ? 'שלח שוב' : 'שלח';

  return (
    <li className={opened ? 'send-row send-row-opened' : 'send-row'}>
      <p className="send-row-name">{row.name}</p>
      {opened && (
        <p className="send-row-mark">
          נפתח <span aria-hidden="true">✓</span>
          {openedAt !== undefined && (
            <>
              {' · '}
              {/* DD/MM reads left to right inside the right-to-left text (CLAUDE.md). */}
              <bdi dir="ltr">{formatDayMonth(openedAt)}</bdi>
            </>
          )}
        </p>
      )}
      {/* The visible word alone would be the same in every row; the hidden rest names the
          customer, so a screen reader's list of links tells the rows apart. The visible word
          starts the name, as WCAG 2.5.3 (label in name) asks, so voice control finds it. */}
      <a
        className={
          opened ? 'button button-secondary send-row-link' : 'button button-primary send-row-link'
        }
        href={row.url}
        // WhatsApp opens in its app or a new tab, and the list stays here for the next row.
        // noopener: WhatsApp's page gets no handle on this one; noreferrer: nor the app's path.
        target="_blank"
        rel="noopener noreferrer"
        onClick={onOpen}
      >
        {/* The space stays outside the hidden span: a space at the start of an element's own
            text is dropped when the accessible name is put together ("שלחלדנה"). */}
        {linkText} <span className="visually-hidden">ל{row.name}</span>
      </a>
      {showSaveFailed && (
        <p className="send-row-note" role="alert">
          {MARK_OPENED_FAILED_MESSAGE}
        </p>
      )}
    </li>
  );
}
