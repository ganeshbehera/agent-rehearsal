// An executable MCP client example, not an LLM agent. Run after npm run build.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'rehearsal-example', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/server/mcp.js', import.meta.url))],
  env: {
    ...getDefaultEnvironment(),
    ...(process.env.REHEARSAL_DB
      ? { REHEARSAL_DB: process.env.REHEARSAL_DB }
      : {}),
  },
});
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content.find((item) => item.type === 'text');
  if (!text) throw new Error('MCP response did not contain JSON text.');
  return JSON.parse(text.text);
}
try {
  await client.connect(transport);
  const { runId, task } = await call('rehearsal_start_run', {
    scenarioId: 'timeout-after-write',
  });
  console.log(task);
  const result = await call('calendar_create_event', {
    runId,
    title: 'Design review',
    start: '2026-10-22T14:00:00Z',
    end: '2026-10-22T14:30:00Z',
    attendees: ['sarah@example.test'],
  });
  if (!result.ok) {
    console.log('The response failed. Reading the calendar before retrying...');
    const { data } = await call('calendar_list_events', { runId });
    console.log(
      `Calendar contains ${data.events.filter((event) => event.source === 'agent').length} new event(s).`,
    );
  }
  const report = await call('rehearsal_finish_run', { runId });
  console.log(
    JSON.stringify(
      { runId, outcome: report.outcome, checks: report.checks },
      null,
      2,
    ),
  );
  if (report.outcome !== 'passed') process.exitCode = 1;
} finally {
  await client.close();
}
