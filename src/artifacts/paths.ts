import path from "node:path";
import { TEAM_DIR_NAME, EXECUTIONS_DIR, OUTPUT_DIR } from "../constants.js";
import { ARTIFACTS_FILE, MEMBERS_FILE } from "./constants.js";

/**
 * Path helpers for the artifact-recognition layer. Layout mirrors the existing
 * agent-team workspace convention (see src/constants.ts):
 *
 *   teams/{teamId}/agent-team-state.json                     ← existing state file
 *   teams/{teamId}/artifacts.json                            ← this layer
 *   teams/{teamId}/members.json                              ← this layer
 *   teams/{teamId}/executions/{executionId}/output/{X}/...   ← per-member output
 */

/** Absolute path of a team's artifacts manifest: `teams/{teamId}/artifacts.json`. */
export function artifactsManifestPath(stateDir: string, teamId: string): string {
  return path.join(stateDir, TEAM_DIR_NAME, teamId, ARTIFACTS_FILE);
}

/** Absolute path of a team's member registry: `teams/{teamId}/members.json`. */
export function membersPath(stateDir: string, teamId: string): string {
  return path.join(stateDir, TEAM_DIR_NAME, teamId, MEMBERS_FILE);
}

/** Execution output root: `teams/{teamId}/executions/{executionId}/output/`. */
export function executionOutputDir(stateDir: string, teamId: string, executionId: string): string {
  return path.join(stateDir, TEAM_DIR_NAME, teamId, EXECUTIONS_DIR, executionId, OUTPUT_DIR);
}
