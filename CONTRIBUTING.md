# Contributing to Agent Rehearsal

The goal is to make agent failures visible and reproducible in a small local simulator. Changes should make it easier to understand the relationship between a tool response, a real state change, and the final task outcome.

## Get started

Use Node.js 24 or newer:

```bash
npm ci
npm run dev
```

The dashboard runs at `http://localhost:5173` and the API at `http://localhost:4173`. No model API key is needed for the demo policies.

Before submitting a pull request:

```bash
npm run typecheck
npm test
npm run build
```

For interface changes, also check the affected flow in a browser at desktop and narrow mobile widths. Ensure controls work with a keyboard, errors are visible near the action, and the dashboard distinguishes pending checks from passed checks.

## Add a scenario

Scenario fixtures live in `server/scenarios.ts`; simulation behavior lives in `server/engine.ts`. Shared contracts live in `shared/types.ts`.

1. Describe the specific failure and the state change it should cause.
2. Keep fixture data synthetic and deterministic. The current calendar fixture uses 22 October 2026 in UTC.
3. Add the scenario's typed identifier and definition, plus the corresponding simulation behavior.
4. Add behavioral tests that verify tool responses **and persisted state**. Cover recovery, isolation from other runs, and the failure path.
5. Confirm the dashboard describes what happened without showing hidden state to the tested agent through MCP.
6. Update the README's scenario table.

Prefer a small scenario with a measurable outcome over a large simulated integration. A checker must not pass merely because no actions occurred. Never silently replace an actual failure with a fabricated success.

## Agent and tool integrations

The built-in policies are intentionally scripted. Keep them labeled that way, and avoid coupling the simulator to a single model provider. New integrations should work through clear tool contracts, preserve isolated run state, and avoid requiring live account credentials.

Logs and exports may contain user-supplied task data. Do not add telemetry, committed databases, access tokens, personal paths, or real account fixtures. stdio MCP logs must go to stderr so stdout stays valid protocol traffic.

## Issues and pull requests

For a bug report, include the scenario, policy or external agent, expected outcome, actual outcome, and relevant sanitized tool calls. Include Node.js and operating system versions for setup problems.

Keep pull requests focused. Explain the behavior being changed and the checks you ran. Discuss a large new simulated service or a change to the public MCP contract in an issue before investing in a broad implementation.

By contributing, you agree that your contribution is licensed under the project's MIT license.
