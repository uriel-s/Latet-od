import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useMountedRef } from './useMountedRef.ts';

describe('useMountedRef', () => {
  it('is true while mounted and false after unmount', () => {
    const { result, unmount } = renderHook(() => useMountedRef());
    const mountedRef = result.current;

    expect(mountedRef.current).toBe(true);
    unmount();
    expect(mountedRef.current).toBe(false);
  });
});
