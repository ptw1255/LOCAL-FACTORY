import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const image = process.argv[2] ?? 'agentic-workflow-factory:ci';
const maxBytes = Number(process.env.DOCKER_IMAGE_MAX_BYTES ?? 900 * 1024 * 1024);
if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('DOCKER_IMAGE_MAX_BYTES must be a positive integer.');

let size;
try {
  const result = await execFileAsync('docker', ['image', 'inspect', image, '--format', '{{.Size}}']);
  size = Number(result.stdout.trim());
} catch (error) {
  throw new Error(`Unable to inspect Docker image "${image}". Build it first and ensure Docker is available: ${error instanceof Error ? error.message : String(error)}`);
}
if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Docker returned an invalid size for image "${image}".`);
console.log(`Docker image ${image}: ${size} / ${maxBytes} bytes`);
if (size > maxBytes) throw new Error(`Docker image "${image}" exceeds the ${maxBytes}-byte budget by ${size - maxBytes} bytes.`);
