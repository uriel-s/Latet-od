import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Link, matchRoute, navigate, useLocation } from './router.tsx';

/** Shows the location the way a page reads it. */
function ShowLocation() {
  const { pathname, state } = useLocation();
  return (
    <>
      <p>{`path: ${pathname}`}</p>
      <p>{`state: ${JSON.stringify(state)}`}</p>
    </>
  );
}

/**
 * Records whether a click reached the window with its default action prevented, then prevents
 * it: jsdom does not implement leaving the page, and would only log "not implemented".
 */
function recordClickDefault(): { wasPrevented: () => boolean | undefined; stop: () => void } {
  let prevented: boolean | undefined;
  const listener = (event: MouseEvent) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener('click', listener);
  return {
    wasPrevented: () => prevented,
    stop: () => window.removeEventListener('click', listener),
  };
}

describe('matchRoute', () => {
  it('sends / to the order form', () => {
    expect(matchRoute('/')).toEqual({ name: 'orderForm' });
  });

  it('sends /o/<token> to the order page with its token, with or without a trailing slash', () => {
    expect(matchRoute('/o/abc_DEF-123')).toEqual({ name: 'orderPage', token: 'abc_DEF-123' });
    expect(matchRoute('/o/abc_DEF-123/')).toEqual({ name: 'orderPage', token: 'abc_DEF-123' });
  });

  it('treats /o/ without a token, with two segments or with other characters as not found', () => {
    expect(matchRoute('/o/')).toEqual({ name: 'notFound' });
    expect(matchRoute('/o')).toEqual({ name: 'notFound' });
    expect(matchRoute('/o/abc/def')).toEqual({ name: 'notFound' });
    expect(matchRoute('/o/abc%20def')).toEqual({ name: 'notFound' });
  });

  it('sends /login to the login page, with or without a trailing slash', () => {
    expect(matchRoute('/login')).toEqual({ name: 'login' });
    expect(matchRoute('/login/')).toEqual({ name: 'login' });
  });

  it('sends /app and every path under it to the collector app with the rest of the path', () => {
    expect(matchRoute('/app')).toEqual({ name: 'collector', path: '' });
    expect(matchRoute('/app/')).toEqual({ name: 'collector', path: '' });
    expect(matchRoute('/app/rounds')).toEqual({ name: 'collector', path: 'rounds' });
    expect(matchRoute('/app/rounds/12/')).toEqual({ name: 'collector', path: 'rounds/12' });
  });

  it('treats paths that only start like a route as not found', () => {
    expect(matchRoute('/apps')).toEqual({ name: 'notFound' });
    expect(matchRoute('/loginx')).toEqual({ name: 'notFound' });
    expect(matchRoute('/orders')).toEqual({ name: 'notFound' });
    expect(matchRoute('/index.html')).toEqual({ name: 'notFound' });
  });
});

describe('navigate and useLocation', () => {
  it('re-renders a component that reads the location', () => {
    render(<ShowLocation />);
    expect(screen.getByText('path: /')).toBeDefined();

    act(() => navigate('/login'));

    expect(screen.getByText('path: /login')).toBeDefined();
    expect(window.location.pathname).toBe('/login');
  });

  it('exposes the state passed to navigate as useLocation().state', () => {
    render(<ShowLocation />);
    expect(screen.getByText('state: null')).toBeDefined();

    act(() => navigate('/', { state: { orderPrefill: { name: 'משה' } } }));

    expect(screen.getByText('state: {"orderPrefill":{"name":"משה"}}')).toBeDefined();
  });

  it('adds a history entry, or replaces the current one when asked', () => {
    const before = window.history.length;

    act(() => navigate('/login'));
    expect(window.history.length).toBe(before + 1);

    act(() => navigate('/app', { replace: true }));
    expect(window.history.length).toBe(before + 1);
    expect(window.location.pathname).toBe('/app');
  });

  it('re-renders on the back and forward buttons (popstate)', () => {
    render(<ShowLocation />);

    // What the browser does on "back": the URL changes, then popstate fires.
    window.history.pushState({ from: 'back' }, '', '/o/abc');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(screen.getByText('path: /o/abc')).toBeDefined();
    expect(screen.getByText('state: {"from":"back"}')).toBeDefined();
  });

  it('returns the same object while nothing has changed', () => {
    const { result, rerender } = renderHook(() => useLocation());
    const first = result.current;

    rerender();
    act(() => navigate('/'));

    expect(result.current).toBe(first);
  });
});

describe('Link', () => {
  it('renders a real link to its path', () => {
    render(<Link to="/login">כניסה</Link>);

    expect(screen.getByRole('link', { name: 'כניסה' }).getAttribute('href')).toBe('/login');
  });

  it('navigates inside the page on a plain click, without loading a new page', () => {
    render(
      <>
        <Link to="/o/abc">לעמוד ההזמנה</Link>
        <ShowLocation />
      </>,
    );
    const clicks = recordClickDefault();

    fireEvent.click(screen.getByRole('link', { name: 'לעמוד ההזמנה' }));
    clicks.stop();

    expect(clicks.wasPrevented()).toBe(true);
    expect(screen.getByText('path: /o/abc')).toBeDefined();
  });

  it('passes its state to the target page', () => {
    render(
      <>
        <Link to="/" state={{ orderPrefill: { name: 'משה' } }}>
          הזמנה חדשה עם אותם פרטים
        </Link>
        <ShowLocation />
      </>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'הזמנה חדשה עם אותם פרטים' }));

    expect(screen.getByText('state: {"orderPrefill":{"name":"משה"}}')).toBeDefined();
  });

  it('leaves a ctrl-click (open in a new tab) to the browser', () => {
    render(
      <>
        <Link to="/login">כניסה</Link>
        <ShowLocation />
      </>,
    );
    const clicks = recordClickDefault();

    fireEvent.click(screen.getByRole('link', { name: 'כניסה' }), { ctrlKey: true });
    clicks.stop();

    expect(clicks.wasPrevented()).toBe(false);
    expect(screen.getByText('path: /')).toBeDefined();
  });
});
