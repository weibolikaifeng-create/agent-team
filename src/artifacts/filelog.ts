import fs from "node:fs/promises";
import path from "node:path";
import { TEAM_DIR_NAME } from "../constants.js";
import { ARTIFACT_LOG_FILE } from "./constants.js";

/**
 * Diagnostic logging for artifact recognition (agent-team / dynamic mode).
 *
 * Disabled by default; enabled via plugin config `logs: true`
 * (plugins.entries.astron-agent-team.config.logs). When enabled:
 *
 * - team-level logs go to `{stateDir}/teams/{teamId}/artifact-recognition.log`
 *   (same directory as that team's artifacts.json — easy per-team triage);
 * - the few events with no team context yet (hook registration, unrecognized
 *   short-circuits) go to the global `{stateDir}/teams/artifact-recognition.log`.
 *
 * Best-effort and fire-and-forget: never throws, never blocks the caller.
 *
 * Logging machinery (rotation + per-file serialization) copied verbatim from the
 * proven static-team implementation.
 */

let enabled = false;

export function setArtifactLogEnabled(on: boolean): void {
  enabled = on === true;
}

export function isArtifactLogEnabled(): boolean {
  return enabled;
}

// ── size-based rotation ──────────────────────────────────────────────
// Each log file is capped at MAX_LOG_BYTES; when exceeded it is renamed to
// `<file>.1` (replacing the previous backup) and a fresh file is started, so a
// long-lived process with `logs: true` is bounded to ~2× the cap per file.
// The size check runs on the first append per file and then every
// ROTATE_CHECK_EVERY appends — not on every line — to keep logging cheap.
//
// Per file, all appends are chained onto a single serialized promise (`tails`).
// This keeps line order stable and, crucially, makes rotate-then-append atomic
// with respect to other appends to the same file: two overflow-time checks can
// never interleave into a double rename that discards the fresh backup.

const MAX_LOG_BYTES = 100 * 1024 * 1024;
const ROTATE_CHECK_EVERY = 100;
const appendCounts = new Map<string, number>();
const tails = new Map<string, Promise<void>>();

async function rotateIfNeeded(file: string): Promise<void> {
  try {
    const st = await fs.stat(file);
    if (st.size < MAX_LOG_BYTES) return;
    await fs.rename(file, `${file}.1`);
  } catch {
    // ENOENT (nothing to rotate yet) or a rename race — try again next check.
  }
}

function append(file: string, msg: string): void {
  try {
    const line = `${new Date().toISOString()} ${msg}\n`;
    // Check on the very first append per file, then once each full cycle. The
    // counter resets to 0 exactly on the boundary, so the next append is 1 and
    // does NOT re-check — a single check per cycle, no boundary double-fire.
    const count = ((appendCounts.get(file) ?? 0) + 1) % ROTATE_CHECK_EVERY;
    appendCounts.set(file, count);
    const shouldCheck = count === 1;
    const run = async () => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        if (shouldCheck) await rotateIfNeeded(file);
        await fs.appendFile(file, line);
      } catch {
        // never let logging affect anything
      }
    };
    // Serialize per file: append after whatever is already queued for it.
    const prev = tails.get(file) ?? Promise.resolve();
    const next = prev.then(run, run);
    tails.set(file, next);
    // Bound the map: drop the entry once this tail settles and nothing newer
    // has replaced it, so idle files don't accumulate promises forever.
    void next.finally(() => {
      if (tails.get(file) === next) tails.delete(file);
    });
  } catch {
    // never let logging affect anything
  }
}

/** Team-level log (preferred): next to that team's artifacts.json. */
export function slog(stateDir: string, teamId: string, msg: string): void {
  if (!enabled) return;
  append(path.join(stateDir, TEAM_DIR_NAME, teamId, ARTIFACT_LOG_FILE), msg);
}

/** Global log (fallback): for events that have no team context yet. */
export function glog(stateDir: string, msg: string): void {
  if (!enabled) return;
  append(path.join(stateDir, TEAM_DIR_NAME, ARTIFACT_LOG_FILE), msg);
}
