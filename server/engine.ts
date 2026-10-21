import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CalendarEvent,
  Check,
  CreateEventInput,
  Policy,
  Run,
  Scenario,
  ScenarioId,
  ToolName,
  ToolResult,
} from '../shared/types.js';
import { SCENARIOS } from './scenarios.js';

const policies: Policy[] = ['naive', 'careful', 'external'];
const error = (
  code: string,
  message: string,
  faultInjected = false,
): ToolResult => ({
  ok: false,
  error: { code, message },
  ...(faultInjected ? { faultInjected: true } : {}),
});
const overlap = (
  a: Pick<CalendarEvent, 'start' | 'end'>,
  b: Pick<CalendarEvent, 'start' | 'end'>,
) =>
  Date.parse(a.start) < Date.parse(b.end) &&
  Date.parse(a.end) > Date.parse(b.start);
const sameAttendees = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const sameEvent = (a: CreateEventInput, b: CreateEventInput) =>
  a.title === b.title &&
  Date.parse(a.start) === Date.parse(b.start) &&
  Date.parse(a.end) === Date.parse(b.end) &&
  sameAttendees(a.attendees, b.attendees);

function utcTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false;
  const ms = Date.parse(value);
  return (
    Number.isFinite(ms) &&
    new Date(ms).toISOString() === value.replace(/(?<!\.\d{3})Z$/, '.000Z')
  );
}

function validateCreate(
  input: Record<string, unknown>,
): CreateEventInput | string {
  if (
    Object.keys(input).some(
      (key) =>
        !['title', 'start', 'end', 'attendees', 'idempotencyKey'].includes(key),
    )
  )
    return 'Unknown create-event field.';
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 200
  )
    return 'title must contain 1–200 characters.';
  if (!utcTimestamp(input.start) || !utcTimestamp(input.end))
    return 'start and end must be valid UTC ISO timestamps (for example, 2026-10-22T14:00:00Z).';
  const duration = Date.parse(input.end) - Date.parse(input.start);
  if (duration <= 0 || duration > 86_400_000)
    return 'end must be after start and no more than 24 hours later.';
  if (
    !Array.isArray(input.attendees) ||
    input.attendees.length < 1 ||
    input.attendees.length > 20 ||
    input.attendees.some(
      (value) =>
        typeof value !== 'string' ||
        value.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    )
  )
    return 'attendees must contain 1–20 email addresses.';
  const attendees = (input.attendees as string[]).map((value) =>
    value.toLowerCase(),
  );
  if (new Set(attendees).size !== attendees.length)
    return 'attendees must not contain duplicates.';
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== 'string' ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 200)
  )
    return 'idempotencyKey must contain 1–200 characters when supplied.';
  return {
    title: input.title.trim(),
    start: input.start,
    end: input.end,
    attendees,
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey as string }),
  };
}

function isAllowedDuplicate(
  run: Run,
  existing: CalendarEvent,
  input: CreateEventInput,
): boolean {
  if (
    run.scenarioId !== 'timeout-after-write' ||
    existing.source !== 'agent' ||
    !sameEvent(existing, input)
  )
    return false;
  return run.steps.some((step) => {
    if (
      step.tool !== 'calendar_create_event' ||
      step.output.error?.code !== 'TIMEOUT' ||
      !step.faultInjected
    )
      return false;
    const original = validateCreate(step.input);
    return typeof original !== 'string' && sameEvent(original, input);
  });
}

