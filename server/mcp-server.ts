import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RehearsalEngine } from './engine.js';
import type { ToolResult } from '../shared/types.js';

const runId = z
  .string()
  .min(1)
  .max(100)
  .describe('The isolated run ID returned by rehearsal_start_run.');
const utcTimestamp = z
  .string()
  .datetime()
  .describe(
    'An ISO-8601 UTC timestamp ending in Z. The fixture date is 2026-10-22.',
  );

function jsonResult(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    isError,
  };
}
function protect(action: () => unknown) {
  try {
    return jsonResult(action());
  } catch (error) {
    return jsonResult(
      {
        error: error instanceof Error ? error.message : 'The operation failed.',
      },
      true,
    );
  }
}
function toolResult(action: () => ToolResult) {
  try {
    const { faultInjected: _private, ...result } = action();
    return jsonResult(result, !result.ok);
  } catch (error) {
    return jsonResult(
      {
        error: error instanceof Error ? error.message : 'The operation failed.',
      },
      true,
    );
  }
}

export function createMcpServer(engine: RehearsalEngine) {
  const externalTool = (
    id: string,
    name: 'calendar_list_events' | 'calendar_create_event',
    input: Record<string, unknown>,
  ) => {
    if (engine.getRun(id).policy !== 'external')
      throw new Error(
        'MCP calendar tools can only access external-agent runs. Start one with rehearsal_start_run.',
      );
    return engine.callTool(id, name, input);
  };
  const server = new McpServer(
    { name: 'agent-rehearsal', version: '0.1.0' },
    {
      instructions:
        'This is an isolated, simulated calendar. Start a run, use its runId for calendar tools, and finish the run to evaluate your outcome. Dates are fixed fixtures in UTC. Completing a run is terminal. No real messages or calendar events are created.',
    },
  );
  server.registerTool(
    'rehearsal_list_scenarios',
    {
      description:
        'List available simulated calendar tasks and failure presets.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      protect(() =>
        engine.listScenarios().map(({ id, name, description, faultLabel }) => ({
          id,
          name,
          description,
          faultLabel,
        })),
      ),
  );
  server.registerTool(
    'rehearsal_start_run',
    {
      description:
        'Start an isolated calendar rehearsal. Returns the task and runId. The task uses a fixed date, not the real current day.',
      inputSchema: {
        scenarioId: z.enum([
          'clean',
          'timeout-after-write',
          'permission-denied',
          'slot-conflict',
        ]),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ scenarioId }) =>
      protect(() => {
        const run = engine.createRun(scenarioId, 'external');
        const scenario = engine
          .listScenarios()
          .find((s) => s.id === scenarioId)!;
        return {
          runId: run.id,
          task: scenario.task,
          date: scenario.date,
          timezone: scenario.timezone,
        };
      }),
  );
  server.registerTool(
    'calendar_list_events',
    {
      description:
        'Read events in this simulated calendar. Optional start/end filters select overlapping events. Use after an ambiguous write failure to check the calendar before retrying.',
      inputSchema: {
        runId,
        start: utcTimestamp.optional(),
        end: utcTimestamp.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ runId: id, ...input }) =>
      toolResult(() => externalTool(id, 'calendar_list_events', input)),
  );
  server.registerTool(
    'calendar_create_event',
    {
      description:
        'Create one event in the simulated calendar. A failed response does not guarantee that no event was created. Reusing an idempotencyKey with identical fields avoids duplicate writes; changing its payload is an error.',
      inputSchema: {
        runId,
        title: z.string().min(1).max(200),
        start: utcTimestamp,
        end: utcTimestamp,
        attendees: z.array(z.string().email()).min(1).max(20),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ runId: id, ...input }) =>
      toolResult(() => externalTool(id, 'calendar_create_event', input)),
  );
  server.registerTool(
    'rehearsal_finish_run',
    {
      description:
        'Finish this run and evaluate the actual calendar state. Returns checks and a developer trace. This is terminal: no further calendar calls are allowed.',
      inputSchema: { runId },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ runId: id }) =>
      protect(() => {
        const run = engine.getRun(id);
        if (run.policy !== 'external')
          throw new Error('Only external runs can be finished through MCP.');
        return engine.finishRun(id);
      }),
  );
  return server;
}
