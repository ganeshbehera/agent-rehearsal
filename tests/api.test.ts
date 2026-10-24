import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { RehearsalEngine } from '../server/engine.js';
import { createApp } from '../server/app.js';
import { SCENARIO_IDS, type Run, type Scenario } from '../shared/types.js';

async function fixture(t: TestContext) {
  const engine = new RehearsalEngine(':memory:');
  const app = createApp(engine, { demoDelayMs: 0, dbPath: ':memory:' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test address');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await Promise.allSettled(app.locals.tasks);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    engine.close();
  });
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const done = async (id: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const run: Run = await (await fetch(`${base}/api/runs/${id}`)).json();
      if (run.status === 'completed') return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Run did not finish');
  };
  return { base, post, done, engine };
}

test('HTTP comparison persists separate runs and evaluates the real write results', async (t) => {
  const { base, post, done } = await fixture(t);
  const scenarios: Scenario[] = await (
    await fetch(base + '/api/scenarios')
  ).json();
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    [...SCENARIO_IDS],
  );
  const response = await post('/api/compare', {
    scenarioId: 'timeout-after-write',
  });
  assert.equal(response.status, 201);
  const comparison = await response.json();
  const [naive, careful] = await Promise.all([
    done(comparison.naive.id),
    done(comparison.careful.id),
  ]);
  assert.equal(naive.outcome, 'failed');
  assert.equal(careful.outcome, 'passed');
  assert.equal(
    naive.events.filter((event) => event.source === 'agent').length,
    2,
  );
  assert.equal(
    careful.events.filter((event) => event.source === 'agent').length,
    1,
  );
  const history = await (await fetch(base + '/api/runs')).json();
  assert.equal(history.length, 2);
});

test('HTTP booking-race comparison exposes the competing booking and recovered outcome', async (t) => {
  const { post, done } = await fixture(t);
  const response = await post('/api/compare', { scenarioId: 'slot-race' });
  assert.equal(response.status, 201);
  const comparison = await response.json();
  const [naive, careful] = await Promise.all([
    done(comparison.naive.id),
    done(comparison.careful.id),
  ]);
  assert.equal(naive.outcome, 'failed');
  assert.equal(careful.outcome, 'passed');
  assert.equal(
    naive.events.filter((event) => event.source === 'agent').length,
    0,
  );
  for (const run of [naive, careful]) {
    assert.equal(
      run.events.filter((event) => event.source === 'concurrent').length,
      1,
    );
    const injected = run.steps.filter((step) => step.faultInjected);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].output.error?.code, 'CONFLICT');
    assert.match(injected[0].sideEffect ?? '', /booking/i);
  }
  assert.equal(
    careful.events.find((event) => event.source === 'agent')?.start,
    '2026-10-22T14:30:00.000Z',
  );
});

test('HTTP rejects invalid inputs, unknown routes, and unknown runs', async (t) => {
  const { base, post } = await fixture(t);
  assert.equal(
    (await post('/api/runs', { scenarioId: 'unknown', policy: 'careful' }))
      .status,
    400,
  );
  assert.equal(
    (await post('/api/compare', { scenarioId: 'clean', unexpected: true }))
      .status,
    400,
  );
  assert.equal((await fetch(base + '/api/runs/missing')).status, 404);
  assert.equal((await fetch(base + '/api/no-such-route')).status, 404);
  assert.equal(
    (
      await fetch(base + '/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      })
    ).status,
    400,
  );
});

test('HTTP blocks external origins and DNS rebinding hostnames', async (t) => {
  const { base } = await fixture(t);
  assert.equal(
    (
      await fetch(base + '/api/runs', {
        headers: { Origin: 'https://example.com' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(base + '/api/runs', { headers: { Origin: 'null' } })).status,
    403,
  );
  // fetch normalizes Host; use a raw HTTP request to exercise DNS rebinding protection.
  const hostileHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      get(
        base + '/api/runs',
        { headers: { Host: 'attacker.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on('error', reject);
    },
  );
  assert.equal(hostileHostStatus, 403);
  const response = await fetch(base + '/api/runs');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('external HTTP runs remain open until explicitly evaluated', async (t) => {
  const { base, post } = await fixture(t);
  const run = await (
    await post('/api/runs', { scenarioId: 'clean', policy: 'external' })
  ).json();
  assert.equal(run.status, 'running');
  const result = await (await post(`/api/runs/${run.id}/finish`, {})).json();
  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, 'failed');
  const connection = await (await fetch(base + '/api/connection')).json();
  assert.ok(connection.args[0].endsWith('/dist/server/mcp.js'));
  assert.equal(connection.dbPath, ':memory:');
});

test('an unexpected demo failure leaves a terminal report instead of a permanently running run', async (t) => {
  const { post, done, engine } = await fixture(t);
  engine.executeDemo = async () => {
    throw new Error('Injected runner failure for regression test');
  };
  const run = await (
    await post('/api/runs', { scenarioId: 'clean', policy: 'careful' })
  ).json();
  const report = await done(run.id);
  assert.equal(report.outcome, 'failed');
  assert.equal(
    report.checks.find((check) => check.id === 'execution-completed')?.passed,
    false,
  );
  assert.match(report.summary ?? '', /interrupted/i);
});
