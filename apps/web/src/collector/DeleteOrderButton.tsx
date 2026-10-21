// "מחיקת ההזמנה" (ADR-0008): Yoel removes a waiting or cancelled order for good, after a question in
// plain words. Used by the edit screen for an open order and for a cancelled one. It owns the
// request and what follows (back to the list with a notice, to the login, or the reason it was
// refused); the question itself is the shared CancelConfirm.
import { useEffect, useRef, useState } from 'react';
import { COLLECTOR_ORDER_MESSAGES, type CollectorOrder } from '@bottlerun/shared';
import { deleteCollectorOrder, type DeleteCollectorOrderOutcome } from '../api.ts';
import { CancelConfirm } from '../components/CancelConfirm.tsx';
import { navigate } from '../router.tsx';
import { FLASH_NOTICES, flashNoticeState } from './flashNotice.ts';
import { ORDERS_LIST_PATH } from './orderEditing.ts';

/** Shown in the question when the delete got no usable answer. */
export const DELETE_FAILED_MESSAGE = 'לא הצלחנו למחוק. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

/** Props of {@link DeleteOrderButton}. */
export interface DeleteOrderButtonProps {
  order: CollectorOrder;
  /** Deletes the order. Defaults to {@link deleteCollectorOrder}; tests pass a fake. */
  deleteOrder?: (id: string) => Promise<DeleteCollectorOrderOutcome>;
}

/**
 * The delete button and its question. Renders nothing for an order the api would refuse
 * (`order.deletable` false: collected, or in a round), so Yoel is never offered a dead button.
 */
export function DeleteOrderButton({
  order,
  deleteOrder = deleteCollectorOrder,
}: DeleteOrderButtonProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stops a second tap that comes before the re-render with `deleting`.
  const busyRef = useRef(false);
  // False once the screen is gone: a late answer must not pull Yoel back from where he went.
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  if (!order.deletable) return null;

  async function confirmDelete(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setDeleting(true);
    setError(null);
    let outcome: DeleteCollectorOrderOutcome;
    try {
      outcome = await deleteOrder(order.id);
    } catch {
      outcome = { kind: 'failed' };
    }
    busyRef.current = false;
    if (!mountedRef.current) return;
    setDeleting(false);

    switch (outcome.kind) {
      case 'deleted':
        // Replace, not push: "back" must not reopen the screen of an order that is gone.
        navigate(ORDERS_LIST_PATH, {
          replace: true,
          state: flashNoticeState(FLASH_NOTICES.orderDeleted),
        });
        return;
      case 'loggedOut':
        navigate('/login', { replace: true });
        return;
      case 'refused':
        setError(outcome.message || COLLECTOR_ORDER_MESSAGES.cannotDelete);
        return;
      case 'failed':
        setError(DELETE_FAILED_MESSAGE);
        return;
    }
  }

  return (
    <CancelConfirm
      buttonLabel="מחיקת ההזמנה"
      // The name is in the question, and "לצמיתות" says there is no way back, unlike "ביטול".
      question={`למחוק את ההזמנה של ${order.contact.name} לצמיתות? אי אפשר לשחזר אותה.`}
      confirmLabel="כן, למחוק"
      busyLabel="מוחק..."
      cancelling={deleting}
      error={error}
      onConfirm={() => void confirmDelete()}
      onOpenChange={() => setError(null)}
    />
  );
}
