// Acceptance tests of POST /api/orders (spec §3.1, §7) through supertest against createApp(fakes):
// no listen(), no port, no database, no network. Each test keeps the in-memory orders repo and
// attempt store it passes in, to see what the route stored and what the rate limit counted.
// Every request is sent from the site's own origin (SAME_ORIGIN_HEADERS), as the web form's is,
// except in the Origin check's own tests.
import { inspect } from 'node:util';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  CREATE_ORDER_MESSAGES,
  ORDER_FORM_ERRORS,
  PHONE_ERROR,
  STREETS,
  createOrderResponseSchema,
  orderTokenSchema,
  type CreateOrderRequest,
  type CreateOrderResponse,
  type InvalidOrderErrorBody,
  type Order,
  type OrderSummary,
} from '@bottlerun/shared';
import { createApp } from '../app.ts';
import { InMemoryAttemptStore } from '../attempts/inMemoryAttemptStore.ts';
import { createFakeDeps } from '../fakeDeps.ts';
import { SAME_ORIGIN_HEADERS, TEST_HOST } from '../testRequest.ts';
import { ORDER_RATE_LIMIT } from './createOrderRoute.ts';
import { InMemoryOrdersRepo } from './inMemoryOrdersRepo.ts';
import { makeNewOrder } from './makeOrder.ts';

// The customer's data. Distinctive values (a Hebrew letter in the house number, no bare digits),
// so "the log does not contain it" cannot pass or fail by accident on a line number.
const NAME = 'רבקה לוינסון';
const PHONE = '050-1234567';
const PHONE_DIGITS = '0501234567';
const PHONE_E164 = '+972501234567';
const HOUSE_NUMBER = '17ב';
const FLOOR_APT = 'כניסה ב, קומה 3, דירה 12';
const NOTE = 'ליד השער הירוק';
const FREE_TEXT_STREET = 'הרחוב החדש שלי';

const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.9';

/** A street of the real list that has a region, so an order on it gets that region. */
const STREET = (() => {
  const street = STREETS.find((candidate) => candidate.region !== undefined);
  if (street === undefined) throw new Error('no street with a region in data/streets.json');
  return street;
})();

/** What the customer sees about the order {@link validBody} makes: never an internal field. */
const EXPECTED_SUMMARY: OrderSummary = {
  contact: { name: NAME, phone: PHONE_E164 },
  address: {
    streetCode: STREET.code,
    streetName: STREET.name,
    houseNumber: HOUSE_NUMBER,
    bottlesSpot: 'apartmentDoor',
    floorApt: FLOOR_APT,
    note: NOTE,
  },
  bottlesEstimated: 40,
};

/** A valid booking as the web form sends it: a listed street with a region, the honeypot empty. */
function validBody(overrides: Partial<CreateOrderRequest> = {}): CreateOrderRequest {
  return {
    contact: { name: NAME, phone: PHONE },
    address: {
      streetCode: STREET.code,
      houseNumber: HOUSE_NUMBER,
      bottlesSpot: 'apartmentDoor',
      floorApt: FLOOR_APT,
      note: NOTE,
    },
    bottlesEstimated: 40,
    website: '',
    ...overrides,
  };
}

/** {@link validBody} with another phone, typed as the customer typed it. */
function bodyWithPhone(phone: string): CreateOrderRequest {
  return validBody({ contact: { name: NAME, phone } });
}

let orders: InMemoryOrdersRepo;
let attempts: InMemoryAttemptStore;
let app: Express;
let consoleError: MockInstance<typeof console.error>;
let consoleSpies: MockInstance<typeof console.error>[];

