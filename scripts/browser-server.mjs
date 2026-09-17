import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const dataFile = path.join(process.cwd(), '.data', 'browser-state.json');
await mkdir(path.dirname(dataFile), { recursive: true });
await rm(dataFile, { force: true });

const child = spawn('npm', ['run', 'server'], {
  env: {
    ...process.env,
    DATA_FILE: dataFile,
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    PORT: '4173',
  },
  stdio: 'inherit',
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  child.kill(signal);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
child.on('exit', (code, signal) => {
  if (!shuttingDown && signal === null && code !== 0) process.exitCode = code ?? 1;
});
