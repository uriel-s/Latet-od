// Test helper (imported only from *.test.tsx, never from production code): renders a screen under
// an ApiProvider whose client is the full `realApi` with some of its functions replaced by fakes.
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { ApiProvider, realApi, type Api } from './ApiContext.tsx';

/**
 * The full client with `overrides` in place of the real functions. A function not overridden is
 * the real one, which sends through the global fetch: a test that stubs fetch (vi.stubGlobal)
 * still sees it, as it does in production.
 */
export function apiWith(overrides: Partial<Api> = {}): Api {
  return { ...realApi, ...overrides };
}

/**
 * Renders `ui` under an {@link ApiProvider} giving `apiWith(overrides)`, and returns Testing
 * Library's result plus that client. The provider is the render's `wrapper`, so `rerender` keeps
 * it, with the same client: its functions keep their identity, and a screen that loads in an
 * effect does not load again.
 */
export function renderWithApi(
  ui: ReactElement,
  overrides: Partial<Api> = {},
  options: Omit<RenderOptions, 'wrapper'> = {},
): RenderResult & { api: Api } {
  const api = apiWith(overrides);
  function Wrapper({ children }: { children: ReactNode }) {
    return <ApiProvider api={api}>{children}</ApiProvider>;
  }
  return { ...render(ui, { ...options, wrapper: Wrapper }), api };
}
