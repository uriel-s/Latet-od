import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Link, matchRoute, navigate, searchParam, useLocation } from './router.tsx';

/** Shows the location the way a page reads it. */
function ShowLocation() {
  const { pathname, search, state } = useLocation();
  return (
    <>
      <p>{`path: ${pathname}`}</p>
      <p>{`search: [${search}]`}</p>
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

describe('query string', () => {
  // The other tests only care about the path; here the query must not leak into the next test.
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('exposes the query string as useLocation().search, empty when there is none', () => {
    const { result } = renderHook(() => useLocation());
    expect(result.current.search).toBe('');

    act(() => navigate('/app/rounds?round=abc'));

    expect(result.current.pathname).toBe('/app/rounds');
    expect(result.current.search).toBe('?round=abc');
    expect(window.location.search).toBe('?round=abc');
  });

  it('re-renders a component when navigate changes the query', () => {
    render(<ShowLocation />);
    expect(screen.getByText('search: []')).toBeDefined();

    act(() => navigate('/app/rounds?round=abc'));

    expect(screen.getByText('search: [?round=abc]')).toBeDefined();
  });

  it('re-renders once, without looping, when a replace changes only the query', () => {
    window.history.replaceState(null, '', '/app/rounds?round=abc');
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useLocation();
    });
    const rendersBefore = renders;
    const historyLength = window.history.length;

    act(() => navigate('/app/rounds?round=def', { replace: true }));

    expect(renders).toBe(rendersBefore + 1);
    expect(result.current.search).toBe('?round=def');
    expect(window.history.length).toBe(historyLength);
  });

  it('keeps the same object when the query is unchanged', () => {
    window.history.replaceState(null, '', '/app/rounds?round=abc');
    const { result } = renderHook(() => useLocation());
    const first = result.current;

    act(() => navigate('/app/rounds?round=abc', { replace: true, state: window.history.state }));

    expect(result.current).toBe(first);
  });

  it('does not let the query change which page matchRoute picks', () => {
    renderHook(() => useLocation());
    act(() => navigate('/app/rounds?round=abc'));

    expect(matchRoute(window.location.pathname)).toEqual({ name: 'collector', path: 'rounds' });
  });
});

describe('searchParam', () => {
  it('returns the value of a present parameter, with or without the leading ?', () => {
    expect(searchParam('?round=abc', 'round')).toBe('abc');
    expect(searchParam('round=abc&x=1', 'round')).toBe('abc');
  });

  it('returns undefined for a missing parameter or an empty query', () => {
    expect(searchParam('?x=1', 'round')).toBeUndefined();
    expect(searchParam('', 'round')).toBeUndefined();
  });

  it('returns undefined for an empty value', () => {
    expect(searchParam('?round=', 'round')).toBeUndefined();
    expect(searchParam('?round', 'round')).toBeUndefined();
  });

  it('decodes percent-encoded values', () => {
    expect(searchParam('?round=a%20b%26c', 'round')).toBe('a b&c');
    expect(searchParam('?round=%D7%A1%D7%91%D7%91', 'round')).toBe('סבב');
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
