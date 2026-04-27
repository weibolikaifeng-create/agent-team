/** Directory name for team workspaces under the state dir. */
export const TEAM_DIR_NAME = "teams";

/** Filename for persisted team state. */
export const STATE_FILE = "agent-team-state.json";

/** Maximum number of workers a single team can have. */
export const MAX_WORKERS = 5;

/** Maximum subagent spawn depth — allows Leader (depth 1) to spawn Workers (depth 2+). */
export const MAX_SPAWN_DEPTH = 5;
