// Entry of `npm run hash-password --workspace apps/api` (ADR-0004): prints the value for
// COLLECTOR_PASSWORD_HASH. The logic is runHashPassword (hashPasswordCommand.ts, tested); this
// file only connects it to the terminal.
//
// At a terminal it asks twice with the echo muted. Without one it reads all of stdin instead, so
// it also works in Git Bash's own window (mintty), where Node sees no terminal:
//   read -rs PW; printf '%s' "$PW" | npm run -s hash-password --workspace apps/api | clip; unset PW
// `-s` keeps npm's banner off stdout, so only the hash line reaches the clipboard.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { runHashPassword, stripOneTrailingNewline } from './hashPasswordCommand.ts';

/** Swallows readline's echo of what is typed, so the password never shows on the screen. */
const mutedOutput = new Writable({ write: (_chunk, _encoding, callback) => callback() });

/** Shows `prompt` on stderr and reads one line from the terminal without echoing it. */
async function readHiddenLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const lineReader = createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true,
  });
  // In raw mode Ctrl+C reaches readline, not the process: stop here, with nothing on stdout.
  lineReader.on('SIGINT', () => {
    lineReader.close();
    process.stderr.write('\n');
    process.exit(130);
  });
  try {
    return await lineReader.question('');
  } finally {
    lineReader.close();
    process.stderr.write('\n');
  }
}

const interactive = process.stdin.isTTY === true;

process.exitCode = await runHashPassword({
  interactive,
  readPassword: interactive
    ? readHiddenLine
    : async () => stripOneTrailingNewline(await text(process.stdin)),
  writeOut: (output) => {
    process.stdout.write(output);
  },
  writeErr: (message) => {
    process.stderr.write(message);
  },
});
