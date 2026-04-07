import type { TrackedSession } from './types';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listAliveTrackedSessions(
  trackedSessions: Map<number, TrackedSession>,
  processAlive: (pid: number) => boolean = isProcessAlive,
): TrackedSession[] {
  for (const [pid] of trackedSessions.entries()) {
    if (!processAlive(pid)) {
      trackedSessions.delete(pid);
    }
  }

  return Array.from(trackedSessions.values());
}
