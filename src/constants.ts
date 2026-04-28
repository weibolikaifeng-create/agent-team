/** Directory name for team workspaces under the state dir. */
export const TEAM_DIR_NAME = "teams";

/** Filename for persisted team state (stored inside TEAM_DIR_NAME). */
export const STATE_FILE = "agent-team-state.json";

/** Directory name for execution instances under each team workspace. */
export const EXECUTIONS_DIR = "executions";

/** Filename for progress tracking inside each execution directory. */
export const TODO_FILE = "todo.md";

/** Directory name for output artifacts inside each execution directory. */
export const OUTPUT_DIR = "output";

/** Maximum number of workers a single team can have. */
export const MAX_WORKERS = 5;

/** Maximum subagent spawn depth — allows Leader (depth 1) to spawn Workers (depth 2+). */
export const MAX_SPAWN_DEPTH = 5;
