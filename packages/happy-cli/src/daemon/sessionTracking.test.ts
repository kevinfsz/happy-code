import { describe, expect, it } from 'vitest';

import type { TrackedSession } from './types';
import { listAliveTrackedSessions } from './sessionTracking';

function session(pid: number, startedBy = 'happy directly - likely by user from terminal'): TrackedSession {
  return {
    pid,
    startedBy,
    happySessionId: `session-${pid}`,
  };
}

describe('listAliveTrackedSessions', () => {
  it('removes dead externally tracked sessions before listing', () => {
    const tracked = new Map<number, TrackedSession>([
      [1001, session(1001)],
      [1002, session(1002)],
    ]);

    const alive = listAliveTrackedSessions(tracked, (pid: number) => pid === 1002);

    expect(alive).toEqual([session(1002)]);
    expect(Array.from(tracked.keys())).toEqual([1002]);
  });

  it('keeps daemon-spawned sessions that are still alive', () => {
    const tracked = new Map<number, TrackedSession>([
      [2001, { ...session(2001, 'daemon'), startedBy: 'daemon' }],
    ]);

    const alive = listAliveTrackedSessions(tracked, () => true);

    expect(alive).toEqual([{ ...session(2001, 'daemon'), startedBy: 'daemon' }]);
    expect(Array.from(tracked.keys())).toEqual([2001]);
  });
});
