// Local demo entry: `npm run dev:demo`. The same app as server.ts, but on in-memory fakes seeded
// with made-up customers (5 per half of the city), so the collector screens can be seen and
// redesigned without touching Atlas or WhatsApp. Everything resets when the process restarts.
// Never deployed: Vercel uses vercelEntry.ts, and nothing here reads MONGODB_URI.
import { regionForAddress, STREETS, type BottlesSpot, type Region } from '@bottlerun/shared';
import { createApp } from './app.ts';
import { createFakeAuth, createFakeDeps, createFakeMessaging } from './fakeDeps.ts';
import { newOrderToken } from './orders/newOrderFromForm.ts';

const PORT = Number(process.env.PORT ?? 3000);
/** The login password of the demo. Throwaway: the demo holds no real data. */
const DEMO_PASSWORD = 'demo';

interface DemoCustomer {
  name: string;
  houseNumber: string;
  bottles: number;
  spot: BottlesSpot;
  floorApt?: string;
  note?: string;
}

// Made-up people. Phones are numbered +972500000001.. so none can belong to a real customer.
const RAMAT: DemoCustomer[] = [
  { name: 'שרה לוי', houseNumber: '12', bottles: 60, spot: 'privateHouse' },
  {
    name: 'דוד כהן',
    houseNumber: '4א',
    bottles: 35,
    spot: 'apartmentDoor',
    floorApt: 'קומה 3, דירה 9',
  },
  { name: 'רחל אברהם', houseNumber: '7', bottles: 120, spot: 'buildingEntrance' },
  {
    name: 'יצחק מזרחי',
    houseNumber: '21',
    bottles: 45,
    spot: 'privateHouse',
    note: 'הפעמון לא עובד, לדפוק',
  },
  {
    name: 'מרים פרידמן',
    houseNumber: '3',
    bottles: 80,
    spot: 'apartmentDoor',
    floorApt: 'קומה 1, דירה 2',
  },
];
const OLD: DemoCustomer[] = [
  { name: 'אברהם שמעוני', houseNumber: '15', bottles: 50, spot: 'privateHouse' },
  { name: 'חנה ביטון', houseNumber: '8', bottles: 32, spot: 'buildingEntrance' },
  {
    name: 'משה דהן',
    houseNumber: '30',
    bottles: 200,
    spot: 'privateHouse',
    note: 'יש כלב, לא נושך',
  },
  {
    name: 'לאה גבאי',
    houseNumber: '2ב',
    bottles: 70,
    spot: 'apartmentDoor',
    floorApt: 'קומה 2, דירה 5',
  },
  { name: 'יעקב אזולאי', houseNumber: '11', bottles: 40, spot: 'privateHouse' },
];

const deps = createFakeDeps({
  auth: createFakeAuth({
    verifyCredentials: (password) =>
      Promise.resolve(password === DEMO_PASSWORD ? { sub: 'collector' } : null),
    secureCookie: false, // http://localhost
  }),
  messaging: createFakeMessaging({ publicBaseUrl: 'http://localhost:5173' }),
});

/** Stores one waiting order per customer, on spread-out streets of the region that have a point. */
async function seedOrders(region: Region, customers: DemoCustomer[], firstPhone: number) {
  const streets = STREETS.filter((street) => street.region === region && street.lat !== undefined);
  const step = Math.floor(streets.length / customers.length);
  const ids: string[] = [];
  for (const [index, customer] of customers.entries()) {
    const street = streets[index * step];
    if (street === undefined) throw new Error('no street with a point');
    const address = {
      streetCode: street.code,
      streetName: street.name,
      houseNumber: customer.houseNumber,
      bottlesSpot: customer.spot,
      ...(customer.floorApt !== undefined && { floorApt: customer.floorApt }),
      ...(customer.note !== undefined && { note: customer.note }),
    };
    const createdAt = new Date(Date.now() - (customers.length - index) * 3_600_000);
    const order = await deps.orders.create({
      contact: {
        name: customer.name,
        phone: `+972500000${String(firstPhone + index).padStart(3, '0')}`,
        method: 'whatsapp',
      },
      address,
      bottlesEstimated: customer.bottles,
      status: 'waiting',
      region: regionForAddress(address),
      token: newOrderToken(),
      messages: [],
      source: 'form',
      lang: 'he',
      createdAt,
      updatedAt: createdAt,
    });
    ids.push(order.id);
  }
  return ids;
}

/** Calls the running api as the collector, so the seed goes through the real routes. */
async function seedRounds(orderIdsRamat: string[], orderIdsOld: string[]) {
  const base = `http://localhost:${PORT}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ password: DEMO_PASSWORD }),
  });
  const cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/collector${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`demo seed ${path} failed: ${res.status}`);
    return (await res.json()) as { round: { id: string } };
  };
  const dayFromNow = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  // Ramat: planned, route not built yet (step 1). Everyone is in the round (ADR-0012).
  await call('/rounds', {
    date: dayFromNow(2),
    region: 'ramat',
    orderIds: orderIdsRamat,
    personalText: 'שלום, איסוף בקבוקים למען תפילין לבר מצווה',
    pickupFrom: '08:00',
    pickupBy: '09:00',
  });

  // Old city: planned and the route built (step 2).
  const old = await call('/rounds', {
    date: dayFromNow(4),
    region: 'old',
    orderIds: orderIdsOld,
    personalText: '',
    pickupBy: '08:00',
  });
  await call(`/rounds/${old.round.id}/route`);
}

createApp(deps).listen(PORT, (error) => {
  if (error) {
    console.error(`demo api could not listen on port ${PORT}: ${error.message}`);
    process.exit(1);
  }
  console.log(`demo api on http://localhost:${PORT} (password: ${DEMO_PASSWORD}, data in memory)`);
  void (async () => {
    const ramat = await seedOrders('ramat', RAMAT, 1);
    const old = await seedOrders('old', OLD, 11);
    await seedRounds(ramat, old);
    console.log('demo data ready: 10 orders, 2 rounds');
  })().catch((seedError: unknown) => {
    console.error(seedError instanceof Error ? seedError.message : 'demo seed failed');
  });
});
