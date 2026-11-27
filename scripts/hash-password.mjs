#!/usr/bin/env node
// Print an ADMIN_PASSWORD line whose value is a scrypt hash, so the .env copy of the admin
// password is a verifier rather than the password itself:
//
//   npm run hash-password            (prompts twice, without echo)
//   printf %s "$PW" | npm run --silent hash-password
//
// The password is never taken from argv: that would put it in the shell history and in the
// process list. Only the ready-to-paste line goes to stdout; everything else goes to stderr.
// Single quotes keep the "$" separators literal for Node's .env loader, for systemd's
// EnvironmentFile and for a shell that sources the file.
import { hashPassword } from "../src/web/password-hash.js";

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    // Echo off BEFORE the prompt is visible: the prompt is what tells a person (or a paste) to
    // start typing, and whatever arrives while the terminal is still in cooked mode is echoed.
    stdin.setRawMode(true);
    stderr.write(prompt);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const done = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPiped() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value.replace(/\r?\n$/, ""); // one trailing newline is the pipe's, not the password's
}

async function main() {
  let password;
  if (process.stdin.isTTY) {
    password = await readHidden("New admin password: ");
    if (password && (await readHidden("Repeat it: ")) !== password) throw new Error("the two entries differ");
  } else {
    password = await readPiped();
  }
  if (!password) throw new Error("empty password");
  process.stdout.write(`ADMIN_PASSWORD='${await hashPassword(password)}'\n`);
  process.stderr.write("Put that line in .env in place of the current ADMIN_PASSWORD line, then restart the gateway.\n");
}

main().catch((error) => {
  process.stderr.write(`hash-password: ${error.message}\n`);
  process.exitCode = 1;
});
