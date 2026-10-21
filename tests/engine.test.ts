import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RehearsalEngine } from '../server/engine.js';
import type { CalendarEvent, Policy, ScenarioId } from '../shared/types.js';

const meeting = {
  title: 'Design review',
  start: '2026-10-22T14:00:00Z',
  end: '2026-10-22T14:30:00Z',
  attendees: ['sarah@example.test'],
};

function engineFor(t: TestContext): RehearsalEngine {
  const engine = new RehearsalEngine(':memory:');
  t.after(() => engine.close());
  return engine;
}

test('healthy calendar lets both demo policies satisfy the task', async (t) => {
  const engine = engineFor(t);
  for (const policy of ['naive', 'careful'] as const) {
    const run = await engine.executeDemo(
      engine.createRun('clean', policy).id,
      0,
    );
    assert.equal(run.outcome, 'passed');
    assert.ok(run.checks.every((check) => check.passed));
    assert.equal(
      run.events.filter((event) => event.source === 'agent').length,
      1,
    );
    assert.equal(run.steps.length, policy === 'naive' ? 1 : 2);
  }
});

test('timeout commits a write but does not reveal its success to the agent', (t) => {
  const engine = engineFor(t);
  const run = engine.createRun('timeout-after-write', 'external');
  const result = engine.callTool(run.id, 'calendar_create_event', meeting);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'TIMEOUT');
  assert.equal(result.data, undefined);
  assert.match(result.error!.message, /outcome is unknown/);
  const recorded = engine.getRun(run.id);
  assert.equal(
    recorded.events.filter((event) => event.source === 'agent').length,
    1,
  );
  assert.equal(recorded.steps[0].faultInjected, true);
  assert.match(recorded.steps[0].sideEffect!, /Created/);
});

test('blind retry duplicates a committed write and fails outcome assertions', async (t) => {
  const engine = engineFor(t);
  const run = await engine.executeDemo(
    engine.createRun('timeout-after-write', 'naive').id,
    0,
  );
  assert.equal(run.outcome, 'failed');
  assert.equal(
    run.events.filter((event) => event.source === 'agent').length,
    2,
  );
  assert.deepEqual(
    run.steps.map((step) => step.status),
    ['error', 'ok'],
  );
  assert.equal(
    run.checks.find((check) => check.id === 'exactly-once')?.passed,
    false,
  );
  assert.equal(
    run.checks.find((check) => check.id === 'no-conflicts')?.passed,
    false,
  );
});

test('verify-before-retry reconciles the committed meeting through read tools', async (t) => {
  const engine = engineFor(t);
  const run = await engine.executeDemo(
    engine.createRun('timeout-after-write', 'careful').id,
    0,
  );
  assert.equal(run.outcome, 'passed');
  assert.equal(
    run.events.filter((event) => event.source === 'agent').length,
    1,
  );
  assert.deepEqual(
    run.steps.map((step) => step.tool),
    ['calendar_list_events', 'calendar_create_event', 'calendar_list_events'],
  );
  assert.equal(run.steps[1].output.error?.code, 'TIMEOUT');
  assert.ok(run.checks.every((check) => check.passed));
});

test('careful policy finds a free slot while naive policy repeats a conflict', async (t) => {
  const engine = engineFor(t);
  const naive = await engine.executeDemo(
    engine.createRun('slot-conflict', 'naive').id,
    0,
  );
  const careful = await engine.executeDemo(
    engine.createRun('slot-conflict', 'careful').id,
    0,
  );
  assert.equal(naive.outcome, 'failed');
  assert.deepEqual(
    naive.steps.map((step) => step.output.error?.code),
    ['CONFLICT', 'CONFLICT'],
  );
  assert.equal(careful.outcome, 'passed');
  assert.equal(
    careful.events.find((event) => event.source === 'agent')?.start,
    '2026-10-22T14:30:00.000Z',
  );
});

