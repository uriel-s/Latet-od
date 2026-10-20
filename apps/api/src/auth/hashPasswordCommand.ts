// The logic of `npm run hash-password` (ADR-0004): reads the collector's new password and prints
// its `scrypt$<salt>$<hash>` for COLLECTOR_PASSWORD_HASH. The terminal plumbing (muted prompts,
// reading a pipe) lives in hashPasswordCli.ts and is injected, so this part is tested without a
// terminal.
import { LOGIN_PASSWORD_MAX_LENGTH } from '@bottlerun/shared';
import { hashPassword } from './passwordHash.ts';

/**
 * Shortest password the script accepts. Yoel wants one he can type easily, so the floor is 8
 * (decided 2026-10-20, amending ADR-0004's "sentence of four words"). At this length the login's
 * attempt limit (loginLimits.ts) is the real protection, which is why it counts attempts before
 * the password is checked.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** How {@link runHashPassword} talks to the outside world. */
export interface HashPasswordIO {
  /**
   * True when a person types the password at a terminal: it is asked twice, and both must match,
   * because with the echo muted nobody sees a typo. False when it comes from a pipe.
   */
  interactive: boolean;
  /**
   * Reads one password. Interactive: shows `prompt` (on stderr) and reads one line with the echo
   * muted. Piped: reads the whole input, minus one trailing newline, and ignores `prompt`.
   */
  readPassword: (prompt: string) => Promise<string>;
  /** Standard output: only the hash line goes here, so `npm run -s hash-password | clip` works. */
  writeOut: (text: string) => void;
  /** Standard error: every message for the person running the script. */
  writeErr: (text: string) => void;
}

/**
 * Removes one line ending (`\r\n` or `\n`) from the end of piped input: the one `echo` or a text
 * file adds. Only one, and nothing else: any other character, spaces included, is part of the
 * password.
 */
export function stripOneTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/**
 * Why `password` cannot be the collector's password, as a sentence for stderr, or null when it
 * can. Lengths count UTF-16 units, like the login's zod `.max()`, so a password this accepts is
 * never one the login refuses as too long.
 */
function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password is shorter than ${MIN_PASSWORD_LENGTH} characters. ` + 'Use a longer one.';
  }
  if (password.length > LOGIN_PASSWORD_MAX_LENGTH) {
    return `The password is longer than ${LOGIN_PASSWORD_MAX_LENGTH} characters; the login would refuse it.`;
  }
  // A space at either end (say the one cmd's `echo pw | …` leaves before the pipe) would make a
  // hash that the password as Yoel types it at login never matches.
  if (password.trim() !== password) {
    return 'The password starts or ends with a space or a line break. Remove it and try again.';
  }
  return null;
}

/**
 * Runs the hash-password script: reads the password, refuses one that is too short, too long or
 * padded with spaces, asks again at a terminal and refuses a mismatch, then prints the hash line.
 * Returns the process exit code: 0 when the hash was printed, 1 when nothing was. Never prints the
 * password, and never takes it from the command line, where it would stay in the shell history.
 */
export async function runHashPassword(io: HashPasswordIO): Promise<number> {
  const password = await io.readPassword('New password (at least 8 characters): ');

  const problem = passwordProblem(password);
  if (problem !== null) {
    io.writeErr(`${problem}\n`);
    return 1;
  }

  if (io.interactive) {
    const again = await io.readPassword('Type it again: ');
    if (again !== password) {
      io.writeErr('The two passwords differ. Nothing was printed; run the script again.\n');
      return 1;
    }
  }

  io.writeOut(`${await hashPassword(password)}\n`);
  io.writeErr(
    'Set this line as COLLECTOR_PASSWORD_HASH (apps/api/.env, and the host), then redeploy.\n',
  );
  return 0;
}
