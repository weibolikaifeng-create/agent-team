import fs from "node:fs/promises";
import path from "node:path";
import { STATE_FILE, TEAM_DIR_NAME } from "./constants.js";
import type { CollaborationMode, WorkerSpec } from "./templates.js";

export type TeamStatus = "provisioning" | "ready" | "running" | "completed" | "error" | "";

export type ExecutionStatus = "pending" | "running" | "completed" | "failed" | "";

export type ExecutionRecord = {
  executionId: string;
  taskPrompt: string;
  taskName: string;
  status: ExecutionStatus;
  createdAt: string;
  completedAt?: string;
  sessionKey: string;
};

export type TeamRecord = {
  teamId: string;
  teamName: string;
  templateId: string;
  leaderAgentId: string;
  leaderName: string;
  workers: WorkerSpec[];
  collaborationMode: CollaborationMode;
  status: TeamStatus;
  createdAt: string;
  sessionKey: string;
  executions: ExecutionRecord[];
  currentExecutionId?: string;
};

// ── Standalone disk I/O helpers (no in-memory cache) ─────────────

export type PersistedState = {
  version: 1;
  teams: TeamRecord[];
};

function emptyState(): PersistedState {
  return { version: 1, teams: [] };
}

/** Read team state directly from disk. Returns empty state if file doesn't exist. */
export async function readStateFromDisk(stateDir: string): Promise<PersistedState> {
  const filePath = path.join(stateDir, TEAM_DIR_NAME, STATE_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as PersistedState;
    if (data.version === 1 && Array.isArray(data.teams)) {
      // Backward compatibility
      for (const record of data.teams) {
        if (!Array.isArray(record.executions)) record.executions = [];
        if (!record.sessionKey) record.sessionKey = "";
        // Backward compatibility: ensure sessionKey exists in execution records
        for (const exec of record.executions) {
          if (!exec.sessionKey) {
            exec.sessionKey = record.sessionKey || "";
          }
        }
      }
      return data;
    }
    return emptyState();
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw err;
  }
}

/** Atomic write team state to disk (tmp + rename). */
export async function writeStateToDisk(stateDir: string, data: PersistedState): Promise<void> {
  const dirPath = path.join(stateDir, TEAM_DIR_NAME);
  const filePath = path.join(dirPath, STATE_FILE);
  const tmpPath = filePath + ".tmp";
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

/** Generate next execution ID for a team based on existing execution count. */
export function getNextExecutionId(team: TeamRecord): string {
  return `exec-${team.executions.length + 1}`;
}

// ── Legacy TeamStateManager (kept for tests) ──────────────────────

/**
 * Manages team lifecycle state in memory with optional disk persistence.
 */
export class TeamStateManager {
  private teams = new Map<string, TeamRecord>();

  addTeam(record: TeamRecord): void {
    this.teams.set(record.teamId, record);
  }

  getTeam(teamId: string): TeamRecord | undefined {
    return this.teams.get(teamId);
  }

  updateStatus(teamId: string, status: TeamStatus): void {
    const record = this.teams.get(teamId);
    if (record) {
      record.status = status;
    }
  }

  removeTeam(teamId: string): void {
    this.teams.delete(teamId);
  }

  getActiveTeams(): TeamRecord[] {
    return [...this.teams.values()].filter((t) => t.status !== "completed" && t.status !== "error");
  }

  getAllTeams(): TeamRecord[] {
    return [...this.teams.values()];
  }

  /**
   * Find teams that could potentially be reused for a similar task.
   * Matches by templateId, "ready" status, and optionally sessionKey.
   */
  findReusableTeams(templateId: string, sessionKey?: string): TeamRecord[] {
    return [...this.teams.values()].filter(
      (t) =>
        t.templateId === templateId &&
        t.status === "ready" &&
        (sessionKey === undefined || t.sessionKey === sessionKey),
    );
  }

  getTeamsBySession(sessionKey: string): TeamRecord[] {
    return [...this.teams.values()].filter((t) => t.sessionKey === sessionKey);
  }

  addExecution(teamId: string, execution: ExecutionRecord): void {
    const record = this.teams.get(teamId);
    if (record) {
      record.executions.push(execution);
      record.currentExecutionId = execution.executionId;
    }
  }

  updateExecutionStatus(teamId: string, executionId: string, status: ExecutionStatus): void {
    const record = this.teams.get(teamId);
    if (!record) return;
    const exec = record.executions.find((e) => e.executionId === executionId);
    if (exec) {
      exec.status = status;
      if (status === "completed" || status === "failed") {
        exec.completedAt = new Date().toISOString();
      }
    }
  }

  getNextExecutionId(teamId: string): string {
    const record = this.teams.get(teamId);
    const count = record ? record.executions.length : 0;
    return `exec-${count + 1}`;
  }

  async loadFromDisk(stateDir: string): Promise<void> {
    const filePath = path.join(stateDir, TEAM_DIR_NAME, STATE_FILE);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as PersistedState;
      if (data.version === 1 && Array.isArray(data.teams)) {
        this.teams.clear();
        for (const record of data.teams) {
          // Backward compatibility: ensure executions array exists
          if (!Array.isArray(record.executions)) {
            record.executions = [];
          }
          // Backward compatibility: ensure sessionKey exists (default to empty string for old records)
          if (!record.sessionKey) {
            record.sessionKey = "";
          }
          // Backward compatibility: ensure sessionKey exists in execution records
          for (const exec of record.executions) {
            if (!exec.sessionKey) {
              exec.sessionKey = record.sessionKey || "";
            }
          }
          this.teams.set(record.teamId, record);
        }
      }
    } catch (err) {
      // Ignore missing file — that's the normal "first run" case.
      // Log everything else so real errors (permissions, disk full) are visible.
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[agent-team] Failed to load team state from ${filePath}: ${err.message}`);
      }
    }
  }

  async saveToDisk(stateDir: string): Promise<void> {
    const dirPath = path.join(stateDir, TEAM_DIR_NAME);
    const filePath = path.join(dirPath, STATE_FILE);
    const tmpPath = filePath + ".tmp";
    const data: PersistedState = {
      version: 1,
      teams: [...this.teams.values()],
    };
    await fs.mkdir(dirPath, { recursive: true });
    // Atomic write: write to temp file first, then rename to avoid corruption.
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  }
}