test('permission denial produces no writes and never vacuously passes checks', async (t) => {
  const engine = engineFor(t);
  for (const policy of ['naive', 'careful'] as const) {
    const run = await engine.executeDemo(
      engine.createRun('permission-denied', policy).id,
      0,
    );
    assert.equal(run.outcome, 'failed');
    assert.ok(run.events.every((event) => event.source === 'seed'));
    assert.ok(run.checks.every((check) => !check.passed));
    assert.equal(
      run.steps.filter((step) => step.tool === 'calendar_create_event').length,
      policy === 'naive' ? 2 : 1,
    );
  }
});

test('idempotency safely retries a lost response and rejects key reuse with changed data', (t) => {
  const engine = engineFor(t);
  const run = engine.createRun('timeout-after-write', 'external');
  const input = { ...meeting, idempotencyKey: 'design-review-once' };
  assert.equal(
    engine.callTool(run.id, 'calendar_create_event', input).error?.code,
    'TIMEOUT',
  );
  const retried = engine.callTool(run.id, 'calendar_create_event', input);
  assert.equal(retried.ok, true);
  assert.equal((retried.data as { idempotent: boolean }).idempotent, true);
  assert.equal(
    engine.callTool(run.id, 'calendar_create_event', {
      ...input,
      title: 'Different event',
    }).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    engine.getRun(run.id).events.filter((event) => event.source === 'agent')
      .length,
    1,
  );
  assert.equal(engine.finishRun(run.id).outcome, 'passed');
});

test('invalid inputs leave calendar unchanged and do not consume the injected timeout', (t) => {
  const engine = engineFor(t);
  const run = engine.createRun('timeout-after-write', 'external');
  const invalid = [
    { ...meeting, start: 'tomorrow' },
    { ...meeting, start: '2026-02-30T14:00:00Z' },
    { ...meeting, end: meeting.start },
    { ...meeting, title: '   ' },
    { ...meeting, attendees: [] },
    { ...meeting, attendees: ['sarah@example.test', 'SARAH@example.test'] },
    { ...meeting, attendees: ['not-an-email'] },
    { ...meeting, idempotencyKey: '' },
    { ...meeting, unknown: true },
  ];
  for (const input of invalid)
    assert.equal(
      engine.callTool(run.id, 'calendar_create_event', input).error?.code,
      'INVALID_ARGUMENT',
    );
  assert.equal(engine.getRun(run.id).events.length, 1);
  assert.equal(
    engine.callTool(run.id, 'calendar_create_event', meeting).error?.code,
    'TIMEOUT',
  );
});

test('list filters use event overlap and reject invalid boundaries', (t) => {
  const engine = engineFor(t);
  const run = engine.createRun('clean', 'external');
  engine.callTool(run.id, 'calendar_create_event', meeting);
  const result = engine.callTool(run.id, 'calendar_list_events', {
    start: '2026-10-22T13:00:00Z',
    end: '2026-10-22T15:00:00Z',
  });
  assert.equal((result.data as { events: CalendarEvent[] }).events.length, 1);
  assert.equal(
    engine.callTool(run.id, 'calendar_list_events', { start: 'invalid' }).error
      ?.code,
    'INVALID_ARGUMENT',
  );
  assert.equal(
    engine.callTool(run.id, 'calendar_list_events', {
      start: meeting.end,
      end: meeting.start,
    }).error?.code,
    'INVALID_ARGUMENT',
  );
  const boundary = engine.callTool(run.id, 'calendar_list_events', {
    start: meeting.end,
  });
  assert.equal((boundary.data as { events: CalendarEvent[] }).events.length, 0);
});

