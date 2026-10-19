// Runs the AttemptStore contract on the in-memory fake, which the login and rate-limit tests use.
import { describeAttemptStoreContract } from './attemptStore.contract.ts';
import { InMemoryAttemptStore } from './inMemoryAttemptStore.ts';

describeAttemptStoreContract('InMemoryAttemptStore', (now) => new InMemoryAttemptStore({ now }));