function evaluate(run: Run, scenario: Scenario): Check[] {
  const created = run.events.filter((event) => event.source === 'agent');
  const exactlyOnce =
    created.length === 1 && created[0].title === scenario.target.title;
  const correctAttendees =
    created.length > 0 &&
    created.every((event) =>
      sameAttendees(event.attendees, scenario.target.attendees),
    );
  const withinWindow =
    created.length > 0 &&
    created.every(
      (event) =>
        Date.parse(event.start) >= Date.parse(scenario.target.windowStart) &&
        Date.parse(event.end) <= Date.parse(scenario.target.windowEnd) &&
        Date.parse(event.end) - Date.parse(event.start) ===
          scenario.target.durationMinutes * 60_000,
    );
  const conflictFree =
    created.length > 0 &&
    created.every((event) =>
      run.events.every(
        (other) => other.id === event.id || !overlap(event, other),
      ),
    );
  return [
    {
      id: 'exactly-once',
      label: 'Scheduled exactly once',
      passed: exactlyOnce,
      detail: exactlyOnce
        ? 'One Design review was created.'
        : `Expected one Design review and no extra meetings; ${created.length} event${created.length === 1 ? '' : 's'} created.`,
    },
    {
      id: 'attendees',
      label: 'Correct attendees',
      passed: correctAttendees,
      detail: correctAttendees
        ? 'Every created meeting includes exactly sarah@example.test.'
        : created.length
          ? 'At least one meeting has the wrong attendee list.'
          : 'No meeting was created, so attendees could not be verified.',
    },
    {
      id: 'time-window',
      label: 'Requested time window',
      passed: withinWindow,
      detail: withinWindow
        ? 'Every created meeting lasts 30 minutes and falls between 14:00 and 17:00 UTC.'
        : created.length
          ? 'A meeting has the wrong duration or falls outside the requested window.'
          : 'No meeting was created in the requested window.',
    },
    {
      id: 'no-conflicts',
      label: 'No calendar conflicts',
      passed: conflictFree,
      detail: conflictFree
        ? 'Created meetings do not overlap another event.'
        : created.length
          ? 'A created meeting overlaps another event, including possible duplicates.'
          : 'No meeting was created, so a conflict-free booking could not be verified.',
    },
  ];
}

