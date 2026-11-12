// Which api client the screens talk to. Every screen reads the client functions from `useApi()`
// instead of importing them or taking them as props, so a test swaps in fakes in one place
// (renderWithApi.tsx) and production code wraps nothing: outside any `ApiProvider` the context
// answers `realApi`, the endpoints of the resource modules next to this file.
import { createContext, useContext, type ReactNode } from 'react';
import {
  type AddOrderRequest,
  type CreateOrderRequest,
  type CustomerUpdateOrderRequest,
  type MoveStopRequest,
  type PlanRoundRequest,
  type PushSubscription,
  type UpdateOrderRequest,
} from '@bottlerun/shared';
import { fetchSession, login, logout, type LoginOutcome, type SessionOutcome } from './authApi.ts';
import { createOrder, type CreateOrderOutcome } from './bookingApi.ts';
import {
  addCollectorOrder,
  cancelCollectorOrder,
  deleteCollectorOrder,
  fetchCollectorOrder,
  fetchWaitingOrders,
  markMessageOpened,
  updateCollectorOrder,
  type CollectorOrderOutcome,
  type CollectorOrderWriteOutcome,
  type DeleteCollectorOrderOutcome,
  type MarkMessageOpenedOutcome,
  type WaitingOrdersOutcome,
} from './collectorOrdersApi.ts';
import {
  cancelCustomerOrder,
  declineCustomerOrder,
  fetchCustomerOrder,
  updateCustomerOrder,
  type CustomerOrderOutcome,
  type CustomerOrderWriteOutcome,
} from './customerOrderApi.ts';
import { fetchHistory, type HistoryOutcome } from './historyApi.ts';
import {
  deletePushSubscription,
  fetchPushConfig,
  savePushSubscription,
  type DeletePushSubscriptionOutcome,
  type PushConfigOutcome,
  type SavePushSubscriptionOutcome,
} from './pushApi.ts';
import {
  buildRoute,
  closeRound,
  collectStop,
  fetchRounds,
  markStopNotFound,
  moveStop,
  planRound,
  type BuildRouteOutcome,
  type CloseRoundOutcome,
  type PlanRoundOutcome,
  type RoundsOutcome,
  type StopActionOutcome,
} from './roundsApi.ts';

/**
 * Every call a screen can make to the api, one property per endpoint, named after the endpoint
 * function in its resource module (see that function for what the call does and what each outcome
 * means). None takes a fetch: which fetch is used is the client's business, not the screen's.
 * None rejects: each answers an outcome, `failed` when nothing better can be said.
 *
 * Properties, not methods, so a screen may destructure them (`const { login } = useApi()`) and
 * list them as effect dependencies: each keeps its identity as long as the client does.
 *
 * `warmUp` (request.ts) is not here: main.tsx fires it once at startup, outside any screen.
 */
export interface Api {
  // authApi.ts: the collector's session (ADR-0004)
  login: (password: string) => Promise<LoginOutcome>;
  fetchSession: () => Promise<SessionOutcome>;
  logout: () => Promise<boolean>;

  // bookingApi.ts: the public booking form
  createOrder: (order: CreateOrderRequest) => Promise<CreateOrderOutcome>;

  // customerOrderApi.ts: the customer's page /o/<token>
  fetchCustomerOrder: (token: string) => Promise<CustomerOrderOutcome>;
  declineCustomerOrder: (token: string) => Promise<CustomerOrderWriteOutcome>;
  cancelCustomerOrder: (token: string) => Promise<CustomerOrderWriteOutcome>;
  updateCustomerOrder: (
    token: string,
    body: CustomerUpdateOrderRequest,
  ) => Promise<CustomerOrderWriteOutcome>;

  // collectorOrdersApi.ts: the collector's orders
  fetchWaitingOrders: () => Promise<WaitingOrdersOutcome>;
  fetchCollectorOrder: (id: string) => Promise<CollectorOrderOutcome>;
  addCollectorOrder: (body: AddOrderRequest) => Promise<CollectorOrderWriteOutcome>;
  updateCollectorOrder: (
    id: string,
    body: UpdateOrderRequest,
  ) => Promise<CollectorOrderWriteOutcome>;
  cancelCollectorOrder: (id: string) => Promise<CollectorOrderWriteOutcome>;
  deleteCollectorOrder: (id: string) => Promise<DeleteCollectorOrderOutcome>;
  markMessageOpened: (orderId: string, messageIndex: number) => Promise<MarkMessageOpenedOutcome>;

