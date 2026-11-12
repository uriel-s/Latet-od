import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddOrderRequest, CreateOrderRequest, PushSubscription } from '@bottlerun/shared';
import { ApiProvider, realApi, useApi, type Api } from './ApiContext.tsx';
import { makeFakeFetch } from './fakeFetch.ts';
import { apiWith, renderWithApi } from './renderWithApi.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One call of {@link realApi}, and the request it must send. */
interface RealCall {
  call: (api: Api) => Promise<unknown>;
  method: string;
  path: string;
  /** What the call answers to a 500, when not `{ kind: 'failed' }`. */
  failed?: unknown;
}

// The bodies are never parsed by the api here: the test checks only where each call goes.
const ORDER = {} as CreateOrderRequest;
const ADD_ORDER = {} as AddOrderRequest;
const SUBSCRIPTION: PushSubscription = {
  endpoint: 'https://push.example/sub1',
  keys: { p256dh: 'p', auth: 'a' },
};

// Keyed by every property of Api: a function added to Api without a row here fails `types`.
const REAL_CALLS: { [Name in keyof Api]: RealCall } = {
  login: { call: (api) => api.login('pw'), method: 'POST', path: '/api/auth/login' },
  fetchSession: { call: (api) => api.fetchSession(), method: 'GET', path: '/api/auth/me' },
  logout: { call: (api) => api.logout(), method: 'POST', path: '/api/auth/logout', failed: false },
  createOrder: { call: (api) => api.createOrder(ORDER), method: 'POST', path: '/api/orders' },
  fetchCustomerOrder: {
    call: (api) => api.fetchCustomerOrder('tok'),
    method: 'GET',
    path: '/api/o/tok',
  },
  declineCustomerOrder: {
    call: (api) => api.declineCustomerOrder('tok'),
    method: 'POST',
    path: '/api/o/tok/decline',
  },
  cancelCustomerOrder: {
    call: (api) => api.cancelCustomerOrder('tok'),
    method: 'POST',
    path: '/api/o/tok/cancel',
  },
  updateCustomerOrder: {
    call: (api) => api.updateCustomerOrder('tok', { bottlesEstimated: 30 }),
    method: 'PATCH',
    path: '/api/o/tok',
  },
  fetchWaitingOrders: {
    call: (api) => api.fetchWaitingOrders(),
    method: 'GET',
    path: '/api/collector/orders',
  },
  fetchCollectorOrder: {
    call: (api) => api.fetchCollectorOrder('o1'),
    method: 'GET',
    path: '/api/collector/orders/o1',
  },
  addCollectorOrder: {
    call: (api) => api.addCollectorOrder(ADD_ORDER),
    method: 'POST',
    path: '/api/collector/orders',
  },
  updateCollectorOrder: {
    call: (api) => api.updateCollectorOrder('o1', { bottlesEstimated: 30 }),
    method: 'PATCH',
    path: '/api/collector/orders/o1',
  },
  cancelCollectorOrder: {
    call: (api) => api.cancelCollectorOrder('o1'),
    method: 'POST',
    path: '/api/collector/orders/o1/cancel',
  },
  deleteCollectorOrder: {
    call: (api) => api.deleteCollectorOrder('o1'),
    method: 'DELETE',
    path: '/api/collector/orders/o1',
  },
  markMessageOpened: {
    call: (api) => api.markMessageOpened('o1', 2),
    method: 'POST',
    path: '/api/collector/orders/o1/messages/2/opened',
  },
  fetchRounds: { call: (api) => api.fetchRounds(), method: 'GET', path: '/api/collector/rounds' },
  planRound: {
    call: (api) => api.planRound({ date: '2026-11-12', region: 'ramat', orderIds: ['o1'] }),
    method: 'POST',
    path: '/api/collector/rounds',
  },
  buildRoute: {
    call: (api) => api.buildRoute('r1'),
    method: 'POST',
    path: '/api/collector/rounds/r1/route',
  },
  moveStop: {
    call: (api) => api.moveStop('r1', 'o1', 'up'),
    method: 'POST',
    path: '/api/collector/rounds/r1/stops/o1/move',
  },
  collectStop: {
    call: (api) => api.collectStop('r1', 'o1', 40),
    method: 'POST',
    path: '/api/collector/rounds/r1/stops/o1/collected',
  },
  markStopNotFound: {
    call: (api) => api.markStopNotFound('r1', 'o1'),
    method: 'POST',
    path: '/api/collector/rounds/r1/stops/o1/not-found',
  },
  closeRound: {
    call: (api) => api.closeRound('r1'),
    method: 'POST',
    path: '/api/collector/rounds/r1/close',
  },
  fetchHistory: {
    call: (api) => api.fetchHistory('2026-11'),
    method: 'GET',
    path: '/api/collector/history?month=2026-11',
  },
  fetchPushConfig: {
    call: (api) => api.fetchPushConfig(),
    method: 'GET',
    path: '/api/collector/push/config',
  },
  savePushSubscription: {
    call: (api) => api.savePushSubscription(SUBSCRIPTION),
    method: 'POST',
    path: '/api/collector/push/subscribe',
  },
  deletePushSubscription: {
    call: (api) => api.deletePushSubscription('https://push.example/sub1'),
    method: 'POST',
    path: '/api/collector/push/unsubscribe',
  },
};

