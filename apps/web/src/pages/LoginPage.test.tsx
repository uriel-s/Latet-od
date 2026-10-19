import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOGIN_MESSAGES } from '@bottlerun/shared';
import { NETWORK_ERROR_MESSAGE, type LoginOutcome } from '../api.ts';
import { LoginPage } from './LoginPage.tsx';

/** A sentence password as ADR-0004 asks for, with spaces at both ends that must reach the api. */
const TYPED_PASSWORD = '  שמש עולה מעל ההרים הירוקים  ';

const LOGGED_IN: LoginOutcome = { kind: 'loggedIn', user: { sub: 'collector' } };

/** A promise the test settles by hand, to look at the screen while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Opens `/login` with a fake `submitLogin` that records every password it is given and answers
 * `outcome`. Returns the passwords, in order.
 */
function renderLogin(outcome: LoginOutcome | Promise<LoginOutcome> = LOGGED_IN): {
  passwords: string[];
} {
  window.history.replaceState(null, '', '/login');
  const passwords: string[] = [];
  const submitLogin = (password: string): Promise<LoginOutcome> => {
    passwords.push(password);
    return Promise.resolve(outcome);
  };
  render(<LoginPage submitLogin={submitLogin} />);
  return { passwords };
}

/** The password input. */
function passwordField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('סיסמה');
}

/** Types `text` into the password field, as Yoel would. */
function typePassword(text: string): void {
  fireEvent.change(passwordField(), { target: { value: text } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: 'כניסה' }));
}

/** The text of everything `element` is described by (aria-describedby): its error. */
function descriptionOf(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

describe('LoginPage', () => {
  it('shows the heading and a password field labelled "סיסמה"', () => {
    renderLogin();

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'כניסה' })).toBeDefined();
    const field = passwordField();
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('current-password');
    expect(field.maxLength).toBe(1000);
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });

  it('sends exactly what was typed, spaces included, and opens the app in place of the login', async () => {
    const { passwords } = renderLogin(LOGGED_IN);
    const historyLength = window.history.length;
    typePassword(TYPED_PASSWORD);

    submit();

    await waitFor(() => expect(window.location.pathname).toBe('/app'));
    expect(passwords).toEqual([TYPED_PASSWORD]);
    // Replaced, not pushed: "back" from the app does not return to the login.
    expect(window.history.length).toBe(historyLength);
  });

  it('shows "wrong password" next to the field, stays on the login and focuses the field', async () => {
    const { passwords } = renderLogin({
      kind: 'wrongPassword',
      message: LOGIN_MESSAGES.wrongPassword,
    });
    typePassword(TYPED_PASSWORD);

    submit();

    const field = passwordField();
    await waitFor(() => expect(descriptionOf(field)).toBe('הסיסמה שגויה.'));
    expect(screen.getByText('הסיסמה שגויה.')).toBeDefined();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field);
    // The typed text stays, selected, so typing again replaces it.
    expect(field.value).toBe(TYPED_PASSWORD);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(TYPED_PASSWORD.length);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(window.location.pathname).toBe('/login');
    expect(passwords).toHaveLength(1);
  });

  it('clears the wrong-password message as soon as the password is changed', async () => {
    renderLogin({ kind: 'wrongPassword', message: LOGIN_MESSAGES.wrongPassword });
    typePassword('ניחוש');
    submit();
    await screen.findByText('הסיסמה שגויה.');

    typePassword('ניחוש אחר');

    expect(screen.queryByText('הסיסמה שגויה.')).toBeNull();
    expect(passwordField().getAttribute('aria-invalid')).toBeNull();
  });

  it('asks for the password when the field is empty, focuses it, and sends nothing', () => {
    const { passwords } = renderLogin();

    submit();

    const field = passwordField();
    expect(descriptionOf(field)).toBe(LOGIN_MESSAGES.passwordRequired);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field);
    expect(passwords).toEqual([]);
    expect(window.location.pathname).toBe('/login');
  });

  it('shows the rate-limit message as an alert above the button', async () => {
    renderLogin({ kind: 'rateLimited', message: LOGIN_MESSAGES.rateLimited });
    typePassword(TYPED_PASSWORD);

    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(LOGIN_MESSAGES.rateLimited);
    expect(passwordField().getAttribute('aria-invalid')).toBeNull();
    expect(window.location.pathname).toBe('/login');
  });

  it('shows the network message when the login failed, and can try again', async () => {
    const { passwords } = renderLogin({ kind: 'failed' });
    typePassword(TYPED_PASSWORD);

    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_ERROR_MESSAGE);
    expect(passwordField().value).toBe(TYPED_PASSWORD);
    const button = screen.getByRole('button', { name: 'כניסה' });
    expect(button.getAttribute('aria-disabled')).toBeNull();

    submit();
    await waitFor(() => expect(passwords).toHaveLength(2));
    expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_ERROR_MESSAGE);
  });

  it('shows the network message when submitLogin rejects', async () => {
    window.history.replaceState(null, '', '/login');
    render(<LoginPage submitLogin={() => Promise.reject(new Error('boom'))} />);
    typePassword(TYPED_PASSWORD);

    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_ERROR_MESSAGE);
    expect(screen.getByRole('button', { name: 'כניסה' })).toBeDefined();
  });

  it('says "entering" while the request runs and ignores a second tap', async () => {
    const answer = deferred<LoginOutcome>();
    const { passwords } = renderLogin(answer.promise);
    typePassword(TYPED_PASSWORD);

    submit();
    const sending = screen.getByRole('button', { name: 'נכנס...' });
    expect(sending.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(sending);
    fireEvent.click(sending);
    expect(passwords).toHaveLength(1);

    answer.resolve(LOGGED_IN);
    await waitFor(() => expect(window.location.pathname).toBe('/app'));
    expect(passwords).toHaveLength(1);
  });

  it('never stores the password in the browser', async () => {
    renderLogin(LOGGED_IN);
    typePassword(TYPED_PASSWORD);

    submit();

    await waitFor(() => expect(window.location.pathname).toBe('/app'));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
