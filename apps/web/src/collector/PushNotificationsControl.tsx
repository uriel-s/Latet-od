// Accessible control for enabling, disabling, and checking Web Push notifications (ADR-0013).
//
// Mounted on the collector orders screen (OrdersScreen.tsx): checks if push is supported and
// configured on the server (GET /api/collector/push/config), registers /sw.js, manages device
// PushSubscription, and syncs subscription state with the server.
import { useEffect, useState } from 'react';
import {
  deletePushSubscription,
  fetchPushConfig,
  savePushSubscription,
  type PushConfigOutcome,
} from '../api.ts';
import { Icon } from '../components/Icon.tsx';

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
        const registration = await navigator.serviceWorker.getRegistration('/sw.js');
        if (!active) return;
        if (!registration) {
          setState('inactive');
          return;
        }
        const existingSub = await registration.pushManager.getSubscription();
        if (!active) return;
        setState(existingSub ? 'active' : 'inactive');
      } catch {
        if (active) setState('inactive');
      }
    }

    void checkState();

    return () => {
      active = false;
    };
  }, [loadConfig]);

  async function toggle(): Promise<void> {
    if (busy || !publicKey) return;
    setBusy(true);
    setErrorMessage(null);

    try {
      if (state === 'active') {
        // Turn notifications off: unsubscribe device and delete from server
        const registration = await navigator.serviceWorker.getRegistration('/sw.js');
        const existingSub = await registration?.pushManager.getSubscription();
        if (existingSub) {
          const endpoint = existingSub.endpoint;
          await existingSub.unsubscribe();
          await deleteSub(endpoint);
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

        const json = sub.toJSON();
        if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
          throw new Error('PushSubscription keys missing');
        }

        const saveOutcome = await saveSub({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        });

        if (saveOutcome.kind === 'saved') {
          setState('active');
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
