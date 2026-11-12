import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushSubscription } from '@bottlerun/shared';
import type {
  DeletePushSubscriptionOutcome,
  PushConfigOutcome,
  SavePushSubscriptionOutcome,
} from '../api/pushApi.ts';
import type { Api } from '../api/ApiContext.tsx';
import { renderWithApi } from '../api/renderWithApi.tsx';
import { PushNotificationsControl, urlBase64ToUint8Array } from './PushNotificationsControl.tsx';

const FAKE_PUBLIC_KEY = 'BA_fake_public_key_12345';
const FAKE_ENDPOINT = 'https://push.example.com/sub/123';

function makeFakeSub(endpoint = FAKE_ENDPOINT) {
  return {
    endpoint,
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: () => ({
      endpoint,
      keys: {
        p256dh: 'p256dh_key_base64',
        auth: 'auth_key_base64',
      },
    }),
  };
}

/** A `saveSub` stub that always succeeds, typed as the component's prop. */
function savedSubStub() {
  return vi
    .fn<() => Promise<SavePushSubscriptionOutcome>>()
    .mockResolvedValue({ kind: 'saved' }) as unknown as (
    sub: PushSubscription,
  ) => Promise<SavePushSubscriptionOutcome>;
}

/** The client functions the control calls. */
type PushApi = Pick<Api, 'fetchPushConfig' | 'savePushSubscription' | 'deletePushSubscription'>;

/** Names of the push functions a test called without giving a fake for (see renderControl). */
let unexpectedCalls: string[] = [];

/** A stand-in for a push function the test did not fake: it records the call and fails. */
function unexpected(name: keyof PushApi): () => Promise<{ kind: 'failed' }> {
  return () => {
    unexpectedCalls.push(name);
    return Promise.resolve({ kind: 'failed' });
  };
}

/**
 * Renders the control with the push functions in `fakes`. One the test leaves out answers
 * `failed` and is recorded, and afterEach fails the test for it: no test may lean on a call
 * it did not fake (the real client would also answer `failed` in jsdom, silently).
 */
function renderControl(fakes: Partial<PushApi>) {
  return renderWithApi(<PushNotificationsControl />, {
    fetchPushConfig: unexpected('fetchPushConfig'),
    savePushSubscription: unexpected('savePushSubscription'),
    deletePushSubscription: unexpected('deletePushSubscription'),
    ...fakes,
  });
}

beforeEach(() => {
  unexpectedCalls = [];
});

afterEach(() => {
  expect(unexpectedCalls).toEqual([]);
});

describe('urlBase64ToUint8Array', () => {
  it('converts base64url string to Uint8Array correctly', () => {
    // 'hello' in base64url is 'aGVsbG8'
    const arr = urlBase64ToUint8Array('aGVsbG8');
    expect(arr).toBeInstanceOf(Uint8Array);
    const decoded = new TextDecoder().decode(arr);
    expect(decoded).toBe('hello');
  });
});

