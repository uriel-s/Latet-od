import { describe, expect, it } from 'vitest';
import { makeFakeFetch } from './fakeFetch.ts';
import { deletePushSubscription, fetchPushConfig, savePushSubscription } from './pushApi.ts';
import { describeEveryEndpoint } from './request.contract.ts';

const PUSH_ENDPOINT = 'https://push.example/sub1';

describe('fetchPushConfig', () => {
  it('asks GET /api/collector/push/config, past browser cache', async () => {
    const { fetchFn, calls } = makeFakeFetch({
      status: 200,
      body: { enabled: true, publicKey: 'test-key' },
    });
    const outcome = await fetchPushConfig(fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/push/config');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(outcome).toEqual({
      kind: 'loaded',
      config: { enabled: true, publicKey: 'test-key' },
    });
  });

  it('answers loaded with disabled config', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 200,
      body: { enabled: false },
    });
    const outcome = await fetchPushConfig(fetchFn);
    expect(outcome).toEqual({
      kind: 'loaded',
      config: { enabled: false },
    });
  });

  it('answers failed on invalid 200 or 500', async () => {
    const { fetchFn: invalid200 } = makeFakeFetch({ status: 200, body: { enabled: true } });
    expect(await fetchPushConfig(invalid200)).toEqual({ kind: 'failed' });

    const { fetchFn: serverError } = makeFakeFetch({ status: 500, body: { error: 'internal' } });
    expect(await fetchPushConfig(serverError)).toEqual({ kind: 'failed' });
  });
});

describe('savePushSubscription', () => {
  const subscription = {
    endpoint: 'https://push.example/sub1',
    keys: { p256dh: 'p256dhKey', auth: 'authKey' },
  };

  it('sends POST /api/collector/push/subscribe and answers saved on 204', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 204, noBody: true });
    const outcome = await savePushSubscription(subscription, fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/push/subscribe');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify(subscription));
    expect(outcome).toEqual({ kind: 'saved' });
  });
});

describe('deletePushSubscription', () => {
  it('sends POST /api/collector/push/unsubscribe and answers deleted on 204', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 204, noBody: true });
    const outcome = await deletePushSubscription('https://push.example/sub1', fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/push/unsubscribe');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ endpoint: 'https://push.example/sub1' }));
    expect(outcome).toEqual({ kind: 'deleted' });
  });
});

describeEveryEndpoint([
  {
    name: 'fetchPushConfig',
    call: (fetchFn) => fetchPushConfig(fetchFn),
    success: { status: 200, body: { enabled: true, publicKey: 'test-key' } },
    on401: 'loggedOut',
    alsoFailed: [404, 429],
  },
  {
    name: 'savePushSubscription',
    call: (fetchFn) =>
      savePushSubscription(
        { endpoint: PUSH_ENDPOINT, keys: { p256dh: 'p256dhKey', auth: 'authKey' } },
        fetchFn,
      ),
    success: { status: 204, noBody: true },
    on401: 'loggedOut',
    alsoFailed: [400, 429],
  },
  {
    name: 'deletePushSubscription',
    call: (fetchFn) => deletePushSubscription(PUSH_ENDPOINT, fetchFn),
    success: { status: 204, noBody: true },
    on401: 'loggedOut',
    alsoFailed: [400, 429],
  },
]);
