import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Braces,
  CalendarClock,
  CalendarDays,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Copy,
  FlaskConical,
  GitCompareArrows,
  History,
  Layers3,
  Play,
  Plug,
  Radio,
  ShieldCheck,
  Terminal,
  Unplug,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type {
  CalendarEvent,
  Policy,
  Run,
  Scenario,
  ScenarioId,
} from '../shared/types';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
type View = 'lab' | 'history' | 'connect';
interface Connection {
  command: string;
  args: string[];
  cwd: string;
  dbPath: string;
}
const policyNames: Record<Policy, string> = {
  naive: 'Blind retry',
  careful: 'Verify before retry',
  external: 'External agent',
};
const eventSourceNames: Record<CalendarEvent['source'], string> = {
  seed: 'Initial event',
  agent: 'Agent-created',
  concurrent: 'Concurrent booking',
};
const panel = 'rounded-xl border border-zinc-800 bg-zinc-900/40';
const secondaryButton =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-sm font-medium text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-40';
const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-lime-300 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-lime-200 disabled:opacity-40';
const time = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(value));
const dateTime = (value: string) =>
  new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof data?.error === 'string'
        ? data.error
        : data?.error?.message ||
            `Request failed (${response.status}). Please try again.`,
    );
  return data as T;
}
function Outcome({ run }: { run: Run }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
        run.outcome === 'passed'
          ? 'bg-lime-300/10 text-lime-300'
          : run.outcome === 'failed'
            ? 'bg-rose-400/10 text-rose-300'
            : 'bg-zinc-800 text-zinc-300',
      )}
    >
      {run.outcome === 'passed' ? (
        <CheckCircle2 size={12} />
      ) : run.outcome === 'failed' ? (
        <XCircle size={12} />
      ) : (
        <Clock3 size={12} />
      )}
      {run.outcome === 'passed'
        ? 'Passed'
        : run.outcome === 'failed'
          ? 'Goal not met'
          : 'In progress'}
    </span>
  );
}
function ErrorNotice({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-400/30 bg-rose-400/5 p-4 text-sm text-rose-200"
    >
      <div className="flex items-start gap-2">
        <XCircle className="mt-0.5 shrink-0" size={16} />
        <span>{children}</span>
      </div>
      {onRetry && (
        <button className="underline underline-offset-4" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
function Logo() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-lime-300 text-zinc-950">
        <FlaskConical size={21} strokeWidth={2} />
      </div>
      <div className="text-[15px] font-semibold leading-5">
        Agent
        <br />
        <span className="text-zinc-400">Rehearsal</span>
      </div>
    </div>
  );
}
export default function App() {
  const [view, setView] = useState<View>('lab');
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [scenarioId, setScenarioId] = useState<ScenarioId>(
    'timeout-after-write',
  );
  const [policy, setPolicy] = useState<Policy>('naive');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const selectedScenario = scenarios.find((s) => s.id === scenarioId);
  const selectedRun = runs.find((run) => run.id === activeId);
  const displayedScenario =
    scenarios.find((s) => s.id === selectedRun?.scenarioId) ?? selectedScenario;
  const comparisonRuns = compareIds
    .map((id) => runs.find((run) => run.id === id))
    .filter((run): run is Run => !!run);
  const running = runs.some((run) => run.status === 'running');
  const navItems = [
    { id: 'lab' as const, name: 'Rehearsal lab', Icon: FlaskConical },
    { id: 'history' as const, name: 'Run history', Icon: History },
    { id: 'connect' as const, name: 'Connect agent', Icon: Plug },
  ];
  async function load() {
    setLoading(true);
    setError('');
    try {
      const [nextScenarios, nextRuns] = await Promise.all([
        request<Scenario[]>('/api/scenarios'),
        request<Run[]>('/api/runs'),
      ]);
      setScenarios(nextScenarios);
      setRuns(nextRuns);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not connect to the local server.',
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (loading) return;
    let stopped = false;
    let fetching = false;
    const interval = window.setInterval(
      async () => {
        if (fetching) return;
        fetching = true;
        try {
          const next = await request<Run[]>('/api/runs');
          if (!stopped) {
            setRuns((previous) => [
              ...next,
              ...previous.filter(
                (run) => !next.some((incoming) => incoming.id === run.id),
              ),
            ]);
            setPollError('');
          }
        } catch {
          if (!stopped)
            setPollError(
              'Connection interrupted. Run updates will resume when the local server is available.',
            );
        } finally {
          fetching = false;
        }
      },
      running ? 500 : 2000,
    );
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [loading, running]);
  function mergeRuns(next: Run[]) {
    setRuns((previous) => [
      ...next,
      ...previous.filter((r) => !next.some((n) => n.id === r.id)),
    ]);
  }
  async function start(compare = false) {
    setBusy(true);
    setError('');
    setView('lab');
    try {
      if (compare) {
        const result = await request<{ naive: Run; careful: Run }>(
          '/api/compare',
          { scenarioId },
        );
        mergeRuns([result.naive, result.careful]);
        setCompareIds([result.naive.id, result.careful.id]);
        setActiveId(result.naive.id);
      } else {
        const run = await request<Run>('/api/runs', { scenarioId, policy });
        mergeRuns([run]);
        setActiveId(run.id);
        setCompareIds([]);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start this run.',
      );
    } finally {
      setBusy(false);
    }
  }
  function inspect(run: Run) {
    setActiveId(run.id);
    setScenarioId(run.scenarioId);
    setView('lab');
  }
  function exportRun(run: Run) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `rehearsal-${run.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-lime-300 focus:p-3 focus:text-zinc-950"
        href="#main"
      >
        Skip to content
      </a>
      <aside className="border-b border-zinc-800 bg-zinc-950 px-5 py-5 lg:fixed lg:inset-y-0 lg:left-0 lg:z-20 lg:flex lg:w-56 lg:flex-col lg:border-b-0 lg:border-r lg:px-6 lg:py-8">
        <Logo />
        <div className="mt-8 hidden font-mono text-[10px] text-zinc-400 lg:block">
          WORKSPACE
        </div>
        <nav
          aria-label="Main navigation"
          className="mt-5 flex flex-wrap gap-1 lg:mt-3 lg:flex-col"
        >
          {navItems.map(({ id, name, Icon }) => (
            <button
              key={id}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => setView(id)}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs font-medium sm:text-sm lg:w-full',
                view === id
                  ? 'bg-lime-300/10 text-lime-300'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100',
              )}
            >
              <Icon size={16} />
              {name}
              {id === 'history' && runs.length > 0 && (
                <span className="ml-auto hidden font-mono text-xs tabular-nums lg:inline">
                  {runs.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-auto hidden pt-10 lg:block">
          <div className="rounded-lg border border-zinc-800 p-4">
            <ShieldCheck size={19} className="mb-3 text-zinc-400" />
            <p className="text-xs font-medium text-zinc-300">
              Room to get it wrong.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">
              Every run gets an isolated calendar. No real accounts are
              connected.
            </p>
          </div>
          <div className="mt-5 flex items-center justify-between font-mono text-[10px] text-zinc-400">
            <span>OPEN SOURCE</span>
            <span>v0.1.0</span>
          </div>
        </div>
      </aside>
      <div className="lg:ml-56">
        <header className="flex min-h-16 items-center justify-between gap-3 border-b border-zinc-800 px-5 sm:px-8 lg:px-10">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Workspace</span>
            <ChevronRight size={12} />
            <span className="text-zinc-300">
              {navItems.find((i) => i.id === view)?.name}
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-zinc-800 px-2.5 py-1 font-mono text-[10px] text-zinc-400">
            <span
              className={cn(
                'size-1.5 rounded-full',
                pollError || (error && !scenarios.length)
                  ? 'bg-rose-400'
                  : 'bg-lime-300',
              )}
            />
            LOCAL SANDBOX
          </div>
        </header>
        <main
          id="main"
          className="mx-auto max-w-screen-2xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10"
        >
          <div role="status" aria-live="polite" className="sr-only">
            {selectedRun
              ? selectedRun.status === 'completed'
                ? `${policyNames[selectedRun.policy]} rehearsal completed. ${selectedRun.outcome === 'passed' ? 'All checks passed.' : 'The goal was not met.'}`
                : `${policyNames[selectedRun.policy]} rehearsal in progress.`
              : ''}
          </div>
          {view === 'lab' && (
            <>
              <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
                <div>
                  <div className="mb-3 flex items-center gap-2 font-mono text-[10px] text-lime-300">
                    <span className="h-px w-6 bg-lime-300" />
                    THE AGENT TESTING GROUND
                  </div>
                  <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">
                    Rehearse before reality
                    <span className="text-lime-300">.</span>
                  </h1>
                  <p className="mt-3 max-w-xl text-sm leading-relaxed text-zinc-400">
                    Give your agent a task. Break a tool. Find out what actually
                    happened.
                  </p>
                </div>
                <button
                  className={secondaryButton}
                  onClick={() => setView('connect')}
                >
                  <Plug size={15} />
                  Connect your agent
                  <ArrowUpRight size={14} className="ml-1 text-zinc-400" />
                </button>
              </div>
              {loading ? (
                <LoadingState />
              ) : (
                <>
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="flex items-center gap-2 text-sm font-medium">
                      <span className="font-mono text-xs text-zinc-400">
                        01
                      </span>{' '}
                      Choose a scenario
                    </h2>
                    <span className="font-mono text-[10px] text-zinc-400">
                      CALENDAR ENVIRONMENT
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    {scenarios.map((scenario, index) => (
                      <ScenarioCard
                        key={scenario.id}
                        scenario={scenario}
                        selected={scenario.id === scenarioId}
                        number={index + 1}
                        onSelect={() => {
                          setScenarioId(scenario.id);
                          setActiveId(null);
                          setCompareIds([]);
                          setError('');
                        }}
                      />
                    ))}
                  </div>
                  {selectedScenario && (
                    <div className={cn(panel, 'mb-7 mt-4 p-5')}>
                      <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-center">
                        <div className="max-w-lg">
                          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] text-zinc-400">
                            <Terminal size={12} />
                            TASK BRIEF
                          </div>
                          <p className="text-sm leading-relaxed text-zinc-200">
                            {selectedScenario.task}
                          </p>
                          <p className="mt-2 text-xs text-zinc-400">
                            Fixture: 22 Oct 2026 · UTC ·{' '}
                            {selectedScenario.target.durationMinutes} minute
                            meeting
                          </p>
                        </div>
                        <div className="flex flex-wrap items-end gap-2.5">
                          <label className="flex min-w-44 grow flex-col gap-1.5 text-[11px] text-zinc-400 xl:grow-0">
                            Demo policy
                            <select
                              aria-label="Demo policy"
                              value={policy}
                              onChange={(e) =>
                                setPolicy(e.target.value as Policy)
                              }
                              className="h-10 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-200"
                            >
                              <option value="naive">Blind retry</option>
                              <option value="careful">
                                Verify before retry
                              </option>
                            </select>
                          </label>
                          <button
                            className={primaryButton}
                            disabled={busy}
                            onClick={() => void start()}
                          >
                            <Play size={14} fill="currentColor" />
                            {busy ? 'Starting…' : 'Run rehearsal'}
                          </button>
                          <button
                            className={secondaryButton}
                            disabled={busy}
                            onClick={() => void start(true)}
                          >
                            <GitCompareArrows size={15} />
                            Compare
                          </button>
                        </div>
                      </div>
                      <div className="mt-4 flex items-start gap-1.5 border-t border-zinc-800 pt-3 text-[11px] leading-relaxed text-zinc-400">
                        <Code2 size={13} className="mt-0.5 shrink-0" />
                        <span>
                          Demo policies are scripted examples. Verify before
                          retry checks calendar state after a timeout and
                          replans when a slot is taken. Connect an external AI
                          agent through MCP to test its behavior.
                        </span>
                      </div>
                    </div>
                  )}
                  {error && (
                    <div className="mb-5">
                      <ErrorNotice
                        onRetry={
                          scenarios.length ? undefined : () => void load()
                        }
                      >
                        {error}
                      </ErrorNotice>
                    </div>
                  )}
                  {pollError && (
                    <div className="mb-5">
                      <ErrorNotice>{pollError}</ErrorNotice>
                    </div>
                  )}
                  {comparisonRuns.length > 0 && (
                    <div className="mb-7">
                      <div className="mb-3 flex items-center justify-between">
                        <h2 className="flex items-center gap-2 text-sm font-medium">
                          <GitCompareArrows
                            size={16}
                            className="text-lime-300"
                          />
                          Policy comparison
                        </h2>
                        <button
                          aria-label="Close comparison"
                          onClick={() => setCompareIds([])}
                          className="rounded p-1 text-zinc-400 hover:text-white"
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        {comparisonRuns.map((run) => (
                          <ComparisonCard
                            key={run.id}
                            run={run}
                            active={activeId === run.id}
                            onInspect={() => inspect(run)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="flex items-center gap-2 text-sm font-medium">
                      <span className="font-mono text-xs text-zinc-400">
                        02
                      </span>
                      {selectedRun
                        ? 'Inspect the outcome'
                        : 'Your rehearsal workspace'}
                    </h2>
                    {selectedRun ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="font-mono text-[10px] text-zinc-400">
                          {selectedRun.id.slice(0, 8)}
                        </span>
                        <Outcome run={selectedRun} />
                        <button
                          onClick={() => exportRun(selectedRun)}
                          className="flex items-center gap-1.5 rounded text-xs text-zinc-400 hover:text-zinc-100"
                        >
                          <ArrowDownToLine size={13} />
                          Export JSON
                        </button>
                      </div>
                    ) : (
                      <span className="font-mono text-[10px] text-zinc-400">
                        READY WHEN YOU ARE
                      </span>
                    )}
                  </div>
                  {selectedRun && (
                    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
                      <span>
                        {
                          scenarios.find((s) => s.id === selectedRun.scenarioId)
                            ?.name
                        }
                      </span>
                      <span>
                        Policy:{' '}
                        <span className="text-zinc-300">
                          {policyNames[selectedRun.policy]}
                        </span>
                      </span>
                      <span className="tabular-nums">
                        {selectedRun.steps.length} tool calls
                      </span>
                    </div>
                  )}
                  <div className="grid items-start gap-4 xl:grid-cols-5">
                    <div className="min-w-0 xl:col-span-3">
                      <Timeline
                        run={selectedRun}
                        onStart={() => void start()}
                        busy={busy || !selectedScenario}
                      />
                      {selectedRun && <Checks run={selectedRun} />}
                    </div>
                    <div className="min-w-0 xl:col-span-2">
                      <Calendar
                        events={
                          selectedRun?.events ??
                          displayedScenario?.initialEvents ??
                          []
                        }
                        hasRun={!!selectedRun}
                      />
                      <div className="mt-3 flex items-start gap-2 px-1 text-[11px] leading-relaxed text-zinc-400">
                        <Layers3 size={13} className="mt-0.5 shrink-0" />
                        Calendar state is the source of truth, even when a tool
                        reports an error.
                      </div>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
          {view === 'history' && (
            <>
              <PageHeading
                eyebrow="EVERY ATTEMPT, PRESERVED"
                title="Run history"
                description="Inspect previous runs and export the evidence. Each rehearsal starts with a fresh calendar."
              />
              {pollError && <ErrorNotice>{pollError}</ErrorNotice>}
              <HistoryView
                runs={runs}
                scenarios={scenarios}
                loading={loading}
                onInspect={(run) => {
                  setCompareIds([]);
                  inspect(run);
                }}
                onExport={exportRun}
                onStart={() => setView('lab')}
              />
            </>
          )}
          {view === 'connect' && (
            <>
              <PageHeading
                eyebrow="BRING YOUR OWN AGENT"
                title="One sandbox. Your agent."
                description="Expose the simulated calendar through MCP and watch your agent's tool calls appear in the lab."
              />
              <ConnectView />
            </>
          )}
          <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800/70 pt-5 font-mono text-[10px] text-zinc-400">
            <span>AGENT REHEARSAL / LOCAL-FIRST, OPEN SOURCE</span>
            <span>REAL OUTCOMES. SIMULATED WORLD.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-8">
      <div className="mb-3 font-mono text-[10px] text-lime-300">{eyebrow}</div>
      <h1 className="text-3xl font-semibold sm:text-4xl">{title}</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-zinc-400">
        {description}
      </p>
    </div>
  );
}
function LoadingState() {
  return (
    <div role="status" aria-label="Loading scenarios" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="h-40 rounded-xl border border-zinc-800 bg-zinc-900"
          />
        ))}
      </div>
      <div className="h-36 rounded-xl border border-zinc-800 bg-zinc-900" />
      <span className="text-sm text-zinc-400">
        Connecting to your local lab…
      </span>
    </div>
  );
}
function ScenarioCard({
  scenario,
  selected,
  number,
  onSelect,
}: {
  scenario: Scenario;
  selected: boolean;
  number: number;
  onSelect: () => void;
}) {
  const Icon =
    scenario.id === 'clean'
      ? CheckCheck
      : scenario.id === 'timeout-after-write'
        ? Zap
        : scenario.id === 'permission-denied'
          ? Unplug
          : scenario.id === 'slot-race'
            ? CalendarClock
            : CalendarDays;
  return (
    <button
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'group relative min-h-40 rounded-xl border p-4 text-left',
        selected
          ? 'border-lime-300/60 bg-lime-300/5'
          : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-600',
      )}
    >
      <div className="mb-5 flex items-center justify-between">
        <div
          className={cn(
            'flex size-8 items-center justify-center rounded-lg',
            selected
              ? 'bg-lime-300/10 text-lime-300'
              : 'bg-zinc-800 text-zinc-400',
          )}
        >
          <Icon size={16} />
        </div>
        <span
          className={cn(
            'flex size-4 items-center justify-center rounded-full border',
            selected
              ? 'border-lime-300 bg-lime-300 text-zinc-950'
              : 'border-zinc-700',
          )}
        >
          {selected && <Check size={10} strokeWidth={3} />}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-zinc-400">0{number}</span>
        <h3
          className={cn(
            'text-sm font-medium',
            selected ? 'text-lime-100' : 'text-zinc-200',
          )}
        >
          {scenario.name}
        </h3>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
        {scenario.description}
      </p>
    </button>
  );
}
function ComparisonCard({
  run,
  active,
  onInspect,
}: {
  run: Run;
  active: boolean;
  onInspect: () => void;
}) {
  const created = run.events.filter((event) => event.source === 'agent').length;
  return (
    <div className={cn(panel, 'p-5', active && 'border-zinc-600')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{policyNames[run.policy]}</h3>
        <Outcome run={run} />
      </div>
      <div className="my-5 grid grid-cols-3 gap-4">
        <Metric label="Tool calls" value={run.steps.length} />
        <Metric label="Events created" value={created} />
        <Metric
          label="Checks passed"
          value={
            run.status === 'running'
              ? '—'
              : `${run.checks.filter((c) => c.passed).length}/${run.checks.length}`
          }
        />
      </div>
      <p className="min-h-10 text-xs leading-relaxed text-zinc-400">
        {run.summary ||
          'Running against an isolated copy of the same scenario…'}
      </p>
      <button
        onClick={onInspect}
        className={cn(
          'mt-3 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-xs',
          active
            ? 'border-lime-300/25 bg-lime-300/5 text-lime-300'
            : 'border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200',
        )}
      >
        {active ? 'Inspecting this run' : 'Inspect run'}
        <ArrowRight size={13} />
      </button>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="font-mono text-xl font-medium tabular-nums text-zinc-100">
        {value}
      </div>
      <div className="mt-1 text-[10px] text-zinc-400">{label}</div>
    </div>
  );
}
function Timeline({
  run,
  onStart,
  busy,
}: {
  run?: Run;
  onStart: () => void;
  busy: boolean;
}) {
  return (
    <section
      className={cn(panel, 'overflow-hidden')}
      aria-label="Tool call timeline"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Activity size={15} className="text-zinc-400" />
          Execution trace
        </h3>
        <span className="font-mono text-[10px] text-zinc-400">
          {run ? `${run.steps.length} CALLS` : 'NO RUN SELECTED'}
        </span>
      </div>
      {!run ? (
        <div className="flex min-h-80 flex-col items-center justify-center px-6 py-10 text-center">
          <div className="mb-5 flex items-center gap-3 text-zinc-400">
            <div className="flex size-12 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900">
              <Terminal size={20} />
            </div>
            <span className="w-7 border-t border-dashed border-zinc-700" />
            <div className="flex size-12 items-center justify-center rounded-xl border border-lime-300/30 bg-lime-300/5 text-lime-300">
              <Zap size={20} />
            </div>
            <span className="w-7 border-t border-dashed border-zinc-700" />
            <div className="flex size-12 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900">
              <ShieldCheck size={20} />
            </div>
          </div>
          <h3 className="text-base font-medium">
            A successful call isn't the whole story.
          </h3>
          <p className="mt-2 max-w-sm text-xs leading-relaxed text-zinc-400">
            Start a rehearsal to see every tool call, injected failure, and
            resulting change in one place.
          </p>
          <button
            onClick={onStart}
            disabled={busy}
            className="mt-5 inline-flex items-center gap-2 rounded text-xs font-medium text-lime-300 hover:text-lime-200 disabled:opacity-40"
          >
            Run your first rehearsal
            <ArrowRight size={14} />
          </button>
        </div>
      ) : (
        <div className="p-5">
          {run.steps.length === 0 && (
            <div
              role="status"
              className="py-10 text-center text-sm text-zinc-400"
            >
              {run.policy === 'external'
                ? 'Waiting for your agent to call a calendar tool.'
                : 'Preparing the isolated calendar…'}
            </div>
          )}
          <ol className="space-y-0">
            {run.steps.map((step, index) => (
              <li key={step.id} className="relative flex gap-3 pb-5 last:pb-0">
                <div className="relative flex w-6 shrink-0 justify-center">
                  {index < run.steps.length - 1 && (
                    <span className="absolute top-6 bottom-0 w-px bg-zinc-800" />
                  )}
                  <span
                    className={cn(
                      'relative z-10 mt-0.5 flex size-5 items-center justify-center rounded-full',
                      step.status === 'error'
                        ? 'bg-rose-400/10 text-rose-300'
                        : 'bg-zinc-800 text-zinc-400',
                    )}
                  >
                    {step.status === 'error' ? (
                      <X size={11} />
                    ) : (
                      <Check size={11} />
                    )}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-zinc-200">
                        {step.tool.replace('calendar_', '')}
                      </span>
                      {step.faultInjected && (
                        <span className="rounded border border-amber-300/20 bg-amber-300/5 px-1.5 py-0.5 font-mono text-[9px] text-amber-200">
                          FAULT INJECTED
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[10px] tabular-nums text-zinc-400">
                      {step.durationMs} ms
                    </span>
                  </div>
                  {step.output.error && (
                    <p className="mt-2 text-xs leading-relaxed text-rose-300">
                      {step.output.error.code}: {step.output.error.message}
                    </p>
                  )}
                  {step.sideEffect && (
                    <div className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-zinc-400">
                      <ArrowUpRight
                        size={13}
                        className="mt-0.5 shrink-0 text-lime-300"
                      />
                      <span>{step.sideEffect}</span>
                    </div>
                  )}
                  <details className="mt-2 text-xs">
                    <summary className="w-fit rounded text-[11px] text-zinc-400 hover:text-zinc-300">
                      Inspect payload
                    </summary>
                    <div className="mt-2 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                      <div className="font-mono text-[9px] text-zinc-400">
                        INPUT
                      </div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-zinc-400">
                        {JSON.stringify(step.input, null, 2)}
                      </pre>
                      <div className="border-t border-zinc-800 pt-2 font-mono text-[9px] text-zinc-400">
                        OUTPUT
                      </div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-zinc-400">
                        {JSON.stringify(step.output, null, 2)}
                      </pre>
                    </div>
                  </details>
                </div>
              </li>
            ))}
          </ol>
          {run.status === 'completed' && (
            <div className="mt-5 flex items-start gap-2 rounded-lg bg-zinc-800/40 p-3 text-xs leading-relaxed text-zinc-400">
              <Circle size={11} className="mt-1 shrink-0" />
              <span>
                {run.summary || 'Run completed. Inspect the checks below.'}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
function Checks({ run }: { run: Run }) {
  return (
    <section className={cn(panel, 'mt-4 p-5')} aria-label="Outcome checks">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck size={15} className="text-zinc-400" />
          Outcome checks
        </h3>
        <span className="font-mono text-[10px] text-zinc-400">STATE-BASED</span>
      </div>
      {run.status === 'running' ? (
        <p className="text-xs text-zinc-400">
          Checks run when the rehearsal finishes.
          {run.policy === 'external' &&
            ' Ask your agent to call rehearsal_finish_run.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {run.checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2.5">
              {check.passed ? (
                <CheckCircle2
                  size={15}
                  className="mt-0.5 shrink-0 text-lime-300"
                />
              ) : (
                <XCircle size={15} className="mt-0.5 shrink-0 text-rose-300" />
              )}
              <div>
                <p className="text-xs font-medium text-zinc-300">
                  {check.label}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                  {check.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function Calendar({
  events,
  hasRun,
}: {
  events: CalendarEvent[];
  hasRun: boolean;
}) {
  const hours = [10, 11, 12, 13, 14, 15, 16, 17];
  const created = events.filter((event) => event.source === 'agent').length;
  const hasConcurrentBooking = events.some(
    (event) => event.source === 'concurrent',
  );
  const visibleEvents = events.filter(
    (event) =>
      event.start.startsWith('2026-10-22') &&
      new Date(event.start).getUTCHours() >= 10 &&
      new Date(event.start).getUTCHours() <= 17,
  );
  const otherEvents = events.filter((event) => !visibleEvents.includes(event));
  return (
    <section
      className={cn(panel, 'overflow-hidden')}
      aria-label="Simulated calendar"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <CalendarDays size={15} className="text-zinc-400" />
          Calendar state
        </h3>
        <span className="font-mono text-[10px] text-zinc-400">UTC</span>
      </div>
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <div className="text-sm font-medium">Thursday, 22 October</div>
          <div className="mt-1 text-[10px] text-zinc-400">
            2026 · Fixed test fixture
          </div>
        </div>
        <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[9px] text-zinc-400">
          {hasRun ? 'AFTER ACTIONS' : 'INITIAL STATE'}
        </span>
      </div>
      <div className="px-4 pb-3">
        {hours.map((hour) => {
          const inHour = visibleEvents.filter(
            (event) => new Date(event.start).getUTCHours() === hour,
          );
          return (
            <div key={hour} className="flex min-h-14 gap-3">
              <span className="w-9 shrink-0 pt-1 font-mono text-[10px] tabular-nums text-zinc-400">
                {String(hour).padStart(2, '0')}:00
              </span>
              <div
                className={cn(
                  'min-w-0 flex-1 border-t border-zinc-800/70 py-1',
                  hour >= 14 && hour < 17 && 'bg-lime-300/[0.025]',
                )}
              >
                <div className="space-y-1">
                  {inHour.map((event) => {
                    const duplicate =
                      event.source === 'agent' &&
                      events.some(
                        (other) =>
                          other.id !== event.id &&
                          other.source === 'agent' &&
                          other.title === event.title &&
                          other.start === event.start,
                      );
                    return (
                      <div
                        key={event.id}
                        className={cn(
                          'border-l-2 px-2 py-1.5',
                          event.source === 'seed'
                            ? 'border-zinc-600 bg-zinc-800/60 text-zinc-400'
                            : event.source === 'concurrent'
                              ? 'border-amber-300 bg-amber-300/10 text-amber-200'
                              : duplicate
                                ? 'border-rose-300 bg-rose-300/10 text-rose-200'
                                : 'border-lime-300 bg-lime-300/10 text-lime-200',
                        )}
                      >
                        <div className="flex items-start justify-between gap-1">
                          <span className="break-words text-[11px] font-medium">
                            {event.title}
                          </span>
                          {duplicate && (
                            <span className="shrink-0 font-mono text-[8px]">
                              DUPLICATE
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 font-mono text-[9px] tabular-nums">
                          {time(event.start)}–{time(event.end)}
                          {' · '}
                          {eventSourceNames[event.source]}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {hour === 14 && inHour.length === 0 && (
                  <div className="px-2 py-1.5 font-mono text-[9px] text-lime-300/70">
                    REQUESTED WINDOW · 14:00–17:00
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {otherEvents.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3">
            <h4 className="text-xs font-medium text-amber-200">
              Outside the displayed day or hours
            </h4>
            <ul className="mt-2 space-y-2">
              {otherEvents.map((event) => (
                <li key={event.id} className="text-xs text-zinc-400">
                  <span className="block text-zinc-200">{event.title}</span>
                  <span className="break-all font-mono text-[10px]">
                    {event.start} → {event.end}
                  </span>
                  <span className="block text-[10px]">
                    {eventSourceNames[event.source]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-zinc-400">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-sm bg-zinc-500" />
            Initial
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-sm bg-lime-300" />
            Agent-created
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-sm bg-amber-300" />
            Concurrent
          </span>
        </div>
        <span className="font-mono text-[10px] tabular-nums text-zinc-400">
          {created} AGENT-CREATED
        </span>
      </div>
      {hasConcurrentBooking && (
        <p className="border-t border-zinc-800 px-5 py-3 text-[11px] leading-relaxed text-zinc-400">
          A concurrent booking was added by the simulated environment during
          this run.
        </p>
      )}
    </section>
  );
}
function HistoryView({
  runs,
  scenarios,
  loading,
  onInspect,
  onExport,
  onStart,
}: {
  runs: Run[];
  scenarios: Scenario[];
  loading: boolean;
  onInspect: (run: Run) => void;
  onExport: (run: Run) => void;
  onStart: () => void;
}) {
  if (loading) return <LoadingState />;
  if (!runs.length)
    return (
      <div
        className={cn(
          panel,
          'flex min-h-80 flex-col items-center justify-center p-8 text-center',
        )}
      >
        <History size={28} className="mb-5 text-zinc-400" />
        <h2 className="text-lg font-medium">Your first run starts here.</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Completed and in-progress rehearsals will be saved locally.
        </p>
        <button onClick={onStart} className={cn(primaryButton, 'mt-6')}>
          Open the lab
          <ArrowRight size={14} />
        </button>
      </div>
    );
  return (
    <div className={cn(panel, 'overflow-hidden')}>
      <div className="flex items-center justify-between border-b border-zinc-800 p-5">
        <h2 className="text-sm font-medium">All rehearsals</h2>
        <span className="font-mono text-xs tabular-nums text-zinc-400">
          {runs.length} runs
        </span>
      </div>
      <ul className="divide-y divide-zinc-800">
        {runs.map((run) => (
          <li
            key={run.id}
            className="flex flex-wrap items-center justify-between gap-4 p-5"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  onClick={() => onInspect(run)}
                  className="rounded text-left text-sm font-medium hover:text-lime-300"
                >
                  {scenarios.find((s) => s.id === run.scenarioId)?.name ??
                    run.scenarioId}
                </button>
                <Outcome run={run} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
                <span>{policyNames[run.policy]}</span>
                <span>{dateTime(run.createdAt)}</span>
                <span className="font-mono text-[10px]">
                  {run.id.slice(0, 8)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="mr-2 hidden font-mono text-xs tabular-nums text-zinc-400 sm:inline">
                {run.steps.length} calls
              </span>
              <button
                onClick={() => onExport(run)}
                className="rounded-lg border border-zinc-800 p-2 text-zinc-400 hover:text-zinc-200"
                aria-label={`Export run ${run.id.slice(0, 8)}`}
              >
                <ArrowDownToLine size={15} />
              </button>
              <button
                onClick={() => onInspect(run)}
                className={secondaryButton}
              >
                Inspect
                <ArrowRight size={13} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
function ConnectView() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  async function load() {
    try {
      setError('');
      setConnection(await request<Connection>('/api/connection'));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not load connection details.',
      );
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const config = connection
    ? JSON.stringify(
        {
          mcpServers: {
            'agent-rehearsal': {
              command: connection.command,
              args: connection.args,
              env: { REHEARSAL_DB: connection.dbPath },
            },
          },
        },
        null,
        2,
      )
    : '';
  async function copy() {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
    } catch {
      setError(
        'Clipboard access was denied. Select and copy the configuration below.',
      );
    }
  }
  return (
    <div className="grid gap-6 xl:grid-cols-5">
      <div className="min-w-0 space-y-5 xl:col-span-3">
        <section className={cn(panel, 'p-5 sm:p-6')}>
          <div className="mb-5 flex items-center gap-3">
            <span className="flex size-7 items-center justify-center rounded-lg bg-lime-300/10 font-mono text-xs text-lime-300">
              01
            </span>
            <h2 className="text-base font-medium">Add the MCP server</h2>
          </div>
          <p className="mb-4 text-sm leading-relaxed text-zinc-400">
            Build the project with{' '}
            <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-200">
              npm run build
            </code>
            , then add this configuration to an MCP-compatible client. It uses
            stdio and the same local database as this dashboard.
          </p>
          {error && (
            <ErrorNotice onRetry={() => void load()}>{error}</ErrorNotice>
          )}
          {connection ? (
            <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
              <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                <span className="flex items-center gap-2 font-mono text-[10px] text-zinc-400">
                  <Braces size={13} />
                  MCP CONFIGURATION
                </span>
                <button
                  onClick={() => void copy()}
                  className="flex items-center gap-1.5 rounded text-xs text-zinc-400 hover:text-zinc-100"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed text-zinc-300">
                {config}
              </pre>
            </div>
          ) : (
            !error && (
              <p className="text-sm text-zinc-400" role="status">
                Loading local connection details…
              </p>
            )
          )}
        </section>
        <section className={cn(panel, 'p-5 sm:p-6')}>
          <div className="mb-5 flex items-center gap-3">
            <span className="flex size-7 items-center justify-center rounded-lg bg-lime-300/10 font-mono text-xs text-lime-300">
              02
            </span>
            <h2 className="text-base font-medium">
              Give your agent a rehearsal
            </h2>
          </div>
          <blockquote className="rounded-lg border-l-2 border-lime-300 bg-lime-300/5 p-4 text-sm leading-relaxed text-zinc-300">
            Start a rehearsal using the timeout-after-write scenario. Read the
            returned task, schedule the meeting using the calendar tools, and
            finish the run to evaluate the outcome.
          </blockquote>
          <p className="mt-4 text-xs leading-relaxed text-zinc-400">
            Open Run history to inspect the external agent's run. Every action
            updates the same calendar state and trace you see in the lab.
          </p>
        </section>
      </div>
      <div className="space-y-5 xl:col-span-2">
        <section className={cn(panel, 'p-5 sm:p-6')}>
          <div className="mb-5 flex items-center gap-2">
            <Radio size={16} className="text-lime-300" />
            <h2 className="text-sm font-medium">The tool contract</h2>
          </div>
          <ol className="space-y-5">
            {[
              {
                name: 'rehearsal_start_run',
                description:
                  'Create an isolated run and get its task, scenario, and run ID.',
              },
              {
                name: 'calendar_list_events',
                description: 'Read the actual state of this run’s calendar.',
              },
              {
                name: 'calendar_create_event',
                description:
                  'Create a meeting. Faults are injected by the selected scenario.',
              },
              {
                name: 'rehearsal_finish_run',
                description: 'Evaluate the final state and record the checks.',
              },
            ].map((tool, i) => (
              <li key={tool.name} className="flex gap-3">
                <span className="mt-0.5 font-mono text-[10px] text-zinc-400">
                  0{i + 1}
                </span>
                <div className="min-w-0">
                  <code className="break-all text-xs text-zinc-300">
                    {tool.name}
                  </code>
                  <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                    {tool.description}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <div className="flex items-start gap-3 rounded-xl border border-zinc-800 p-5">
          <ShieldCheck size={19} className="mt-0.5 shrink-0 text-zinc-400" />
          <div>
            <h3 className="text-sm font-medium">Local by design</h3>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">
              The simulator needs no model API key. Your external agent uses its
              own model configuration. Tool activity and calendar data stay in
              the local SQLite database.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
