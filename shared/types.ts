export const SCENARIO_IDS = [
  'clean',
  'timeout-after-write',
  'permission-denied',
  'slot-conflict',
  'slot-race',
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];
export type Policy = 'naive' | 'careful' | 'external';
export type ToolName = 'calendar_list_events' | 'calendar_create_event';

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  source: 'seed' | 'agent' | 'concurrent';
  idempotencyKey?: string;
}

export interface Scenario {
  id: ScenarioId;
  name: string;
  description: string;
  faultLabel: string;
  faultDescription: string;
  task: string;
  date: string;
  timezone: 'UTC';
  target: {
    title: string;
    attendees: string[];
    windowStart: string;
    windowEnd: string;
    durationMinutes: number;
  };
  initialEvents: CalendarEvent[];
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  faultInjected?: boolean;
}

export interface RunStep {
  id: string;
  sequence: number;
  tool: ToolName;
  input: Record<string, unknown>;
  output: ToolResult;
  status: 'ok' | 'error';
  faultInjected: boolean;
  at: string;
  durationMs: number;
  sideEffect?: string;
}

export interface Check {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface Run {
  id: string;
  scenarioId: ScenarioId;
  policy: Policy;
  status: 'running' | 'completed';
  createdAt: string;
  completedAt?: string;
  steps: RunStep[];
  events: CalendarEvent[];
  checks: Check[];
  outcome: 'pending' | 'passed' | 'failed';
  summary?: string;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  idempotencyKey?: string;
}
