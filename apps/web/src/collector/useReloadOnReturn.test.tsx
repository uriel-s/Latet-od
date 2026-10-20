// Tests for useReloadOnReturn: it calls the reload callback when the page becomes visible again,
// and at no other time. jsdom's document.visibilityState is fixed, so each test overrides it.
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReloadOnReturn } from './useReloadOnReturn.ts';

/** Sets `document.visibilityState` and fires `visibilitychange`, as the browser does. */
function changeVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  // Drop the override, so jsdom's own getter on Document.prototype answers again.
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('useReloadOnReturn', () => {
  it('reloads when the page becomes visible again', () => {
    const reload = vi.fn();
    renderHook(() => {
      useReloadOnReturn(reload);
    });

    changeVisibility('hidden');
    changeVisibility('visible');

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the page becomes hidden', () => {
    const reload = vi.fn();
    renderHook(() => {
      useReloadOnReturn(reload);
    });

    changeVisibility('hidden');

    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload on mount', () => {
    const reload = vi.fn();

    renderHook(() => {
      useReloadOnReturn(reload);
    });

    expect(reload).not.toHaveBeenCalled();
  });

  it('stops reloading after unmount', () => {
    const reload = vi.fn();
    const { unmount } = renderHook(() => {
      useReloadOnReturn(reload);
    });

    unmount();
    changeVisibility('visible');

    expect(reload).not.toHaveBeenCalled();
  });

  it('calls the latest callback after a rerender', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ reload }: { reload: () => void }) => {
        useReloadOnReturn(reload);
      },
      { initialProps: { reload: first } },
    );

    rerender({ reload: second });
    changeVisibility('visible');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
