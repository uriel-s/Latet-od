// The request of one round action ("התחל מסלול", the close button), by round id: whether it is on
// its way and whether the last one failed. RoundsScreen keeps only what each answer does.
import { useRef, useState } from 'react';
import { useMountedRef } from '../useMountedRef.ts';
import { withId } from './withId.ts';

/** No usable answer, which every round action can get. */
interface Failed {
  kind: 'failed';
}

/** What {@link useRoundAction} gives the screen. */
export interface RoundAction<Answer> {
  /** The rounds whose request is on its way. */
  busyIds: ReadonlySet<string>;
  /** The rounds whose last request got no usable answer. */
  failedIds: ReadonlySet<string>;
  /**
   * Sends the request for `roundId` unless one is on its way. `settle` gets every answer but a
   * failed one, and only while the screen is still shown.
   */
  run: (roundId: string, settle: (answer: Answer) => void) => Promise<void>;
  /** Forgets that the last request for `roundId` failed (its question opened or closed). */
  clearFailed: (roundId: string) => void;
}

/** `onStart` runs once a request goes ahead, before it is sent. */
export function useRoundAction<Answer extends { kind: string }>(
  request: (roundId: string) => Promise<Answer | Failed>,
  onStart: () => void,
): RoundAction<Answer> {
  // The state reaches the handler only after a re-render; the ref stops a second tap that comes
  // before it, so one tap sends one request.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const busyIdsRef = useRef(new Set<string>());
  // An answer after Yoel left the tab must not pull him to the login.
  const mountedRef = useMountedRef();

  async function run(roundId: string, settle: (answer: Answer) => void): Promise<void> {
    if (busyIdsRef.current.has(roundId)) return;
    busyIdsRef.current.add(roundId);
    setBusyIds((previous) => withId(previous, roundId, true));
    setFailedIds((previous) => withId(previous, roundId, false));
    onStart();

    let answer: Answer | Failed;
    try {
      answer = await request(roundId);
    } catch {
      // The client never rejects, but a rejection must not leave the question on its busy label.
      answer = { kind: 'failed' };
    }
    busyIdsRef.current.delete(roundId);
    if (!mountedRef.current) return;
    setBusyIds((previous) => withId(previous, roundId, false));

    if (isFailed(answer)) {
      // Nothing to reload: the request may not have arrived. The question stays open for "כן".
      setFailedIds((previous) => withId(previous, roundId, true));
      return;
    }
    settle(answer);
  }

  function clearFailed(roundId: string): void {
    setFailedIds((previous) => withId(previous, roundId, false));
  }

  return { busyIds, failedIds, run, clearFailed };
}

function isFailed(answer: { kind: string }): answer is Failed {
  return answer.kind === 'failed';
}
