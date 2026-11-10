import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushSubscription } from '@bottlerun/shared';
import type {
  DeletePushSubscriptionOutcome,
  PushConfigOutcome,
  SavePushSubscriptionOutcome,
} from '../api.ts';
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

    const { container } = render(<PushNotificationsControl loadConfig={loadConfig} />);

    // Initially in checking state
    expect(container.firstChild).toBeNull();
    expect(loadConfig).toHaveBeenCalled();

    // Resolve with enabled: false
    resolveConfig({
      kind: 'loaded',
      config: { enabled: false },
    });

    await waitFor(() => {
      expect(screen.queryByRole('button')).toBeNull();
      expect(container.firstChild).toBeNull();
    });
  });

  it('renders nothing when browser does not support ServiceWorker or PushManager', async () => {
    const originalSW = navigator.serviceWorker;
    Object.defineProperty(navigator, 'serviceWorker', {
      value: undefined,
      configurable: true,
    });

    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });

    const { container } = render(<PushNotificationsControl loadConfig={loadConfig} />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });

    Object.defineProperty(navigator, 'serviceWorker', {
      value: originalSW,
      configurable: true,
    });
  });

  it('renders blocked notice when Notification.permission is denied', async () => {
    (window.Notification as unknown as { permission: string }).permission = 'denied';
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });

    render(<PushNotificationsControl loadConfig={loadConfig} />);

    expect(await screen.findByText('התראות חסומות בהגדרות הדפדפן')).toBeTruthy();
  });

  it('renders "הפעל התראות" when push is enabled and device is not subscribed', async () => {
    const loadConfig = vi.fn<() => Promise<PushConfigOutcome>>().mockResolvedValue({
      kind: 'loaded',
      config: { enabled: true, publicKey: FAKE_PUBLIC_KEY },
    });
    getSubscriptionMock.mockResolvedValue(null);

    render(<PushNotificationsControl loadConfig={loadConfig} />);

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

    render(
      <PushNotificationsControl
        loadConfig={loadConfig}
        saveSub={
          saveSub as unknown as (sub: PushSubscription) => Promise<SavePushSubscriptionOutcome>
        }
      />,
    );

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

    render(<PushNotificationsControl loadConfig={loadConfig} />);

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

    render(
      <PushNotificationsControl
        loadConfig={loadConfig}
        deleteSub={
          deleteSub as unknown as (endpoint: string) => Promise<DeletePushSubscriptionOutcome>
        }
      />,
    );

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

    render(
      <PushNotificationsControl
        loadConfig={loadConfig}
        deleteSub={
          deleteSub as unknown as (endpoint: string) => Promise<DeletePushSubscriptionOutcome>
        }
      />,
    );

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

    render(
      <PushNotificationsControl
        loadConfig={loadConfig}
        saveSub={
          saveSub as unknown as (sub: PushSubscription) => Promise<SavePushSubscriptionOutcome>
        }
      />,
    );

    const button = await screen.findByRole('button', { name: 'הפעל התראות' });
    fireEvent.click(button);

    expect(await screen.findByText('לא הצלחנו לשמור את ההתראות בשרת.')).toBeTruthy();
  });
});