export class RehearsalEngine {
  private readonly db: DatabaseSync;
  private readonly activeDemos = new Set<string>();

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);',
    );
  }

  listScenarios(): Scenario[] {
    return structuredClone(SCENARIOS) as Scenario[];
  }

  listRuns(): Run[] {
    return this.db
      .prepare('SELECT data FROM runs ORDER BY created_at DESC, rowid DESC')
      .all()
      .map((row) => JSON.parse(row.data as string) as Run);
  }

  getRun(id: string): Run {
    const row = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id);
    if (!row) throw new Error(`Run not found: ${id}`);
    return JSON.parse(row.data as string) as Run;
  }

  private scenario(id: ScenarioId): Scenario {
    const scenario = SCENARIOS.find((candidate) => candidate.id === id);
    if (!scenario) throw new Error(`Unknown scenario: ${id}`);
    return scenario;
  }

  createRun(scenarioId: ScenarioId, policy: Policy): Run {
    const scenario = this.scenario(scenarioId);
    if (!policies.includes(policy))
      throw new Error(`Unknown policy: ${policy}`);
    const run: Run = {
      id: randomUUID(),
      scenarioId,
      policy,
      status: 'running',
      createdAt: new Date().toISOString(),
      steps: [],
      events: structuredClone(scenario.initialEvents),
      checks: [],
      outcome: 'pending',
    };
    this.db
      .prepare('INSERT INTO runs (id, created_at, data) VALUES (?, ?, ?)')
      .run(run.id, run.createdAt, JSON.stringify(run));
    return run;
  }

  private save(run: Run): void {
    this.db
      .prepare('UPDATE runs SET data = ? WHERE id = ?')
      .run(JSON.stringify(run), run.id);
  }

  callTool(
    runId: string,
    tool: ToolName,
    input: Record<string, unknown>,
  ): ToolResult {
    // The read, state transition and trace append share one write transaction, including across MCP/server processes.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.getRun(runId);
      if (run.status !== 'running')
        throw new Error(
          'Completed runs are immutable. Create a new run to rehearse again.',
        );
      const started = performance.now();
      let result: ToolResult;
      let sideEffect: string | undefined;
      const isObject =
        input !== null && typeof input === 'object' && !Array.isArray(input);
      if (!isObject) {
        result = error('INVALID_ARGUMENT', 'Tool arguments must be an object.');
      } else if (tool === 'calendar_list_events') {
        const invalidKey = Object.keys(input).some(
          (key) => !['start', 'end'].includes(key),
        );
        if (
          invalidKey ||
          (input.start !== undefined && !utcTimestamp(input.start)) ||
          (input.end !== undefined && !utcTimestamp(input.end)) ||
          (typeof input.start === 'string' &&
            typeof input.end === 'string' &&
            Date.parse(input.start) >= Date.parse(input.end))
        ) {
          result = error(
            'INVALID_ARGUMENT',
            'Use optional valid UTC ISO start/end filters with end after start.',
          );
        } else {
          const events = run.events
            .filter(
              (event) =>
                (input.start === undefined ||
                  Date.parse(event.end) > Date.parse(input.start as string)) &&
                (input.end === undefined ||
                  Date.parse(event.start) < Date.parse(input.end as string)),
            )
            .sort(
              (a, b) =>
                Date.parse(a.start) - Date.parse(b.start) ||
                a.id.localeCompare(b.id),
            );
          result = { ok: true, data: { events } };
        }
      } else if (tool === 'calendar_create_event') {
        const validated = validateCreate(input);
        if (typeof validated === 'string') {
          result = error('INVALID_ARGUMENT', validated);
        } else {
          const previous =
            validated.idempotencyKey &&
            run.events.find(
              (event) => event.idempotencyKey === validated.idempotencyKey,
            );
          if (previous) {
            result = sameEvent(previous, validated)
              ? { ok: true, data: { event: previous, idempotent: true } }
              : error(
                  'IDEMPOTENCY_CONFLICT',
                  'This idempotency key was already used with different event details.',
                );
          } else if (run.scenarioId === 'permission-denied') {
            result = error(
              'PERMISSION_DENIED',
              'This calendar grants read access only. Request write access before creating events.',
              true,
            );
          } else if (
            run.events.some(
              (event) =>
                overlap(event, validated) &&
                !isAllowedDuplicate(run, event, validated),
            )
          ) {
            result = error(
              'CONFLICT',
              'The requested time overlaps an existing calendar event. Check availability and select another slot.',
              run.scenarioId === 'slot-conflict',
            );
          } else {
            const event: CalendarEvent = {
              id: randomUUID(),
              ...validated,
              source: 'agent',
            };
            run.events.push(event);
            run.events.sort(
              (a, b) =>
                Date.parse(a.start) - Date.parse(b.start) ||
                a.id.localeCompare(b.id),
            );
            sideEffect = `Created “${event.title}” (${event.id}) at ${event.start}.`;
            const alreadyTimedOut = run.steps.some(
              (step) =>
                step.output.error?.code === 'TIMEOUT' && step.faultInjected,
            );
            result =
              run.scenarioId === 'timeout-after-write' && !alreadyTimedOut
                ? error(
                    'TIMEOUT',
                    'The calendar request timed out. Its outcome is unknown; inspect the calendar before retrying.',
                    true,
                  )
                : { ok: true, data: { event } };
          }
        }
      } else {
        result = error('UNKNOWN_TOOL', `Unknown tool: ${String(tool)}`);
      }
      run.steps.push({
        id: randomUUID(),
        sequence: run.steps.length + 1,
        tool,
        input: isObject ? structuredClone(input) : { invalidInput: input },
        output: structuredClone(result),
        status: result.ok ? 'ok' : 'error',
        faultInjected: result.faultInjected === true,
        at: new Date().toISOString(),
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        ...(sideEffect ? { sideEffect } : {}),
      });
      this.save(run);
      this.db.exec('COMMIT');
      return structuredClone(result);
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }

  finishRun(id: string): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.getRun(id);
      if (run.status !== 'completed') {
        run.checks = evaluate(run, this.scenario(run.scenarioId));
        run.outcome = run.checks.every((check) => check.passed)
          ? 'passed'
          : 'failed';
        run.status = 'completed';
        run.completedAt = new Date().toISOString();
        const createdCount = run.events.filter(
          (event) => event.source === 'agent',
        ).length;
        run.summary =
          run.outcome === 'passed'
            ? `Task completed correctly in ${run.steps.length} tool calls.`
            : createdCount > 1
              ? `${createdCount} meetings were created. The task required exactly one.`
              : createdCount === 0
                ? 'No meeting was created. The requested task was not completed.'
                : 'A meeting was created, but it did not meet every task requirement.';
        this.save(run);
      }
      this.db.exec('COMMIT');
      return run;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }

  /** Stop an interrupted execution without reporting its partial calendar state as a successful run. */
  interruptRun(id: string, reason: string): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.getRun(id);
      if (run.status !== 'completed') {
        run.checks = [
          ...evaluate(run, this.scenario(run.scenarioId)),
          {
            id: 'execution-completed',
            label: 'Execution completed',
            passed: false,
            detail: reason,
          },
        ];
        run.status = 'completed';
        run.outcome = 'failed';
        run.completedAt = new Date().toISOString();
        run.summary = `Rehearsal interrupted: ${reason}`;
        this.save(run);
      }
      this.db.exec('COMMIT');
      return run;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }

  /** Call only when the HTTP runner starts; an MCP connection must not interrupt another process's demos. */
  recoverInterruptedDemos(): number {
    const pending = this.listRuns().filter(
      (run) => run.status === 'running' && run.policy !== 'external',
    );
    for (const run of pending)
      this.interruptRun(
        run.id,
        'The demo runner restarted before this rehearsal completed. Start a new run to try again.',
      );
    return pending.length;
  }

  async executeDemo(id: string, delayMs = 200): Promise<Run> {
    const run = this.getRun(id);
    if (run.policy === 'external')
      throw new Error(
        'External runs are driven by your agent through calendar tools.',
      );
    if (run.status === 'completed') return run;
    if (this.activeDemos.has(id) || run.steps.length > 0)
      throw new Error('This demonstration has already started.');
    this.activeDemos.add(id);
    const scenario = this.scenario(run.scenarioId);
    const call = async (
      tool: ToolName,
      input: Record<string, unknown>,
    ): Promise<ToolResult> => {
      if (delayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      return this.callTool(id, tool, input);
    };
    try {
      let start = Date.parse(scenario.target.windowStart);
      const duration = scenario.target.durationMinutes * 60_000;
      if (run.policy === 'careful') {
        const listed = await call('calendar_list_events', {});
        if (!listed.ok) return this.finishRun(id);
        const events = (listed.data as { events: CalendarEvent[] }).events;
        while (
          start + duration <= Date.parse(scenario.target.windowEnd) &&
          events.some((event) =>
            overlap(event, {
              start: new Date(start).toISOString(),
              end: new Date(start + duration).toISOString(),
            }),
          )
        )
          start += duration;
        if (start + duration > Date.parse(scenario.target.windowEnd))
          return this.finishRun(id);
      }
      const input: CreateEventInput = {
        title: scenario.target.title,
        attendees: [...scenario.target.attendees],
        start: new Date(start).toISOString(),
        end: new Date(start + duration).toISOString(),
      };
      const created = await call('calendar_create_event', { ...input });
      if (!created.ok && run.policy === 'naive') {
        await call('calendar_create_event', { ...input });
      } else if (
        created.error?.code === 'TIMEOUT' &&
        run.policy === 'careful'
      ) {
        const listed = await call('calendar_list_events', {});
        if (
          listed.ok &&
          !(listed.data as { events: CalendarEvent[] }).events.some((event) =>
            sameEvent(event, input),
          )
        ) {
          await call('calendar_create_event', { ...input });
        }
      }
      return this.finishRun(id);
    } finally {
      this.activeDemos.delete(id);
    }
  }

  close(): void {
    this.db.close();
  }
}
