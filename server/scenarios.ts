import type { CalendarEvent, Scenario } from '../shared/types.js';

const teamStandup: CalendarEvent = {
  id: 'seed-standup',
  title: 'Team standup',
  start: '2026-10-22T11:00:00Z',
  end: '2026-10-22T11:30:00Z',
  attendees: ['team@example.test'],
  source: 'seed',
};

const base = {
  task: 'Schedule one 30-minute Design review with sarah@example.test on October 22, 2026, between 14:00 and 17:00 UTC. Avoid calendar conflicts.',
  date: '2026-10-22',
  timezone: 'UTC' as const,
  target: {
    title: 'Design review',
    attendees: ['sarah@example.test'],
    windowStart: '2026-10-22T14:00:00Z',
    windowEnd: '2026-10-22T17:00:00Z',
    durationMinutes: 30,
  },
};

/** Fixed fixtures make scenario results comparable regardless of the host's date or timezone. */
export const SCENARIOS: readonly Scenario[] = [
  {
    ...base,
    id: 'clean',
    name: 'Clear skies',
    description:
      'A healthy calendar. Establish a baseline before introducing failures.',
    faultLabel: 'No fault',
    faultDescription:
      'All calendar tools respond normally. Conflicting writes are rejected.',
    initialEvents: [teamStandup],
  },
  {
    ...base,
    id: 'timeout-after-write',
    name: 'The missing confirmation',
    description:
      'The meeting is saved, but its confirmation never reaches the agent.',
    faultLabel: 'Timeout after write',
    faultDescription:
      'The first successful create saves an event, then returns a timeout. Repeating that exact write can create a duplicate; unrelated overlapping bookings are still rejected.',
    initialEvents: [teamStandup],
  },
  {
    ...base,
    id: 'permission-denied',
    name: 'Access denied',
    description: 'The agent can read the calendar, but cannot create events.',
    faultLabel: 'Permission denied',
    faultDescription:
      'Every create request returns PERMISSION_DENIED without changing the calendar. The task cannot pass while write access is denied.',
    initialEvents: [teamStandup],
  },
  {
    ...base,
    id: 'slot-conflict',
    name: 'A crowded calendar',
    description:
      'The first afternoon slot is occupied. The agent needs to find another.',
    faultLabel: 'Unavailable slot',
    faultDescription:
      'A seeded event occupies 14:00–14:30 UTC. Overlapping create requests return CONFLICT without changing the calendar.',
    initialEvents: [
      teamStandup,
      {
        id: 'seed-planning',
        title: 'Product planning',
        start: '2026-10-22T14:00:00Z',
        end: '2026-10-22T14:30:00Z',
        attendees: ['sarah@example.test'],
        source: 'seed',
      },
    ],
  },
  {
    ...base,
    id: 'slot-race',
    name: 'Someone got there first',
    description:
      'A free slot gets booked just before the agent saves. Can it find a new time?',
    faultLabel: 'Booking race',
    faultDescription:
      'The first valid create in a free slot triggers one competing booking, then returns CONFLICT without creating the requested event. Read availability again and choose another slot.',
    initialEvents: [teamStandup],
  },
];
