import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '3100', 10);
const host = process.env.HOST ?? '127.0.0.1';
const app = await createApp({ logger: true, serveStatic: process.env.FACTORY_WEB !== 'disabled' });

const address = await app.listen({ host, port });
app.log.info(`Agentic Workflow Factory listening at ${address}`);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