describe('PushNotificationsControl', () => {
  let originalNotification: typeof Notification;
  let requestPermissionMock: ReturnType<typeof vi.fn>;
  let getSubscriptionMock: ReturnType<typeof vi.fn>;
  let subscribeMock: ReturnType<typeof vi.fn>;
  let registerMock: ReturnType<typeof vi.fn>;
  let getRegistrationMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalNotification = window.Notification;

    requestPermissionMock = vi.fn().mockResolvedValue('granted');
    getSubscriptionMock = vi.fn().mockResolvedValue(null);
    subscribeMock = vi.fn().mockResolvedValue(makeFakeSub());
    registerMock = vi.fn().mockResolvedValue({
      pushManager: {
        getSubscription: getSubscriptionMock,
        subscribe: subscribeMock,
      },
    });
    getRegistrationMock = vi.fn().mockResolvedValue({
      pushManager: {
        getSubscription: getSubscriptionMock,
        subscribe: subscribeMock,
      },
    });

    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        register: registerMock,
        getRegistration: getRegistrationMock,
        ready: Promise.resolve({
          pushManager: {
            getSubscription: getSubscriptionMock,
            subscribe: subscribeMock,
          },
        }),
      },
      configurable: true,
    });

    (window as unknown as { PushManager: unknown }).PushManager = class {};

    const mockNotification = {
      permission: 'default',
      requestPermission: requestPermissionMock,
    } as unknown as typeof Notification;
    window.Notification = mockNotification;
  });

  afterEach(() => {
    window.Notification = originalNotification;
    vi.restoreAllMocks();
  });

  it('renders nothing when push is disabled on the server', async () => {
    let resolveConfig!: (value: PushConfigOutcome) => void;
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    );

    const { container } = renderControl({ fetchPushConfig: loadConfig });

    // Initially in checking state
    expect(container.firstChild).toBeNull();
    expect(loadConfig).toHaveBeenCalled();

    // Resolve with enabled: false
    resolveConfig({
      kind: 'loaded',
      config: { enabled: false },
    });

    // Let React apply the state change from the resolved config before asserting. Without this
    // flush the assertions would run while the state is still "checking" (also null) and could
    // never fail.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole('button')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  // Each case removes one browser API for real (`delete`, not `value: undefined`, because the
  // control checks `'serviceWorker' in navigator`). `beforeEach`/`afterEach` put them back.
  it.each([
    {
      name: 'ServiceWorker',
      remove: () => delete (navigator as unknown as Record<string, unknown>).serviceWorker,
    },
    {
      name: 'PushManager',
      remove: () => delete (window as unknown as Record<string, unknown>).PushManager,
    },
    {
      name: 'Notification',
      remove: () => delete (window as unknown as Record<string, unknown>).Notification,
    },
  ])('renders nothing and skips the server when the browser lacks $name', async ({ remove }) => {
    remove();
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });

    const { container } = renderControl({ fetchPushConfig: loadConfig });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.firstChild).toBeNull();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('renders blocked notice when Notification.permission is denied', async () => {
    (window.Notification as unknown as { permission: string }).permission = 'denied';
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });

    renderControl({ fetchPushConfig: loadConfig });

    expect(await screen.findByText('התראות חסומות בהגדרות הדפדפן')).toBeTruthy();
  });

  it('renders "הפעל התראות" when push is enabled and device is not subscribed', async () => {
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });
    getSubscriptionMock.mockResolvedValue(null);

    renderControl({ fetchPushConfig: loadConfig });

    const button = await screen.findByRole('button', { name: 'הפעל התראות' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('subscribes and saves subscription when "הפעל התראות" is clicked', async () => {
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });
    const saveSub = vi
      .fn<() => Promise<SavePushSubscriptionOutcome>>()
      .mockResolvedValue({ kind: 'saved' });

    getSubscriptionMock.mockResolvedValue(null);

    renderControl({
      fetchPushConfig: loadConfig,
      savePushSubscription: saveSub,
    });

    const button = await screen.findByRole('button', { name: 'הפעל התראות' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole('button', { name: 'התראות פעילות' })).toBeTruthy());
    expect(requestPermissionMock).toHaveBeenCalled();
    expect(subscribeMock).toHaveBeenCalled();
    expect(saveSub).toHaveBeenCalledWith({
      endpoint: FAKE_ENDPOINT,
      keys: { p256dh: 'p256dh_key_base64', auth: 'auth_key_base64' },
    });
  });

  it('renders blocked state when user denies permission in browser prompt', async () => {
    requestPermissionMock.mockResolvedValue('denied');
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });

    renderControl({ fetchPushConfig: loadConfig });

    const button = await screen.findByRole('button', { name: 'הפעל התראות' });
    fireEvent.click(button);

    expect(await screen.findByText('התראות חסומות בהגדרות הדפדפן')).toBeTruthy();
  });

  it('renders "התראות פעילות" when already subscribed, and unsubscribes on click', async () => {
    const fakeSub = makeFakeSub();
    getSubscriptionMock.mockResolvedValue(fakeSub);

    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });
    const deleteSub = vi
      .fn<() => Promise<DeletePushSubscriptionOutcome>>()
      .mockResolvedValue({ kind: 'deleted' });

    renderControl({
      fetchPushConfig: loadConfig,
      savePushSubscription: savedSubStub(),
      deletePushSubscription: deleteSub,
    });

    const button = await screen.findByRole('button', { name: 'התראות פעילות' });
    expect(button.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole('button', { name: 'הפעל התראות' })).toBeTruthy());
    expect(fakeSub.unsubscribe).toHaveBeenCalled();
    expect(deleteSub).toHaveBeenCalledWith(FAKE_ENDPOINT);
  });

  it('displays error message if unsubscribing fails on the server', async () => {
    const fakeSub = makeFakeSub();
    getSubscriptionMock.mockResolvedValue(fakeSub);

    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });
    const deleteSub = vi
      .fn<() => Promise<DeletePushSubscriptionOutcome>>()
      .mockResolvedValue({ kind: 'failed' });

    renderControl({
      fetchPushConfig: loadConfig,
      savePushSubscription: savedSubStub(),
      deletePushSubscription: deleteSub,
    });

    const button = await screen.findByRole('button', { name: 'התראות פעילות' });
    fireEvent.click(button);

    expect(await screen.findByText('לא הצלחנו להסיר את המנוי מהשרת.')).toBeTruthy();
    // The server delete comes first: when it fails the device stays subscribed and the control
    // still says "active", so the screen matches reality and a retry works.
    expect(fakeSub.unsubscribe).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'התראות פעילות' })).toBeTruthy();
  });

  it('displays error message if saving subscription fails', async () => {
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });
    const saveSub = vi
      .fn<() => Promise<SavePushSubscriptionOutcome>>()
      .mockResolvedValue({ kind: 'failed' });

    renderControl({
      fetchPushConfig: loadConfig,
      savePushSubscription: saveSub,
    });

    const button = await screen.findByRole('button', { name: 'הפעל התראות' });
    fireEvent.click(button);

    expect(await screen.findByText('לא הצלחנו לשמור את ההתראות בשרת.')).toBeTruthy();
  });

  it('re-sends an existing device subscription to the server on mount before showing "active"', async () => {
    getSubscriptionMock.mockResolvedValue(makeFakeSub());
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });
    const saveSub = savedSubStub();

    renderControl({ fetchPushConfig: loadConfig, savePushSubscription: saveSub });

    expect(await screen.findByRole('button', { name: 'התראות פעילות' })).toBeTruthy();
    expect(saveSub).toHaveBeenCalledWith({
      endpoint: FAKE_ENDPOINT,
      keys: { p256dh: 'p256dh_key_base64', auth: 'auth_key_base64' },
    });
  });

  it('does not claim "active" when the server could not be given the existing subscription', async () => {
    // Earlier save failed: the device is subscribed, the server has nothing. After a reload the
    // screen must not say notifications are on.
    getSubscriptionMock.mockResolvedValue(makeFakeSub());
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });
    const saveSub = vi
      .fn<() => Promise<SavePushSubscriptionOutcome>>()
      .mockResolvedValue({ kind: 'failed' }) as unknown as (
      sub: PushSubscription,
    ) => Promise<SavePushSubscriptionOutcome>;

    renderControl({ fetchPushConfig: loadConfig, savePushSubscription: saveSub });

    expect(await screen.findByRole('button', { name: 'הפעל התראות' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'התראות פעילות' })).toBeNull();
  });
});
