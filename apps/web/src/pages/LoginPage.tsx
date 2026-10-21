// The collector's login at `/login` (spec §3.4, ADR-0004): one password field, no username (there
// is one collector, Yoel). The check and the session cookie are the api's (api.ts `login`); this
// screen holds what he typed, shows each answer in plain words, and opens the app on success.
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { LOGIN_MESSAGES, LOGIN_PASSWORD_MAX_LENGTH } from '@bottlerun/shared';
import { NETWORK_ERROR_MESSAGE, login, type LoginOutcome } from '../api.ts';
import { TextField } from '../components/TextField.tsx';
import { navigate } from '../router.tsx';
import {
  INSTALL_HINT_TEXT,
  shouldShowInstallHint,
  type InstallHintNavigator,
} from './installHint.ts';

const SUBMIT_LABEL = 'כניסה';
const SENDING_LABEL = 'נכנס...';

/** Props of {@link LoginPage}. */
export interface LoginPageProps {
  /**
   * Sends the password. Defaults to {@link login} (POST /api/auth/login, never retried); tests
   * pass a fake that records what it was given.
   */
  submitLogin?: (password: string) => Promise<LoginOutcome>;
  /**
   * The browser the install hint is decided for. Defaults to the real `navigator`; tests pass an
   * iPhone, a desktop or the installed app without stubbing the global.
   */
  browser?: InstallHintNavigator;
}

/**
 * The collector's login screen. Renders the page's only `<h1>` (Layout's heading rule).
 *
 * The password lives only in this component's state: never trimmed (spaces are part of a sentence
 * password), never stored in the browser, never logged. An empty field is caught here and sends
 * nothing; a wrong password is shown next to the field, and the limits on failures above the form.
 * On success the app opens in place of this screen, which leaves the history: "back" from the app
 * must not land on a password form for a session that is already open.
 */
export function LoginPage({ submitLogin = login, browser = navigator }: LoginPageProps) {
  // Decided once: the browser and whether the page runs as the installed app do not change while
  // it is open.
  const [showInstallHint] = useState(() => shouldShowInstallHint(browser));
  const [password, setPassword] = useState('');
  // The message under the password field (empty field, wrong password).
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  // The message about the whole form (too many attempts, no connection).
  const [formAlert, setFormAlert] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  // The state above reaches the handler only after a re-render; this ref stops a second tap or
  // Enter that comes before it. Every request counts: a wrong one toward the failure limit.
  const sendingRef = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  function changePassword(nextPassword: string): void {
    setPassword(nextPassword);
    setFieldError(undefined);
  }

  /**
   * Shows `message` under the password field and moves focus there, with the typed text selected:
   * the field hides what was typed, so retyping is the likely fix, and the first key replaces the
   * whole selection without deleting it by hand first.
   */
  function showFieldError(message: string): void {
    // Rendered first, so the field is focused (and announced) together with its message; for an
    // empty field the focus call also stays inside the tap's handler, so iOS opens the keyboard.
    flushSync(() => setFieldError(message));
    passwordRef.current?.focus();
    passwordRef.current?.select();
  }

  async function send(): Promise<void> {
    if (sendingRef.current) return;
    // The only rule the form checks itself: loginRequestSchema's non-empty password. Its length
    // cap is the input's maxLength, so typing or pasting cannot go past it.
    if (password === '') {
      setFormAlert(undefined);
      showFieldError(LOGIN_MESSAGES.passwordRequired);
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setFieldError(undefined);
    setFormAlert(undefined);
    let outcome: LoginOutcome;
    try {
      outcome = await submitLogin(password);
    } catch {
      // login never rejects, but a rejection must not leave the button on "נכנס..." forever.
      outcome = { kind: 'failed' };
    }
    sendingRef.current = false;
    setSending(false);

    switch (outcome.kind) {
      case 'loggedIn':
        navigate('/app', { replace: true });
        return;
      case 'wrongPassword':
        showFieldError(outcome.message);
        return;
      case 'rateLimited':
        setFormAlert(outcome.message);
        return;
      case 'failed':
        setFormAlert(NETWORK_ERROR_MESSAGE);
        return;
    }
  }

  return (
    <>
      <h1>כניסה</h1>
      <p>כניסה לאפליקציית האוסף.</p>
      {/* iPhone Safari only (ADR-0006): "Add to Home Screen" is hidden in the Share menu, so Yoel
          needs a pointer to install the app. In the installed app or on a computer it is noise. */}
      {showInstallHint && <p>{INSTALL_HINT_TEXT}</p>}

      {/* noValidate: the browser's own bubbles would show English-shaped messages in the wrong
          place; the form shows its Hebrew message next to the field instead. */}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <TextField
          label="סיסמה"
          type="password"
          value={password}
          onChange={changePassword}
          error={fieldError}
          // Lets the phone's password manager fill in the saved password.
          autoComplete="current-password"
          maxLength={LOGIN_PASSWORD_MAX_LENGTH}
          inputRef={passwordRef}
        />

        {formAlert && (
          <p className="form-alert" role="alert">
            {formAlert}
          </p>
        )}

        {/* aria-disabled, not disabled, while sending: a disabled button drops focus to the
            page itself, and a keyboard or screen-reader user would lose their place; this one
            keeps focus and is announced as unavailable. sendingRef ignores the extra taps. */}
        <button
          type="submit"
          className="button button-primary button-block"
          aria-disabled={sending ? true : undefined}
        >
          {sending ? SENDING_LABEL : SUBMIT_LABEL}
        </button>
      </form>
    </>
  );
}