beforeEach(() => {
  orders = new InMemoryOrdersRepo();
  attempts = new InMemoryAttemptStore();
  app = createApp(createFakeDeps({ orders, attempts }));
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleSpies = [
    consoleError,
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * POSTs `body` to /api/orders from the site's own origin, as if the proxy had seen the request
 * come from `ip`.
 */
function postOrder(body: object, ip = IP, target: Express = app): request.Test {
  return request(target)
    .post('/api/orders')
    .set(SAME_ORIGIN_HEADERS)
    .set('X-Forwarded-For', ip)
    .send(body);
}

/** The 201 body, checked against the shared contract the web app parses it with. */
function createdBody(res: request.Response): CreateOrderResponse {
  return createOrderResponseSchema.parse(res.body);
}

/** The stored order behind `token`; fails the test when there is none. */
async function storedOrder(token: string): Promise<Order> {
  const order = await orders.findByToken(token);
  if (order === null) throw new Error('no stored order has this token');
  return order;
}

/** Everything written to any console method, objects included in full, for "not in the log". */
function allLogText(): string {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((arg: unknown) => (typeof arg === 'string' ? arg : inspect(arg, { depth: null })))
    .join('\n');
}

/** The in-memory repo, except that `create` fails with `error`: a database refusing the write. */
class OrdersRepoFailingOnCreate extends InMemoryOrdersRepo {
  readonly #error: Error;

  constructor(error: Error) {
    super();
    this.#error = error;
  }

  override create(): Promise<Order> {
    return Promise.reject(this.#error);
  }
}

/** An in-memory repo with every method spied on, to see whether the route called it at all. */
function spiedRepo() {
  const repo = new InMemoryOrdersRepo();
  const spies = [
    vi.spyOn(repo, 'create'),
    vi.spyOn(repo, 'findById'),
    vi.spyOn(repo, 'findByToken'),
    vi.spyOn(repo, 'findOpenByPhone'),
    vi.spyOn(repo, 'list'),
    vi.spyOn(repo, 'update'),
  ];
  return { repo, spies };
}

describe('POST /api/orders: a valid booking', () => {
  it('stores a waiting order and answers 201 with only the token and the summary', async () => {
    const res = await postOrder(validBody());

    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/u);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body as object).sort()).toEqual(['order', 'token']);
    // The raw JSON, not the parsed one: parsing strips unknown keys and would hide a leak.
    expect((res.body as { order: unknown }).order).toStrictEqual(EXPECTED_SUMMARY);

    const body = createdBody(res);
    expect(orderTokenSchema.safeParse(body.token).success).toBe(true);

    const stored = await storedOrder(body.token);
    expect(STREET.region).toBeDefined();
    expect(stored).toMatchObject({
      status: 'waiting',
      source: 'form',
      contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' },
      address: EXPECTED_SUMMARY.address,
      bottlesEstimated: 40,
      region: STREET.region,
      messages: [],
    });
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(stored.updatedAt).toBeInstanceOf(Date);
    expect(await orders.list()).toHaveLength(1);
  });

  it('stores the number of bottles sent as text ("45", as an input sends it) as a number', async () => {
    const res = await postOrder(validBody({ bottlesEstimated: '45' }));

    expect(res.status).toBe(201);
    const body = createdBody(res);
    expect(body.order.bottlesEstimated).toBe(45);
    expect((await storedOrder(body.token)).bottlesEstimated).toBe(45);
  });

  it('accepts exactly 20 bottles, the minimum', async () => {
    const res = await postOrder(validBody({ bottlesEstimated: 20 }));

    expect(res.status).toBe(201);
    expect((await storedOrder(createdBody(res).token)).bottlesEstimated).toBe(20);
  });

  it('stores a free-text street with no region and no street code', async () => {
    const address = {
      streetName: FREE_TEXT_STREET,
      houseNumber: HOUSE_NUMBER,
      bottlesSpot: 'privateHouse',
    } as const;

    const res = await postOrder(validBody({ address }));

    expect(res.status).toBe(201);
    const body = createdBody(res);
    expect(body.order.address).toStrictEqual(address);
    const stored = await storedOrder(body.token);
    expect(stored).not.toHaveProperty('region');
    expect(stored.address).toStrictEqual(address);
    expect(stored.address).not.toHaveProperty('streetCode');
  });
});

describe('POST /api/orders: an invalid booking', () => {
  it('refuses 19 bottles with 400 and the plain message, storing nothing', async () => {
    const res = await postOrder(validBody({ bottlesEstimated: 19 }));

    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toStrictEqual({
      error: 'invalid_order',
      fieldErrors: { bottlesEstimated: ORDER_FORM_ERRORS.bottlesTooFew },
    });
    expect(await orders.list()).toEqual([]);
  });

  it('refuses a number that is not a mobile, without echoing it', async () => {
    const res = await postOrder(bodyWithPhone('02-1234567'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({
      error: 'invalid_order',
      fieldErrors: { 'contact.phone': PHONE_ERROR },
    });
    expect(res.text).not.toContain('02-1234567');
    expect(res.text).not.toContain('021234567');
    expect(await orders.list()).toEqual([]);
  });

  it('reports every invalid field at once', async () => {
    const res = await postOrder({
      contact: { name: '  ', phone: '12345' },
      address: { streetCode: STREET.code, houseNumber: '', bottlesSpot: 'onTheRoof' },
      bottlesEstimated: 'abc',
      website: '',
    });

    expect(res.status).toBe(400);
    expect((res.body as InvalidOrderErrorBody).fieldErrors).toStrictEqual({
      'contact.name': ORDER_FORM_ERRORS.nameRequired,
      'contact.phone': PHONE_ERROR,
      'address.houseNumber': ORDER_FORM_ERRORS.houseNumberRequired,
      'address.bottlesSpot': ORDER_FORM_ERRORS.bottlesSpotRequired,
      bottlesEstimated: ORDER_FORM_ERRORS.bottlesRequired,
    });
    expect(await orders.list()).toEqual([]);
  });

  it.each([
    { label: 'no body', send: (req: request.Test) => req },
    {
      label: 'a JSON array',
      send: (req: request.Test) => req.set('Content-Type', 'application/json').send('[1, 2]'),
    },
    {
      label: 'a body that is not JSON',
      send: (req: request.Test) => req.set('Content-Type', 'text/plain').send('website=x'),
    },
  ])('answers $label with 400 invalid_order and no field errors', async ({ send }) => {
    const res = await send(request(app).post('/api/orders').set(SAME_ORIGIN_HEADERS));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_order', fieldErrors: {} });
    expect(await orders.list()).toEqual([]);
  });
});

describe('POST /api/orders: one open order per phone', () => {
  it.each(['waiting', 'pending', 'confirmed'] as const)(
    'refuses a second order while the first is %s, with 409 and the fixed message only',
    async (status) => {
      const existing = await orders.create(
        makeNewOrder({
          status,
          contact: { name: 'משה כהן', phone: PHONE_E164, method: 'whatsapp' },
        }),
      );

      const res = await postOrder(validBody());

      expect(res.status).toBe(409);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toStrictEqual({
        error: 'duplicate_open_order',
        message: 'כבר יש הזמנה פתוחה למספר הזה.',
      });
      // Anyone can type someone else's number: nothing about the existing order comes back.
      expect(res.text).not.toContain(existing.token);
      expect(await orders.list()).toHaveLength(1);
      // Unchanged, and no message logged on it (spec §3.1: no message is sent to the number).
      expect(await orders.findById(existing.id)).toStrictEqual(existing);
    },
  );

  it.each(['+972 50-123-4567', '+972501234567', '00972-50-1234567'])(
    'catches the same phone typed in another format (%s)',
    async (phone) => {
      const first = await postOrder(validBody());
      expect(first.status).toBe(201);

      const second = await postOrder(bodyWithPhone(phone));

      expect(second.status).toBe(409);
      expect(second.text).not.toContain(createdBody(first).token);
      expect(await orders.list()).toHaveLength(1);
    },
  );

  it.each(['collected', 'cancelled'] as const)(
    "accepts a new order when the phone's earlier order is %s",
    async (status) => {
      await orders.create(
        makeNewOrder({ status, contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' } }),
      );

      const res = await postOrder(validBody());

      expect(res.status).toBe(201);
      expect(await orders.list()).toHaveLength(2);
      expect((await orders.findOpenByPhone(PHONE_E164))?.token).toBe(createdBody(res).token);
    },
  );
});

describe('POST /api/orders: the honeypot', () => {
  it.each([
    { label: 'a URL', value: 'https://spam.example' },
    { label: 'a number', value: 1 },
    { label: 'an object', value: { url: 'https://spam.example' } },
  ])('filled with $label gets a fake 201 and the repo is never called', async ({ value }) => {
    const { repo, spies } = spiedRepo();
    const target = createApp(createFakeDeps({ orders: repo, attempts }));

    const res = await postOrder({ ...validBody(), website: value }, IP, target);

    // The same answer a real success gets.
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body as object).sort()).toEqual(['order', 'token']);
    expect((res.body as { order: unknown }).order).toStrictEqual(EXPECTED_SUMMARY);
    const body = createdBody(res);
    expect(orderTokenSchema.safeParse(body.token).success).toBe(true);

    // Nothing stored, nothing looked up. Checked before the reads below, which call the spies.
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(await repo.list()).toEqual([]);
    expect(await repo.findByToken(body.token)).toBeNull();
  });

  it.each([
    { label: 'empty', value: '' },
    { label: 'only spaces', value: '   ' },
    { label: 'null', value: null },
    // JSON leaves an undefined key out, so the field is absent.
    { label: 'absent', value: undefined },
  ])('left $label lets the real order be stored', async ({ value }) => {
    const res = await postOrder({ ...validBody(), website: value });

    expect(res.status).toBe(201);
    expect(await storedOrder(createdBody(res).token)).toMatchObject({ status: 'waiting' });
    expect(await orders.list()).toHaveLength(1);
  });

  it('is checked after validation: filled on an invalid form still gets the 400', async () => {
    const res = await postOrder({
      ...validBody({ bottlesEstimated: 19 }),
      website: 'https://spam.example',
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({
      error: 'invalid_order',
      fieldErrors: { bottlesEstimated: ORDER_FORM_ERRORS.bottlesTooFew },
    });
  });
});

describe('POST /api/orders: the rate limit', () => {
  /** A different valid phone for each request, so none of them is a duplicate. */
  function phoneNumber(index: number): string {
    return `052-00000${String(index).padStart(2, '0')}`;
  }

  it('lets the limit of requests from one IP through, then answers 429 and stores nothing', async () => {
    for (let sent = 0; sent < ORDER_RATE_LIMIT.max; sent += 1) {
      expect((await postOrder(bodyWithPhone(phoneNumber(sent)))).status).toBe(201);
    }

    const blocked = await postOrder(validBody());

    expect(blocked.status).toBe(429);
    expect(blocked.body).toStrictEqual({
      error: 'rate_limited',
      message: CREATE_ORDER_MESSAGES.rateLimited,
    });
    expect(await orders.list()).toHaveLength(ORDER_RATE_LIMIT.max);
    expect(await orders.findOpenByPhone(PHONE_E164)).toBeNull();

    // Another IP is counted on its own.
    expect((await postOrder(validBody(), OTHER_IP)).status).toBe(201);
  });

  it('counts invalid requests too', async () => {
    for (let sent = 0; sent < ORDER_RATE_LIMIT.max; sent += 1) {
      expect((await postOrder(validBody({ bottlesEstimated: 19 }))).status).toBe(400);
    }

    expect((await postOrder(validBody())).status).toBe(429);
    expect(await orders.list()).toEqual([]);
  });

  it('counts every request: valid, duplicate, invalid and honeypot', async () => {
    await postOrder(validBody());
    await postOrder(validBody());
    await postOrder(validBody({ bottlesEstimated: 19 }));
    await postOrder({ ...bodyWithPhone(phoneNumber(1)), website: 'https://spam.example' });

    expect(await attempts.count(`order:ip:${IP}`, ORDER_RATE_LIMIT.windowMs)).toBe(4);
  });
});

describe('POST /api/orders: the Origin check', () => {
  it.each([
    { label: 'from another site', origin: 'https://evil.example' },
    { label: 'from the same host name on another port', origin: `https://${TEST_HOST}:8443` },
    { label: 'with Origin: null', origin: 'null' },
    { label: 'with no Origin', origin: undefined },
  ])(
    'refuses a valid booking $label with 403, before the rate limit: nothing stored or counted',
    async ({ origin }) => {
      const req = request(app)
        .post('/api/orders')
        .set('Host', TEST_HOST)
        .set('X-Forwarded-For', IP);
      if (origin !== undefined) req.set('Origin', origin);

      const res = await req.send(validBody());

      expect(res.status).toBe(403);
      expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
      expect(await orders.list()).toEqual([]);
      expect(await attempts.count(`order:ip:${IP}`, ORDER_RATE_LIMIT.windowMs)).toBe(0);
    },
  );

  it('accepts the same booking from the site itself', async () => {
    // The control for the test above: only the Origin differs.
    const res = await postOrder(validBody());

    expect(res.status).toBe(201);
    expect(await orders.list()).toHaveLength(1);
  });
});

describe('POST /api/orders: failures', () => {
  it('answers 500 internal when the repo fails for another reason (a token collision)', async () => {
    const failing = new OrdersRepoFailingOnCreate(
      new Error('An order with this token already exists'),
    );
    const target = createApp(createFakeDeps({ orders: failing, attempts }));

    const res = await postOrder(validBody(), IP, target);

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ error: 'internal' });
    expect(await failing.list()).toEqual([]);
  });
});

describe('POST /api/orders: logs', () => {
  it('never contain what the customer sent, nor a token, whatever the answer', async () => {
    const created = await postOrder(validBody());
    const invalid = await postOrder(validBody({ bottlesEstimated: 19 }));
    const duplicate = await postOrder(bodyWithPhone('+972 50-123-4567'));
    const honeypot = await postOrder({
      ...bodyWithPhone('052-7654321'),
      website: 'https://spam.example',
    });
    // Another IP uses up its limit (all duplicates: every request counts), then is blocked.
    for (let sent = 0; sent < ORDER_RATE_LIMIT.max; sent += 1) {
      await postOrder(validBody(), OTHER_IP);
    }
    const limited = await postOrder(validBody(), OTHER_IP);
    // A database error whose message quotes the customer's data, like a Mongo E11000 does.
    const failing = new OrdersRepoFailingOnCreate(
      new Error(
        `E11000 duplicate key: { phone: "${PHONE_E164}" } at ${STREET.name} ${HOUSE_NUMBER}`,
      ),
    );
    const crashed = await postOrder(
      validBody(),
      IP,
      createApp(createFakeDeps({ orders: failing, attempts: new InMemoryAttemptStore() })),
    );

    expect(
      [created, invalid, duplicate, honeypot, limited, crashed].map((res) => res.status),
    ).toEqual([201, 400, 409, 201, 429, 500]);
    expect(crashed.body).toStrictEqual({ error: 'internal' });
    // The 500 was logged, so the check below reads a real log line, not an empty log.
    expect(consoleError).toHaveBeenCalled();

    const logText = allLogText();
    const secrets = [
      PHONE,
      PHONE_DIGITS,
      PHONE_E164,
      NAME,
      STREET.name,
      HOUSE_NUMBER,
      FLOOR_APT,
      NOTE,
      createdBody(created).token,
      createdBody(honeypot).token,
    ];
    for (const secret of secrets) expect(logText).not.toContain(secret);
  });
});
