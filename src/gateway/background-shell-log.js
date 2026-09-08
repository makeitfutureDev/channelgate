import { readFileSync } from "node:fs";

// A detached container exec has no stdio connection to the daemon. Ship the SAME exact-value
// redactor into its small Node wrapper; values are read from the job's existing environment,
// never placed in argv or in a generated file. The module has no imports or runtime side effects.
const redactorSource = readFileSync(new URL("../util/redact.js", import.meta.url), "utf8");
const workerSource = `${redactorSource}
import { openSync, writeSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [command, logFile, namesJson] = process.argv.slice(1);
const values = JSON.parse(namesJson).map(name => process.env[name]).filter(Boolean);
const fd = openSync(logFile, 'w', 0o600);
const child = spawn('/bin/bash', ['-lc', command], { stdio: ['ignore', 'pipe', 'pipe'] });
let failed = false;
let spawnFailed = false;
function persist(text) {
  if (!text || failed) return;
  try {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!written) throw new Error('Job log write made no progress');
      offset += written;
    }
  }
  catch { failed = true; child.kill('SIGTERM'); process.exitCode = 1; }
}
// Independent streams must retain independent partial matches: stderr arriving between two
// stdout chunks must not make a stdout secret prefix eligible for persistence.
const redactors = [createSecretRedactor(values), createSecretRedactor(values)];
for (const [index, stream] of [child.stdout, child.stderr].entries()) {
  stream.setEncoding('utf8');
  stream.on('data', chunk => persist(redactors[index].push(chunk)));
}
child.on('error', () => { spawnFailed = true; persist('Background shell could not start.\\n'); });
child.on('close', (code, signal) => {
  for (const redactor of redactors) persist(redactor.flush());
  // A signal is an unknown exit status, never a fabricated success. The runtime's existing
  // vanished-process recovery path handles a wrapper killed before it can append this marker.
  const status = spawnFailed ? 127 : Number.isInteger(code) && code >= 0 ? code : null;
  if (status !== null) persist('\\n[cg-exit:' + status + ']\\n');
  closeSync(fd);
  process.exitCode = failed ? 1 : status ?? 1;
});
`;

const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

export function containerJobScript(command, logFile, secretNames = []) {
  return `exec node --input-type=module -e ${quote(workerSource)} -- ${quote(command)} ${quote(logFile)} ${quote(JSON.stringify(secretNames))}`;
}