test('wrong attendees, wrong duration and out-of-window bookings are evaluated from actual state', (t) => {
  const engine = engineFor(t);
  const cases = [
    {
      input: { ...meeting, attendees: ['other@example.test'] },
      failed: 'attendees',
    },
    {
      input: { ...meeting, end: '2026-10-22T15:00:00Z' },
      failed: 'time-window',
    },
    {
      input: {
        ...meeting,
        start: '2026-10-22T09:00:00Z',
        end: '2026-10-22T09:30:00Z',
      },
      failed: 'time-window',
    },
    { input: { ...meeting, title: 'Wrong title' }, failed: 'exactly-once' },
  ];
  for (const { input, failed } of cases) {
    const run = engine.createRun('clean', 'external');
    assert.equal(
      engine.callTool(run.id, 'calendar_create_event', input).ok,
      true,
    );
    const finished = engine.finishRun(run.id);
    assert.equal(finished.outcome, 'failed');
    assert.equal(
      finished.checks.find((check) => check.id === failed)?.passed,
      false,
    );
  }
});

test('runs and scenario fixtures are isolated, including injected fault state', (t) => {
  const engine = engineFor(t);
  const first = engine.createRun('timeout-after-write', 'external');
  const second = engine.createRun('timeout-after-write', 'external');
  first.events[0].title = 'Caller mutation';
  const scenarios = engine.listScenarios();
  scenarios[0].initialEvents.length = 0;
  assert.equal(
    engine.callTool(first.id, 'calendar_create_event', meeting).error?.code,
    'TIMEOUT',
  );
  assert.equal(engine.getRun(second.id).events.length, 1);
  assert.equal(engine.getRun(first.id).events[0].title, 'Team standup');
  assert.equal(
    engine.callTool(second.id, 'calendar_create_event', meeting).error?.code,
    'TIMEOUT',
  );
  assert.equal(engine.createRun('clean', 'external').events.length, 1);
});

test('completed runs are immutable and repeated finish is idempotent', (t) => {
  const engine = engineFor(t);
  const run = engine.createRun('clean', 'external');
  engine.callTool(run.id, 'calendar_create_event', meeting);
  const completed = engine.finishRun(run.id);
  assert.throws(
    () => engine.callTool(run.id, 'calendar_create_event', meeting),
    /immutable/,
  );
  assert.throws(
    () => engine.callTool(run.id, 'calendar_list_events', {}),
    /immutable/,
  );
  assert.deepEqual(engine.finishRun(run.id), completed);
});

test('persistent state and traces are shared by independent engine connections', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-rehearsal-engine-'));
  const path = join(directory, 'runs.sqlite');
  let first = new RehearsalEngine(path);
  const second = new RehearsalEngine(path);
  try {
    const run = first.createRun('timeout-after-write', 'external');
    assert.equal(second.getRun(run.id).policy, 'external');
    assert.equal(
      second.callTool(run.id, 'calendar_create_event', meeting).error?.code,
      'TIMEOUT',
    );
    assert.equal(first.getRun(run.id).steps.length, 1);
    first.close();
    first = new RehearsalEngine(path);
    assert.equal(first.getRun(run.id).events.length, 2);
    assert.equal(
      first.callTool(run.id, 'calendar_create_event', meeting).ok,
      true,
    );
    const complete = second.finishRun(run.id);
    assert.equal(complete.outcome, 'failed');
    assert.deepEqual(first.getRun(run.id), complete);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown identifiers are rejected and a missing run does not poison transactions', (t) => {
  const engine = engineFor(t);
  assert.throws(
    () => engine.createRun('no-scenario' as ScenarioId, 'external'),
    /Unknown scenario/,
  );
  assert.throws(
    () => engine.createRun('clean', 'no-policy' as Policy),
    /Unknown policy/,
  );
  assert.throws(() => engine.getRun('missing'), /not found/);
  assert.throws(
    () => engine.callTool('missing', 'calendar_list_events', {}),
    /not found/,
  );
  const run = engine.createRun('clean', 'external');
  assert.equal(engine.callTool(run.id, 'calendar_list_events', {}).ok, true);
});

test('external runs cannot invoke scripted demos and a demo cannot start twice', async (t) => {
  const engine = engineFor(t);
  await assert.rejects(
    engine.executeDemo(engine.createRun('clean', 'external').id, 0),
    /External runs/,
  );
  const run = engine.createRun('clean', 'careful');
  const running = engine.executeDemo(run.id, 10);
  await assert.rejects(engine.executeDemo(run.id, 0), /already started/);
  assert.equal((await running).outcome, 'passed');
});

