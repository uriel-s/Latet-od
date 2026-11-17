// Whether the component is still on screen, for code that runs after an await. An answer that
// comes after the user left (Yoel tapped the bottom navigation, the customer closed the page) must
// change nothing, above all not navigate away from the screen they went to.
import { useEffect, useRef, type RefObject } from 'react';

/** A ref that is true from mount until unmount. */
export function useMountedRef(): Readonly<RefObject<boolean>> {
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return mountedRef;
}
