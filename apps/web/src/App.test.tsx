import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.tsx';

/** One path for each route, for the checks every page must pass. */
const ONE_PATH_PER_ROUTE = ['/', '/o/abc', '/login', '/app/rounds', '/no-such-page'];

/** Renders the app as if the browser had opened `path`. */
function renderAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<App />);
}

describe('App', () => {
  it('shows the booking form at /', () => {
    renderAt('/');

    expect(screen.getByRole('heading', { level: 1, name: 'הזמנת איסוף בקבוקים' })).toBeDefined();
  });

  it('shows the order page at /o/<token>', () => {
    renderAt('/o/abc');

    expect(screen.getByRole('heading', { level: 1, name: 'עמוד ההזמנה' })).toBeDefined();
  });

  it('shows the login page at /login', () => {
    renderAt('/login');

    expect(screen.getByRole('heading', { level: 1, name: 'כניסה' })).toBeDefined();
  });

  it('shows the collector app at /app and the paths under it', () => {
    renderAt('/app/rounds');

    expect(screen.getByRole('heading', { level: 1, name: 'אפליקציית האוסף' })).toBeDefined();
  });

  it('shows "page not found" for an unknown path', () => {
    renderAt('/no-such-page');

    expect(screen.getByRole('heading', { level: 1, name: 'העמוד לא נמצא' })).toBeDefined();
  });

  it('leads from "page not found" back to the booking form', () => {
    renderAt('/o/');

    fireEvent.click(screen.getByRole('link', { name: 'לטופס ההזמנה' }));

    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('heading', { level: 1, name: 'הזמנת איסוף בקבוקים' })).toBeDefined();
  });

  it.each(ONE_PATH_PER_ROUTE)('credits OpenStreetMap in the footer at %s', (path) => {
    renderAt(path);

    const footer = screen.getByRole('contentinfo');
    const credit = within(footer).getByRole('link', { name: '© OpenStreetMap contributors' });
    expect(credit.getAttribute('href')).toBe('https://www.openstreetmap.org/copyright');
  });

  it.each(ONE_PATH_PER_ROUTE)('shows the app name and slogan at %s', (path) => {
    renderAt(path);

    const header = screen.getByRole('banner');
    expect(within(header).getByText('לתת עוד')).toBeDefined();
    expect(within(header).getByText('הבקבוקים שלכם, התפילין שלהם!')).toBeDefined();
  });

  it.each(ONE_PATH_PER_ROUTE)('renders exactly one h1, inside main, at %s', (path) => {
    renderAt(path);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1 })).toBeDefined();
  });
});
