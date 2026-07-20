/**
 * In-memory cache of `runId -> workspaceDir`.
 *
 * The `after_tool_call` hook does not carry `workspaceDir`, but relative write
 * paths must be resolved against the run's real workspace. The
 * `agent_turn_prepare` hook does carry it, so we cache it there (keyed by runId)
 * and read it back during capture.
 *
 * Entries are evicted when their run ends (`agent_end`). A hard cap guards
 * against unbounded growth if an end event is ever missed.
 *
 * Copied verbatim from the proven static-team implementation.
 */

const MAX_ENTRIES = 4096;

const cache = new Map<string, string>();

/** Record the workspace directory for a run (called from agent_turn_prepare). */
export function rememberWorkspaceDir(runId: string | undefined, workspaceDir: string | undefined): void {
  if (!runId || !workspaceDir) return;

  // Refresh recency: delete + re-set moves the key to the end of the Map.
  if (cache.has(runId)) cache.delete(runId);
  cache.set(runId, workspaceDir);

  // Evict oldest entries beyond the cap (Map preserves insertion order).
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Look up the cached workspace directory for a run (called during capture). */
export function getWorkspaceDir(runId: string | undefined): string | undefined {
  if (!runId) return undefined;
  return cache.get(runId);
}

/** Drop a run's cached workspace directory (called from agent_end). */
export function forgetWorkspaceDir(runId: string | undefined): void {
  if (!runId) return;
  cache.delete(runId);
}