describe('realApi', () => {
  it.each(Object.entries(REAL_CALLS))(
    '%s sends its request through the global fetch',
    async (_name, { call, method, path, failed = { kind: 'failed' } }) => {
      const { fetchFn, calls } = makeFakeFetch({ status: 500, body: {} });
      vi.stubGlobal('fetch', fetchFn);

      expect(await call(realApi)).toEqual(failed);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBe(path);
      expect(calls[0]?.init?.method ?? 'GET').toBe(method);
    },
  );

  it('never passes an extra argument on as the fetch', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 404, body: {} });
    vi.stubGlobal('fetch', fetchFn);
    // A callback's extra argument (an index, say) where the endpoint's fetchFn would be.
    const notAFetch = () => Promise.reject(new Error('used the extra argument as fetch'));
    const fetchWithExtra = realApi.fetchCustomerOrder as (
      token: string,
      extra: unknown,
    ) => Promise<unknown>;

    expect(await fetchWithExtra('tok', notAFetch)).toEqual({ kind: 'notFound' });
    expect(calls).toHaveLength(1);
  });
});

/** Shows whether the screen got the real client, and calls the client's logout once. */
function Probe() {
  const api = useApi();
  const { logout } = api;
  useEffect(() => {
    void logout();
  }, [logout]);
  return <p>{api === realApi ? 'real' : 'other'}</p>;
}

describe('useApi', () => {
  it('answers the real client when no provider is above', () => {
    vi.stubGlobal('fetch', makeFakeFetch({ status: 204, noBody: true }).fetchFn);

    render(<Probe />);

    expect(screen.getByText('real')).toBeDefined();
  });

  it('answers the client of the provider above', () => {
    const logouts: true[] = [];
    const api = apiWith({
      logout: () => {
        logouts.push(true);
        return Promise.resolve(true);
      },
    });

    render(
      <ApiProvider api={api}>
        <Probe />
      </ApiProvider>,
    );

    expect(screen.getByText('other')).toBeDefined();
    expect(logouts).toHaveLength(1);
  });
});

describe('renderWithApi', () => {
  it('replaces only the functions it is given, and keeps the real ones', () => {
    const fake = () => Promise.resolve(true);

    const { api } = renderWithApi(<Probe />, { logout: fake });

    expect(api.logout).toBe(fake);
    expect(api.login).toBe(realApi.login);
    expect(api.fetchRounds).toBe(realApi.fetchRounds);
  });

  it('keeps the provider and the same client on rerender', () => {
    const logouts: true[] = [];
    const { rerender } = renderWithApi(<Probe />, {
      logout: () => {
        logouts.push(true);
        return Promise.resolve(true);
      },
    });

    rerender(<Probe />);

    expect(screen.getByText('other')).toBeDefined();
    // The effect that depends on `logout` did not run again: its identity held.
    expect(logouts).toHaveLength(1);
  });
});
