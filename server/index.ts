import { RehearsalEngine } from './engine.js';
import { createApp } from './app.js';
import { dbPath } from './config.js';

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer from 1 to 65535.');
const engine = new RehearsalEngine(dbPath);
const app = createApp(engine);
const server = app.listen(port, host, () => {
  const recovered = engine.recoverInterruptedDemos();
  if (recovered)
    console.log(
      `Closed ${recovered} interrupted demonstration run(s). Their traces remain available in run history.`,
    );
  console.log(`Agent Rehearsal is ready at http://localhost:${port}`);
});
server.on('error', (error) => {
  console.error(error.message);
  engine.close();
  process.exitCode = 1;
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await Promise.allSettled(app.locals.tasks);
  engine.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
