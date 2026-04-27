import fs from "node:fs/promises";
import path from "node:path";
import { STATE_FILE } from "./constants.js";
import type { CollaborationMode, WorkerSpec } from "./templates.js";

export type TeamStatus = "provisioning" | "ready" | "running" | "completed" | "error";

export type TeamRecord = {
  teamId: string;
  teamName: string;
  templateId: string;
  leaderAgentId: string;
  workers: WorkerSpec[];
  collaborationMode: CollaborationMode;
  status: TeamStatus;
  createdAt: string;
};

type PersistedState = {
  version: 1;
  teams: TeamRecord[];
};

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
   * Matches by templateId and "ready" status.
   */
  findReusableTeams(templateId: string): TeamRecord[] {
    return [...this.teams.values()].filter(
      (t) => t.templateId === templateId && t.status === "ready",
    );
  }

  async loadFromDisk(stateDir: string): Promise<void> {
    const filePath = path.join(stateDir, STATE_FILE);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as PersistedState;
      if (data.version === 1 && Array.isArray(data.teams)) {
        this.teams.clear();
        for (const record of data.teams) {
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
    const filePath = path.join(stateDir, STATE_FILE);
    const data: PersistedState = {
      version: 1,
      teams: [...this.teams.values()],
    };
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}