  // roundsApi.ts: rounds and their routes
  fetchRounds: () => Promise<RoundsOutcome>;
  planRound: (body: PlanRoundRequest) => Promise<PlanRoundOutcome>;
  buildRoute: (roundId: string) => Promise<BuildRouteOutcome>;
  moveStop: (
    roundId: string,
    orderId: string,
    direction: MoveStopRequest['direction'],
  ) => Promise<StopActionOutcome>;
  collectStop: (
    roundId: string,
    orderId: string,
    bottlesCollected?: number,
  ) => Promise<StopActionOutcome>;
  markStopNotFound: (roundId: string, orderId: string) => Promise<StopActionOutcome>;
  closeRound: (roundId: string) => Promise<CloseRoundOutcome>;

  // historyApi.ts: the monthly history
  fetchHistory: (month: string) => Promise<HistoryOutcome>;

  // pushApi.ts: Web Push (ADR-0013)
  fetchPushConfig: () => Promise<PushConfigOutcome>;
  /** The browser subscription's JSON (`subscription.toJSON()`), in its shared shape. */
  savePushSubscription: (subscription: PushSubscription) => Promise<SavePushSubscriptionOutcome>;
  deletePushSubscription: (endpoint: string) => Promise<DeletePushSubscriptionOutcome>;
}

/**
 * The real client: each property calls its endpoint with the global fetch. Wrappers, not the
 * endpoint functions themselves, so an extra argument (a callback's index, say) can never land in
 * the endpoint's trailing `fetchFn` parameter.
 */
export const realApi: Api = {
  login: (password) => login(password),
  fetchSession: () => fetchSession(),
  logout: () => logout(),

  createOrder: (order) => createOrder(order),

  fetchCustomerOrder: (token) => fetchCustomerOrder(token),
  declineCustomerOrder: (token) => declineCustomerOrder(token),
  cancelCustomerOrder: (token) => cancelCustomerOrder(token),
  updateCustomerOrder: (token, body) => updateCustomerOrder(token, body),

  fetchWaitingOrders: () => fetchWaitingOrders(),
  fetchCollectorOrder: (id) => fetchCollectorOrder(id),
  addCollectorOrder: (body) => addCollectorOrder(body),
  updateCollectorOrder: (id, body) => updateCollectorOrder(id, body),
  cancelCollectorOrder: (id) => cancelCollectorOrder(id),
  deleteCollectorOrder: (id) => deleteCollectorOrder(id),
  markMessageOpened: (orderId, messageIndex) => markMessageOpened(orderId, messageIndex),

  fetchRounds: () => fetchRounds(),
  planRound: (body) => planRound(body),
  buildRoute: (roundId) => buildRoute(roundId),
  moveStop: (roundId, orderId, direction) => moveStop(roundId, orderId, direction),
  collectStop: (roundId, orderId, bottlesCollected) =>
    collectStop(roundId, orderId, bottlesCollected),
  markStopNotFound: (roundId, orderId) => markStopNotFound(roundId, orderId),
  closeRound: (roundId) => closeRound(roundId),

  fetchHistory: (month) => fetchHistory(month),

  fetchPushConfig: () => fetchPushConfig(),
  savePushSubscription: (subscription) => savePushSubscription(subscription),
  deletePushSubscription: (endpoint) => deletePushSubscription(endpoint),
};

// The default value is the real client, so production renders no provider at all.
const ApiContext = createContext<Api>(realApi);

/** The api client of the screen: `realApi`, unless an {@link ApiProvider} above gives another. */
export function useApi(): Api {
  return useContext(ApiContext);
}

/** Props of {@link ApiProvider}. */
export interface ApiProviderProps {
  /**
   * The client the screens below use. Keep its identity across renders: a screen that loads in an
   * effect lists the function as a dependency, and a new one loads again.
   */
  api: Api;
  children?: ReactNode;
}

/**
 * Gives the screens below another api client. Only tests use it (through renderWithApi.tsx):
 * production code wraps nothing and gets {@link realApi}.
 */
export function ApiProvider({ api, children }: ApiProviderProps) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}
