import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { RehearsalEngine } from '../server/engine.js';
import type { CalendarEvent } from '../shared/types.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rehearsal-mcp-'));
  const database = join(directory, 'state.sqlite');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const client = new Client({
    name: 'rehearsal-integration-test',
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(root, 'node_modules/tsx/dist/cli.mjs'),
      resolve(root, 'server/mcp.ts'),
    ],
    cwd: directory,
    env: { ...getDefaultEnvironment(), REHEARSAL_DB: database },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (data) => {
    stderr += data.toString();
  });
  t.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { result, body: JSON.parse(content[0].text) };
  };
  return { client, call, database, getStderr: () => stderr };
}

test('real stdio MCP session recovers a committed-but-unacknowledged write and shares SQLite state', async (t) => {
  const { client, call, database, getStderr } = await fixture(t);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 5);
  assert.ok(
    !tools.tools.some((tool) => tool.name === 'rehearsal_get_run'),
    'No hidden-state shortcut exposed',
  );
  const { body: started } = await call('rehearsal_start_run', {
    scenarioId: 'timeout-after-write',
  });
  assert.equal(started.date, '2026-10-22');
  assert.equal(started.events, undefined);
  const payload = {
    runId: started.runId,
    title: 'Design review',
    start: '2026-10-22T14:00:00Z',
    end: '2026-10-22T14:30:00Z',
    attendees: ['sarah@example.test'],
  };
  const failed = await call('calendar_create_event', payload);
  assert.equal(failed.result.isError, true);
  assert.equal(failed.body.error.code, 'TIMEOUT');
  assert.equal(failed.body.faultInjected, undefined);
  const { body: listed } = await call('calendar_list_events', {
    runId: started.runId,
  });
  assert.equal(
    listed.data.events.filter(
      (event: { source: string }) => event.source === 'agent',
    ).length,
    1,
  );
  const observer = new RehearsalEngine(database);
  assert.equal(observer.getRun(started.runId).steps.length, 2);
  const demoRun = observer.createRun('clean', 'naive');
  assert.equal(
    (await call('calendar_create_event', { ...payload, runId: demoRun.id }))
      .result.isError,
    true,
  );
  assert.equal(
    (await call('calendar_list_events', { runId: demoRun.id })).result.isError,
    true,
  );
  assert.equal(
    (await call('rehearsal_finish_run', { runId: demoRun.id })).result.isError,
    true,
  );
  assert.equal(
    observer.getRun(demoRun.id).steps.length,
    0,
    'An external agent cannot contaminate demo runs',
  );
  observer.close();
  const { body: finished } = await call('rehearsal_finish_run', {
    runId: started.runId,
  });
  assert.equal(finished.outcome, 'passed');
  assert.equal(
    (await call('calendar_create_event', payload)).result.isError,
    true,
  );
  assert.equal(
    (await call('rehearsal_finish_run', { runId: started.runId })).body.outcome,
    'passed',
  );
  assert.ok(!getStderr().includes('Unhandled'), getStderr());
});

test('real stdio MCP agent discovers a booking race and recovers by refreshing availability', async (t) => {
  const { call } = await fixture(t);
  const { body: scenarios } = await call('rehearsal_list_scenarios');
  assert.ok(
    scenarios.some((scenario: { id: string }) => scenario.id === 'slot-race'),
  );
  const { body: started } = await call('rehearsal_start_run', {
    scenarioId: 'slot-race',
  });
  assert.equal(typeof started.runId, 'string');
  assert.equal(started.events, undefined);
  const filters = {
    runId: started.runId,
    start: '2026-10-22T14:00:00Z',
    end: '2026-10-22T17:00:00Z',
  };
  const { body: before } = await call('calendar_list_events', filters);
  assert.deepEqual(before.data.events, []);
  const payload = {
    runId: started.runId,
    title: 'Design review',
    start: '2026-10-22T14:00:00Z',
    end: '2026-10-22T14:30:00Z',
    attendees: ['sarah@example.test'],
    idempotencyKey: 'review-booking',
  };
  const rejected = await call('calendar_create_event', payload);
  assert.equal(rejected.result.isError, true);
  assert.equal(rejected.body.error.code, 'CONFLICT');
  assert.equal(rejected.body.faultInjected, undefined);
  assert.equal(rejected.body.sideEffect, undefined);
  assert.equal(rejected.body.data, undefined);
  const { body: refreshed } = await call('calendar_list_events', filters);
  const events: CalendarEvent[] = refreshed.data.events;
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'concurrent');
  assert.equal(Date.parse(events[0].start), Date.parse(payload.start));
  assert.equal(events[0].idempotencyKey, undefined);
  const recovered = await call('calendar_create_event', {
    ...payload,
    start: '2026-10-22T14:30:00Z',
    end: '2026-10-22T15:00:00Z',
  });
  assert.equal(recovered.body.ok, true);
  const { body: finished } = await call('rehearsal_finish_run', {
    runId: started.runId,
  });
  assert.equal(finished.outcome, 'passed');
  assert.equal(
    finished.events.filter((event: CalendarEvent) => event.source === 'agent')
      .length,
    1,
  );
});
