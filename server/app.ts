import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { RehearsalEngine } from './engine.js';
import { projectRoot, dbPath as defaultDbPath } from './config.js';
import { SCENARIO_IDS } from '../shared/types.js';

export const scenarioIdSchema = z.enum(SCENARIO_IDS);
const policySchema = z.enum(['naive', 'careful', 'external']);
const runSchema = z
  .object({
    scenarioId: scenarioIdSchema,
    policy: policySchema.default('careful'),
  })
  .strict();
const compareSchema = z.object({ scenarioId: scenarioIdSchema }).strict();
const localNames = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createApp(
  engine: RehearsalEngine,
  options: { rootDir?: string; dbPath?: string; demoDelayMs?: number } = {},
) {
  const app = express();
  const root = options.rootDir ?? projectRoot;
  const tasks = new Set<Promise<unknown>>();
  app.locals.tasks = tasks;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    try {
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (!localNames.has(host))
        return res
          .status(403)
          .json({ error: 'This simulator accepts localhost requests only.' });
      if (
        req.headers.origin &&
        !localNames.has(new URL(req.headers.origin).hostname)
      ) {
        return res
          .status(403)
          .json({ error: 'Cross-origin access is not allowed.' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  const launch = (id: string) => {
    const task = engine
      .executeDemo(id, options.demoDelayMs ?? 200)
      .catch((error) => {
        console.error(
          'Demo execution failed:',
          error instanceof Error ? error.message : 'Unknown error',
        );
        engine.interruptRun(
          id,
          'The demonstration was interrupted before completion. Start a new run to try again.',
        );
      });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };

  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', version: '0.1.0' }),
  );
  app.get('/api/scenarios', (_req, res) => res.json(engine.listScenarios()));
  app.get('/api/runs', (_req, res) => res.json(engine.listRuns()));
  app.get('/api/runs/:id', (req, res) =>
    res.json(engine.getRun(req.params.id)),
  );
  app.post('/api/runs', (req, res) => {
    const { scenarioId, policy } = runSchema.parse(req.body);
    const run = engine.createRun(scenarioId, policy);
    res.status(201).json(run);
    if (policy !== 'external') launch(run.id);
  });
  app.post('/api/compare', (req, res) => {
    const { scenarioId } = compareSchema.parse(req.body);
    const naive = engine.createRun(scenarioId, 'naive');
    const careful = engine.createRun(scenarioId, 'careful');
    res.status(201).json({ naive, careful });
    launch(naive.id);
    launch(careful.id);
  });
  app.post('/api/runs/:id/finish', (req, res) => {
    const run = engine.getRun(req.params.id);
    if (run.policy !== 'external' && run.status === 'running') {
      return res
        .status(409)
        .json({ error: 'A demo policy is still executing this run.' });
    }
    res.json(engine.finishRun(run.id));
  });
  app.get('/api/connection', (_req, res) =>
    res.json({
      command: process.execPath,
      args: [join(root, 'dist/server/mcp.js')],
      cwd: root,
      dbPath: options.dbPath ?? defaultDbPath,
    }),
  );
  app.use('/api', (_req, res) =>
    res.status(404).json({ error: 'API route not found.' }),
  );
  const clientDir = join(root, 'dist/client');
  if (existsSync(join(clientDir, 'index.html'))) {
    app.use(express.static(clientDir));
    app.get('/{*path}', (_req, res) =>
      res.sendFile(join(clientDir, 'index.html')),
    );
  } else {
    app.get('/', (_req, res) =>
      res
        .type('text')
        .send(
          'Agent Rehearsal API is running. Start npm run dev and open http://localhost:5173, or run npm run build then npm start.',
        ),
    );
  }
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Invalid request.',
        details: error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        ),
      });
    }
    if (error instanceof SyntaxError && 'body' in error)
      return res.status(400).json({ error: 'Invalid JSON.' });
    if (error?.type === 'entity.too.large')
      return res.status(413).json({ error: 'Request body is too large.' });
    const message =
      error instanceof Error ? error.message : 'Unexpected server error.';
    if (/not found|unknown run/i.test(message))
      return res.status(404).json({ error: message });
    if (/completed|finished/i.test(message))
      return res.status(409).json({ error: message });
    console.error(message);
    return res.status(500).json({ error: 'Unexpected server error.' });
  };
  app.use(handleError);
  return app;
}
