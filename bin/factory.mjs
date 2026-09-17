#!/usr/bin/env node

import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules', '.bin', 'tsx');

try {
  await access(tsx, constants.X_OK);
} catch {
  console.error('FACTORY CLI dependencies are missing. Run `npm install` in the project first.');
  process.exit(1);
}

const child = spawn(tsx, [path.join(root, 'scripts', 'factory.ts'), ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`FACTORY CLI failed to start: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
