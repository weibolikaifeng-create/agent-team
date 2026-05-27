import fs from "node:fs/promises";
import path from "node:path";
import { STATE_FILE, TEAM_DIR_NAME } from "./constants.js";
function emptyState() {
    return { version: 1, teams: [] };
}
/** Read team state directly from disk. Returns empty state if file doesn't exist. */
export async function readStateFromDisk(stateDir) {
    const filePath = path.join(stateDir, TEAM_DIR_NAME, STATE_FILE);
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        const data = JSON.parse(raw);
        if (data.version === 1 && Array.isArray(data.teams)) {
            // Backward compatibility
            for (const record of data.teams) {
                if (!Array.isArray(record.executions))
                    record.executions = [];
                if (!record.sessionKey)
                    record.sessionKey = "";
            }
            return data;
        }
        return emptyState();
    }
    catch (err) {
        if (err instanceof Error && err.code === "ENOENT") {
            return emptyState();
        }
        throw err;
    }
}
/** Atomic write team state to disk (tmp + rename). */
export async function writeStateToDisk(stateDir, data) {
    const dirPath = path.join(stateDir, TEAM_DIR_NAME);
    const filePath = path.join(dirPath, STATE_FILE);
    const tmpPath = filePath + ".tmp";
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
}
/** Generate next execution ID for a team based on existing execution count. */
export function getNextExecutionId(team) {
    return `exec-${team.executions.length + 1}`;
}
// ── Legacy TeamStateManager (kept for tests) ──────────────────────
/**
 * Manages team lifecycle state in memory with optional disk persistence.
 */
export class TeamStateManager {
    teams = new Map();
    addTeam(record) {
        this.teams.set(record.teamId, record);
    }
    getTeam(teamId) {
        return this.teams.get(teamId);
    }
    updateStatus(teamId, status) {
        const record = this.teams.get(teamId);
        if (record) {
            record.status = status;
        }
    }
    removeTeam(teamId) {
        this.teams.delete(teamId);
    }
    getActiveTeams() {
        return [...this.teams.values()].filter((t) => t.status !== "completed" && t.status !== "error");
    }
    getAllTeams() {
        return [...this.teams.values()];
    }
    /**
     * Find teams that could potentially be reused for a similar task.
     * Matches by templateId, "ready" status, and optionally sessionKey.
     */
    findReusableTeams(templateId, sessionKey) {
        return [...this.teams.values()].filter((t) => t.templateId === templateId &&
            t.status === "ready" &&
            (sessionKey === undefined || t.sessionKey === sessionKey));
    }
    getTeamsBySession(sessionKey) {
        return [...this.teams.values()].filter((t) => t.sessionKey === sessionKey);
    }
    addExecution(teamId, execution) {
        const record = this.teams.get(teamId);
        if (record) {
            record.executions.push(execution);
            record.currentExecutionId = execution.executionId;
        }
    }
    updateExecutionStatus(teamId, executionId, status) {
        const record = this.teams.get(teamId);
        if (!record)
            return;
        const exec = record.executions.find((e) => e.executionId === executionId);
        if (exec) {
            exec.status = status;
            if (status === "completed" || status === "failed") {
                exec.completedAt = new Date().toISOString();
            }
        }
    }
    getNextExecutionId(teamId) {
        const record = this.teams.get(teamId);
        const count = record ? record.executions.length : 0;
        return `exec-${count + 1}`;
    }
    async loadFromDisk(stateDir) {
        const filePath = path.join(stateDir, TEAM_DIR_NAME, STATE_FILE);
        try {
            const raw = await fs.readFile(filePath, "utf-8");
            const data = JSON.parse(raw);
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
                    this.teams.set(record.teamId, record);
                }
            }
        }
        catch (err) {
            // Ignore missing file — that's the normal "first run" case.
            // Log everything else so real errors (permissions, disk full) are visible.
            if (err instanceof Error && err.code !== "ENOENT") {
                console.warn(`[agent-team] Failed to load team state from ${filePath}: ${err.message}`);
            }
        }
    }
    async saveToDisk(stateDir) {
        const dirPath = path.join(stateDir, TEAM_DIR_NAME);
        const filePath = path.join(dirPath, STATE_FILE);
        const tmpPath = filePath + ".tmp";
        const data = {
            version: 1,
            teams: [...this.teams.values()],
        };
        await fs.mkdir(dirPath, { recursive: true });
        // Atomic write: write to temp file first, then rename to avoid corruption.
        await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
        await fs.rename(tmpPath, filePath);
    }
}
