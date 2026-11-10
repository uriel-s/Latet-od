import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const swSource = fs.readFileSync(path.join(import.meta.dirname, '../public/sw.js'), 'utf8');

describe('sw.js static guarantees', () => {
  it('does not contain any fetch event listeners or cache storage (ADR-0013)', () => {
    const swCodeWithoutComments = swSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    expect(swCodeWithoutComments).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
    expect(swCodeWithoutComments).not.toMatch(/\bcaches\b/);
  });

  it('registers push and notificationclick event listeners', () => {
    expect(swSource).toMatch(/addEventListener\(\s*['"]push['"]/);
    expect(swSource).toMatch(/addEventListener\(\s*['"]notificationclick['"]/);
    expect(swSource).toMatch(/addEventListener\(\s*['"]install['"]/);
    expect(swSource).toMatch(/addEventListener\(\s*['"]activate['"]/);
  });

  it('uses a status-bar badge that exists and is a transparent, single-color PNG', () => {
    // Android draws the badge as a silhouette: a colored or opaque picture becomes a white square.
    const badge = fs.readFileSync(path.join(import.meta.dirname, '../public/badge-96.png'));
    const colorTypeRgba = 6; // PNG IHDR color type 6 = truecolor with an alpha channel
    expect(badge.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(badge.readUInt32BE(16)).toBe(96); // width
    expect(badge.readUInt32BE(20)).toBe(96); // height
    expect(badge[25]).toBe(colorTypeRgba);
  });
});

describe('sw.js runtime behavior', () => {
  type Listener = (event: unknown) => void;
  let listeners: Record<string, Listener>;
  let showNotificationMock: ReturnType<typeof vi.fn>;
  let openWindowMock: ReturnType<typeof vi.fn>;
  let matchAllMock: ReturnType<typeof vi.fn>;
  let skipWaitingMock: ReturnType<typeof vi.fn>;
  let claimMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listeners = {};
    showNotificationMock = vi.fn().mockResolvedValue(undefined);
    openWindowMock = vi.fn().mockResolvedValue(undefined);
    matchAllMock = vi.fn().mockResolvedValue([]);
    skipWaitingMock = vi.fn();
    claimMock = vi.fn().mockResolvedValue(undefined);

    const mockSelf = {
      location: { origin: 'https://latet-od.test' },
      addEventListener: vi.fn((type: string, listener: Listener) => {
        listeners[type] = listener;
      }),
      registration: {
        showNotification: showNotificationMock,
      },
      clients: {
        matchAll: matchAllMock,
        openWindow: openWindowMock,
        claim: claimMock,
      },
      skipWaiting: skipWaitingMock,
    };

    vm.runInNewContext(swSource, {
      self: mockSelf,
      URL,
    });
  });

  describe('lifecycle events', () => {
    it('calls skipWaiting on install', () => {
      listeners['install']?.({});
      expect(skipWaitingMock).toHaveBeenCalled();
    });

    it('claims clients on activate', async () => {
      let waitPromise: Promise<unknown> | undefined;
      listeners['activate']?.({
        waitUntil: (p: Promise<unknown>) => {
          waitPromise = p;
        },
      });
      await waitPromise;
      expect(claimMock).toHaveBeenCalled();
    });
  });

  describe('push event', () => {
    it('ignores push events with no data', () => {
      let waitPromise: Promise<unknown> | undefined;
      listeners['push']?.({
        data: null,
        waitUntil: (p: Promise<unknown>) => {
          waitPromise = p;
        },
      });

      expect(waitPromise).toBeUndefined();
      expect(showNotificationMock).not.toHaveBeenCalled();
    });

    it('shows notification with parsed json payload in Hebrew RTL', async () => {
      let waitPromise: Promise<unknown> | undefined;
      const event = {
        data: {
          json: () => ({
            title: 'הזמנה חדשה — לתת עוד',
            body: 'דוד כהן · נחל נחשון 5 · כ־40 בקבוקים',
            url: '/app/orders',
          }),
          text: () => '',
        },
        waitUntil: (p: Promise<unknown>) => {
          waitPromise = p;
        },
      };

      listeners['push']?.(event);
      await waitPromise;

      expect(showNotificationMock).toHaveBeenCalledWith('הזמנה חדשה — לתת עוד', {
        body: 'דוד כהן · נחל נחשון 5 · כ־40 בקבוקים',
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        vibrate: [200, 100, 200],
        dir: 'rtl',
        lang: 'he',
        data: { url: '/app/orders' },
      });
    });

    it('falls back gracefully to plain text data if JSON parse fails', async () => {
      let waitPromise: Promise<unknown> | undefined;
      const event = {
        data: {
          json: () => {
            throw new Error('invalid json');
          },
          text: () => 'הזמנה חדשה התקבלה',
        },
        waitUntil: (p: Promise<unknown>) => {
          waitPromise = p;
        },
      };

      listeners['push']?.(event);
      await waitPromise;

      expect(showNotificationMock).toHaveBeenCalledWith('הזמנה חדשה — לתת עוד', {
        body: 'הזמנה חדשה התקבלה',
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        vibrate: [200, 100, 200],
        dir: 'rtl',
        lang: 'he',
        data: { url: '/app/orders' },
      });
    });
  });

  describe('notificationclick event', () => {
    it('closes notification and focuses matching client window', async () => {
      const focusMock = vi.fn().mockResolvedValue(undefined);
      matchAllMock.mockResolvedValue([
        { url: 'https://latet-od.test/app/orders', focus: focusMock },
      ]);

      const closeMock = vi.fn();
      let waitPromise: Promise<unknown> | undefined;

      listeners['notificationclick']?.({
        notification: {
          close: closeMock,
          data: { url: '/app/orders' },
        },
        waitUntil: (p: Promise<unknown>) => {
          waitPromise = p;
        },
      });

      await waitPromise;

      expect(closeMock).toHaveBeenCalled();
      expect(focusMock).toHaveBeenCalled();
      expect(openWindowMock).not.toHaveBeenCalled();
    });

    it('opens new window when no matching client is open', async () => {
      matchAllMock.mockResolvedValue([]);
      const closeMock = vi.fn();
      let waitPromise: Promise<unknown> | undefined;

      listeners['notificationclick']?.({
        notification: {
          close: closeMock,
          data: { url: '/app/orders' },
        },
        waitUntil: (p: Promise<unknown>) => {
          waitPromise = p;
        },
      });

      await waitPromise;

      expect(closeMock).toHaveBeenCalled();
      expect(openWindowMock).toHaveBeenCalledWith('https://latet-od.test/app/orders');
    });

    it('defends against open redirect by falling back to /app/orders', async () => {
      matchAllMock.mockResolvedValue([]);
      const closeMock = vi.fn();
      let waitPromise: Promise<unknown> | undefined;

      listeners['notificationclick']?.({
        notification: {
          close: closeMock,
          data: { url: 'https://evil.example.com/phish' },
        },
        waitUntil: (p: Promise<unknown>) => {
          waitPromise = p;
        },
      });

      await waitPromise;

      expect(closeMock).toHaveBeenCalled();
      expect(openWindowMock).toHaveBeenCalledWith('https://latet-od.test/app/orders');
    });

    it('navigates and focuses existing /app client window on different subroute', async () => {
      const focusMock = vi.fn().mockResolvedValue(undefined);
      const navigateMock = vi.fn().mockResolvedValue({ focus: focusMock });
      matchAllMock.mockResolvedValue([
        {
          url: 'https://latet-od.test/app/rounds',
          focus: focusMock,
          navigate: navigateMock,
        },
      ]);

      const closeMock = vi.fn();
      let waitPromise: Promise<unknown> | undefined;

      listeners['notificationclick']?.({
        notification: {
          close: closeMock,
          data: { url: '/app/orders' },
        },
        waitUntil: (p: Promise<unknown>) => {
          waitPromise = p;
        },
      });

      await waitPromise;

      expect(closeMock).toHaveBeenCalled();
      expect(navigateMock).toHaveBeenCalledWith('https://latet-od.test/app/orders');
      expect(focusMock).toHaveBeenCalled();
      expect(openWindowMock).not.toHaveBeenCalled();
    });
  });
});
