import test from 'node:test';
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

test('real stdio MCP session recovers a committed-but-unacknowledged write and shares SQLite state', async (t) => {
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
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 5);
  assert.ok(
    !tools.tools.some((tool) => tool.name === 'rehearsal_get_run'),
    'No hidden-state shortcut exposed',
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { result, body: JSON.parse(content[0].text) };
  };
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
  assert.ok(!stderr.includes('Unhandled'), stderr);
});