test('timeout fault permits only repetition of the committed write, not unrelated overlaps', (t) => {
  const engine = engineFor(t);
  const run = engine.createRun('timeout-after-write', 'external');
  const seedCollision = {
    ...meeting,
    start: '2026-10-22T11:00:00Z',
    end: '2026-10-22T11:30:00Z',
  };
  assert.equal(
    engine.callTool(run.id, 'calendar_create_event', seedCollision).error?.code,
    'CONFLICT',
  );
  assert.equal(
    engine.callTool(run.id, 'calendar_create_event', meeting).error?.code,
    'TIMEOUT',
  );
  assert.equal(
    engine.callTool(run.id, 'calendar_create_event', {
      ...meeting,
      title: 'Unrelated meeting',
    }).error?.code,
    'CONFLICT',
  );
  assert.equal(
    engine.callTool(run.id, 'calendar_create_event', {
      ...meeting,
      attendees: ['other@example.test'],
    }).error?.code,
    'CONFLICT',
  );
  assert.equal(
    engine.callTool(run.id, 'calendar_create_event', meeting).ok,
    true,
  );
  assert.equal(
    engine.getRun(run.id).events.filter((event) => event.source === 'agent')
      .length,
    2,
  );
});

test('interrupted execution cannot pass even when its partial state happens to satisfy the task', (t) => {
  const engine = engineFor(t);
  const run = engine.createRun('clean', 'careful');
  engine.callTool(run.id, 'calendar_create_event', meeting);
  const interrupted = engine.interruptRun(
    run.id,
    'The demo runner stopped unexpectedly.',
  );
  assert.equal(interrupted.status, 'completed');
  assert.equal(interrupted.outcome, 'failed');
  assert.ok(interrupted.checks.slice(0, 4).every((check) => check.passed));
  assert.equal(
    interrupted.checks.find((check) => check.id === 'execution-completed')
      ?.passed,
    false,
  );
  assert.match(interrupted.summary!, /runner stopped unexpectedly/);
  assert.deepEqual(
    engine.interruptRun(run.id, 'Different reason'),
    interrupted,
  );
  assert.deepEqual(engine.finishRun(run.id), interrupted);
  assert.throws(
    () => engine.callTool(run.id, 'calendar_list_events', {}),
    /immutable/,
  );
});

test('explicit startup recovery closes only unfinished demo runs and preserves external sessions', (t) => {
  const engine = engineFor(t);
  const pendingNaive = engine.createRun('timeout-after-write', 'naive');
  const pendingCareful = engine.createRun('clean', 'careful');
  const external = engine.createRun('clean', 'external');
  const finished = engine.createRun('clean', 'careful');
  engine.callTool(finished.id, 'calendar_create_event', meeting);
  const finishedResult = engine.finishRun(finished.id);
  engine.callTool(pendingNaive.id, 'calendar_create_event', meeting);
  assert.equal(engine.recoverInterruptedDemos(), 2);
  assert.equal(engine.getRun(pendingNaive.id).outcome, 'failed');
  assert.equal(engine.getRun(pendingCareful.id).outcome, 'failed');
  assert.equal(engine.getRun(external.id).status, 'running');
  assert.deepEqual(engine.getRun(finished.id), finishedResult);
  assert.equal(engine.recoverInterruptedDemos(), 0);
});

test('opening another database connection never implicitly interrupts a demo', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-rehearsal-recovery-'));
  const path = join(directory, 'runs.sqlite');
  const runner = new RehearsalEngine(path);
  const demo = runner.createRun('clean', 'careful');
  const mcp = new RehearsalEngine(path);
  try {
    assert.equal(mcp.getRun(demo.id).status, 'running');
    assert.equal(runner.getRun(demo.id).status, 'running');
  } finally {
    mcp.close();
    runner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
