// Accessible control for enabling, disabling, and checking Web Push notifications (ADR-0013).
//
// Mounted on the collector orders screen (OrdersScreen.tsx): checks if push is supported and
// configured on the server (GET /api/collector/push/config), registers /sw.js, manages device
// PushSubscription, and syncs subscription state with the server.
import { useEffect, useState } from 'react';
import type { PushSubscription as PushSubscriptionBody } from '@bottlerun/shared';
import {
  deletePushSubscription,
  fetchPushConfig,
  savePushSubscription,
  type PushConfigOutcome,
} from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { navigate } from '../router.tsx';

/** Converts a base64url-encoded VAPID public key into a Uint8Array for PushManager.subscribe. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** Builds the request body for the server from a browser subscription; null if it lacks endpoint or keys. */
function toServerSubscription(sub: PushSubscription): PushSubscriptionBody | null {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

export type PushControlState =
  'unsupported' | 'checking' | 'disabled' | 'blocked' | 'inactive' | 'active';

export interface PushNotificationsControlProps {
  /** Injected push config fetcher for testing. */
  loadConfig?: () => Promise<PushConfigOutcome>;
  /** Injected subscription saver for testing. */
  saveSub?: typeof savePushSubscription;
  /** Injected subscription remover for testing. */
  deleteSub?: typeof deletePushSubscription;
}

/**
 * Push notifications toggle button for the collector app.
 *
 * Renders nothing if Web Push is not supported in this browser or disabled on the server.
 */
export function PushNotificationsControl({
  loadConfig = fetchPushConfig,
  saveSub = savePushSubscription,
  deleteSub = deletePushSubscription,
}: PushNotificationsControlProps) {
  const [state, setState] = useState<PushControlState>('checking');
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function checkState(): Promise<void> {
      // 1. Browser feature detection
      if (
        typeof window === 'undefined' ||
        !('serviceWorker' in navigator) ||
        !('PushManager' in window) ||
        !('Notification' in window)
      ) {
        if (active) setState('unsupported');
        return;
      }

      // 2. Fetch server push configuration
      const configOutcome = await loadConfig();
      if (!active) return;
      if (configOutcome.kind !== 'loaded' || !configOutcome.config.enabled) {
        setState('disabled');
        return;
      }

      const key = configOutcome.config.publicKey;
      setPublicKey(key);

      // 3. Check browser notification permission
      if (Notification.permission === 'denied') {
        setState('blocked');
        return;
      }

      // 4. Check active registration and subscription
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!active) return;
        if (!registration) {
          setState('inactive');
          return;
        }
        const existingSub = await registration.pushManager.getSubscription();
        if (!active) return;
        if (!existingSub) {
          setState('inactive');
          return;
        }

        // The device is subscribed, but the server may have lost it (an earlier save failed, the
        // push service rotated the endpoint, or it was pruned). Re-send it (the server upsert is
        // idempotent) so "active" on screen means the server really has it; otherwise Yoel would
        // silently get no notifications.
        const body = toServerSubscription(existingSub);
        if (!body) {
          setState('inactive');
          return;
        }
        const syncOutcome = await saveSub(body);
        if (!active) return;
        if (syncOutcome.kind === 'loggedOut') {
          navigate('/login', { replace: true });
          return;
        }
        setState(syncOutcome.kind === 'saved' ? 'active' : 'inactive');
      } catch {
        if (active) setState('inactive');
      }
    }

    void checkState();

    return () => {
      active = false;
    };
  }, [loadConfig, saveSub]);

  async function toggle(): Promise<void> {
    if (busy || !publicKey) return;
    setBusy(true);
    setErrorMessage(null);

    try {
      if (state === 'active') {
        // Turn notifications off: unsubscribe device and delete from server
        const registration = await navigator.serviceWorker.getRegistration();
        const existingSub = await registration?.pushManager.getSubscription();
        if (existingSub) {
          // Server first, device second: if the server call fails we stop with the device still
          // subscribed and the state still "active", so the screen tells the truth and a retry
          // works. (The server delete is idempotent, so a retry after a failed
          // `unsubscribe()` is safe too.)
          const deleteOutcome = await deleteSub(existingSub.endpoint);
          if (deleteOutcome.kind === 'loggedOut') {
            navigate('/login', { replace: true });
            return;
          }
          if (deleteOutcome.kind === 'failed') {
            setErrorMessage('לא הצלחנו להסיר את המנוי מהשרת.');
            return;
          }
          await existingSub.unsubscribe();
        }
        setState('inactive');
      } else if (state === 'inactive') {
        // Request notification permission if needed
        let permission = Notification.permission;
        if (permission === 'default') {
          permission = await Notification.requestPermission();
        }

        if (permission === 'denied') {
          setState('blocked');
          setBusy(false);
          return;
        }

        if (permission !== 'granted') {
          setBusy(false);
          return;
        }

        // Register service worker and subscribe to push manager
        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        let sub = await registration.pushManager.getSubscription();
        if (!sub) {
          sub = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }

        const body = toServerSubscription(sub);
        if (!body) {
          throw new Error('PushSubscription keys missing');
        }

        // If this save fails the device stays subscribed; the control stays "inactive" with an
        // error, and the next mount (or a retry) re-sends it, so the screen never claims "active"
        // for a subscription the server does not have.
        const saveOutcome = await saveSub(body);

        if (saveOutcome.kind === 'saved') {
          setState('active');
        } else if (saveOutcome.kind === 'loggedOut') {
          navigate('/login', { replace: true });
        } else {
          setErrorMessage('לא הצלחנו לשמור את ההתראות בשרת.');
        }
      }
    } catch {
      setErrorMessage('אירעה שגיאה בהפעלת ההתראות.');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'unsupported' || state === 'disabled' || state === 'checking') {
    return null;
  }

  if (state === 'blocked') {
    return (
      <div className="push-control push-control-blocked" role="status">
        <Icon name="bell" />
        <span>התראות חסומות בהגדרות הדפדפן</span>
      </div>
    );
  }

  const isActive = state === 'active';

  return (
    <div className="push-control">
      <button
        type="button"
        className={`button ${isActive ? 'button-secondary push-active' : 'button-secondary'}`}
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={isActive}
      >
        <Icon name="bell" />
        <span>{isActive ? 'התראות פעילות' : 'הפעל התראות'}</span>
      </button>
      {errorMessage && (
        <p className="field-error" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
