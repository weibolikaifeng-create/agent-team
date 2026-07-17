import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import lockfile from "proper-lockfile";
import { readStateFromDisk, type TeamRecord } from "../team-state.js";
import { STATE_FILE, TEAM_DIR_NAME } from "../constants.js";
import { ARTIFACTS_SCHEMA_VERSION } from "./constants.js";
import { membersPath } from "./paths.js";

/**
 * Member registry for agent-team (dynamic mode).
 *
 * Two identity systems exist and never meet on their own:
 *  - logical identity (`memberId` = workerId, defined by the plugin);
 *  - runtime identity (`sessionKey` = childSessionKey, minted by OpenClaw at
 *    spawn time and recorded nowhere in the team state file).
 *
 * `subagent_spawned` is the ONLY moment both are visible together, so we persist
 * the mapping into `members.json` there. Because the mapping records the ACTUAL
 * runtime childSessionKey (not a pre-registered guess), agent-team has no
 * "leader started the member with a different sessionKey" short-circuit — the
 * problem that affected static-team.
 *
 * Short-circuit fact (state doc 2.2): the leader and ALL workers share the same
 * OpenClaw agentId (`leader-{teamId}`), because workers are same-agent subagent
 * sessions. So `sessionKey.split(":")[1]` equals the team's leaderAgentId for
 * every member — a cheap, reliable "is this a team session?" test.
 */

// ── on-disk members.json shape (doc §4.3) ────────────────────────────

type LeaderEntry = {
  memberId: "leader";
  name: string;
  sessionKey: string;
  registeredAt: string;
};

type WorkerEntry = {
  memberId: string;
  name: string;
  sessionKey: string;
  label?: string;
  runId?: string;
  registeredAt: string;
};

type MembersExecution = {
  executionId: string;
  workers: WorkerEntry[];
};

type MembersFile = {
  schemaVersion: number;
  teamId: string;
  leaderAgentId: string;
  updatedAt: string;
  leader?: LeaderEntry;
  executions: MembersExecution[];
};

// ── resolved identity returned to the capture / label layers ─────────

export type MemberRole = "leader" | "worker";

export type MemberIdentity = {
  teamId: string;
  leaderAgentId: string;
  role: MemberRole;
  memberId: string;
  name: string;
  /** Worker: its registered execution; Leader: the team's currentExecutionId. */
  executionId?: string;
  /** createdAt (ms) of that execution — the mtime cutoff for "new this run". */
  execCreatedAtMs?: number;
  taskName?: string;
};

// ── team metadata derived from the existing state file ───────────────

type ExecMeta = { createdAtMs: number; taskName?: string };

type TeamMeta = {
  teamId: string;
  leaderAgentId: string;
  leaderName: string;
  currentExecutionId?: string;
  executionsById: Map<string, ExecMeta>;
  /** WorkerSpec id -> display name, for resolving a workerId to a readable name. */
  workerSpecNames: Map<string, string>;
};

function buildTeamMeta(team: TeamRecord): TeamMeta {
  const executionsById = new Map<string, ExecMeta>();
  for (const e of team.executions) {
    const ms = Date.parse(e.createdAt);
    executionsById.set(e.executionId, {
      createdAtMs: Number.isFinite(ms) ? ms : 0,
      taskName: e.taskName,
    });
  }
  const workerSpecNames = new Map<string, string>();
  for (const w of team.workers) workerSpecNames.set(w.id, w.name);
  return {
    teamId: team.teamId,
    leaderAgentId: team.leaderAgentId,
    leaderName: team.leaderName || team.leaderAgentId,
    currentExecutionId: team.currentExecutionId,
    executionsById,
    workerSpecNames,
  };
}

// ── caches (mtime-invalidated, like static-team's team-index) ─────────

function statePath(stateDir: string): string {
  return path.join(stateDir, TEAM_DIR_NAME, STATE_FILE);
}

type StateCache = {
  mtimeMs: number;
  teams: Map<string, TeamMeta>;
  leaderIdToTeam: Map<string, string>;
};
let stateCache: StateCache | null = null;

// Per-team parsed members.json, invalidated by the file's mtime.
const membersCache = new Map<string, { mtimeMs: number; file: MembersFile }>();

async function refreshState(stateDir: string): Promise<StateCache | null> {
  const file = statePath(stateDir);
  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    return null; // no state file -> no teams
  }
  if (stateCache && stateCache.mtimeMs === mtimeMs) return stateCache;

  const state = await readStateFromDisk(stateDir);
  const teams = new Map<string, TeamMeta>();
  const leaderIdToTeam = new Map<string, string>();
  for (const team of state.teams) {
    const meta = buildTeamMeta(team);
    teams.set(team.teamId, meta);
    if (team.leaderAgentId) leaderIdToTeam.set(team.leaderAgentId, team.teamId);
  }
  stateCache = { mtimeMs, teams, leaderIdToTeam };
  return stateCache;
}

function emptyMembersFile(teamId: string, leaderAgentId: string): MembersFile {
  return {
    schemaVersion: ARTIFACTS_SCHEMA_VERSION,
    teamId,
    leaderAgentId,
    updatedAt: new Date().toISOString(),
    executions: [],
  };
}

async function readMembersFile(stateDir: string, teamId: string): Promise<MembersFile | undefined> {
  try {
    const raw = await fs.readFile(membersPath(stateDir, teamId), "utf-8");
    const data = JSON.parse(raw) as MembersFile;
    if (data && Array.isArray(data.executions)) return data;
    return undefined;
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Load a team's members.json into cache, reloading only when its mtime changed. */
async function refreshMembers(stateDir: string, teamId: string, leaderAgentId: string): Promise<MembersFile> {
  const file = membersPath(stateDir, teamId);
  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    // Not created yet — treat as empty; do not cache (so the first write is seen).
    return emptyMembersFile(teamId, leaderAgentId);
  }
  const cached = membersCache.get(teamId);
  if (cached && cached.mtimeMs === mtimeMs) return cached.file;
  const parsed = (await readMembersFile(stateDir, teamId)) ?? emptyMembersFile(teamId, leaderAgentId);
  membersCache.set(teamId, { mtimeMs, file: parsed });
  return parsed;
}

// ── members.json writes (locked + atomic, mirrors manifest.ts) ───────

async function ensureMembersFileExists(file: string, teamId: string, leaderAgentId: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.access(file);
  } catch {
    try {
      await fs.writeFile(file, JSON.stringify(emptyMembersFile(teamId, leaderAgentId), null, 2), {
        encoding: "utf-8",
        flag: "wx",
      });
    } catch {
      // created concurrently — ignore
    }
  }
}

async function updateMembers(
  stateDir: string,
  teamId: string,
  leaderAgentId: string,
  mutate: (file: MembersFile) => void,
): Promise<void> {
  const file = membersPath(stateDir, teamId);
  await ensureMembersFileExists(file, teamId, leaderAgentId);
  const release = await lockfile.lock(file, {
    retries: { retries: 20, minTimeout: 100, maxTimeout: 1000, randomize: true },
  });
  try {
    const current = (await readMembersFile(stateDir, teamId)) ?? emptyMembersFile(teamId, leaderAgentId);
    mutate(current);
    current.updatedAt = new Date().toISOString();
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(current, null, 2), "utf-8");
    await fs.rename(tmp, file);
    // Refresh cache to the value we just wrote so our own write doesn't force a
    // reload on the next resolve (mtime will match on the next stat).
    try {
      const mtimeMs = (await fs.stat(file)).mtimeMs;
      membersCache.set(teamId, { mtimeMs, file: current });
    } catch {
      membersCache.delete(teamId);
    }
  } finally {
    await release();
  }
}

function findWorker(file: MembersFile, sessionKey: string): { worker: WorkerEntry; executionId: string } | undefined {
  for (const exec of file.executions) {
    for (const w of exec.workers) {
      if (w.sessionKey === sessionKey) return { worker: w, executionId: exec.executionId };
    }
  }
  return undefined;
}

function execMeta(meta: TeamMeta, executionId?: string): ExecMeta | undefined {
  return executionId ? meta.executionsById.get(executionId) : undefined;
}

function leaderKeyOf(leaderAgentId: string): string {
  return `agent:${leaderAgentId}:${leaderAgentId}`;
}

function shortHash(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 8);
}

// Leaders we've already tried to persist this process (avoid rewriting on every
// leader tool call — resolution never depends on this, it's for reverse-lookup).
const leaderRegistered = new Set<string>();

// ── public API ───────────────────────────────────────────────────────

/**
 * Resolve a runtime sessionKey to its team-member identity.
 *
 * Order (doc §2.4):
 *  1. sessionKey found in members.json workers → known worker.
 *  2. sessionKey is the deterministic leader key → leader (lazily registered).
 *  3. agentId matches a leaderAgentId but sessionKey is unknown → unregistered
 *     worker → anonymously registered so future hooks hit case 1.
 *  4. agentId is not a known leaderAgentId → not a team session → undefined.
 */
export async function resolveMemberBySessionKey(
  stateDir: string,
  sessionKey: string | undefined,
): Promise<MemberIdentity | undefined> {
  if (!sessionKey) return undefined;
  const state = await refreshState(stateDir);
  if (!state) return undefined;

  const agentId = sessionKey.split(":")[1];
  if (!agentId) return undefined;
  const teamId = state.leaderIdToTeam.get(agentId);
  if (!teamId) return undefined; // NON-TEAM short-circuit
  const meta = state.teams.get(teamId);
  if (!meta) return undefined;

  const file = await refreshMembers(stateDir, teamId, meta.leaderAgentId);

  // Case 1: known worker.
  const hit = findWorker(file, sessionKey);
  if (hit) {
    const em = execMeta(meta, hit.executionId);
    return {
      teamId,
      leaderAgentId: meta.leaderAgentId,
      role: "worker",
      memberId: hit.worker.memberId,
      name: hit.worker.name,
      executionId: hit.executionId,
      execCreatedAtMs: em?.createdAtMs,
      taskName: em?.taskName,
    };
  }

  // Case 2: leader (deterministic key).
  if (sessionKey === leaderKeyOf(meta.leaderAgentId)) {
    void ensureLeaderRegistered(stateDir, meta, sessionKey);
    const em = execMeta(meta, meta.currentExecutionId);
    return {
      teamId,
      leaderAgentId: meta.leaderAgentId,
      role: "leader",
      memberId: "leader",
      name: meta.leaderName,
      executionId: meta.currentExecutionId,
      execCreatedAtMs: em?.createdAtMs,
      taskName: em?.taskName,
    };
  }

  // Case 3: unregistered worker — subagent_spawned was missed. Anonymously
  // register so its products are still captured under a stable memberId.
  const executionId = meta.currentExecutionId;
  const memberId = `unknown-${shortHash(sessionKey)}`;
  await registerWorkerEntry(stateDir, meta, {
    memberId,
    name: memberId,
    sessionKey,
    executionId,
  });
  const em = execMeta(meta, executionId);
  return {
    teamId,
    leaderAgentId: meta.leaderAgentId,
    role: "worker",
    memberId,
    name: memberId,
    executionId,
    execCreatedAtMs: em?.createdAtMs,
    taskName: em?.taskName,
  };
}

/** Strip the known prefix `team-{teamId}-` from a spawn label to get the workerId. */
function parseWorkerId(label: string | undefined, teamId: string): string | undefined {
  if (!label) return undefined;
  const prefix = `team-${teamId}-`;
  if (!label.startsWith(prefix)) return undefined;
  const rest = label.slice(prefix.length);
  return rest || undefined;
}

/**
 * Register a worker from a `subagent_spawned` event — the one moment both the
 * runtime childSessionKey and the logical label are visible together.
 */
export async function registerWorkerFromSpawn(
  stateDir: string,
  event: { agentId?: string; label?: string; childSessionKey?: string; runId?: string },
  ctx: { requesterSessionKey?: string },
): Promise<void> {
  const state = await refreshState(stateDir);
  if (!state) return;
  const agentId = event.agentId;
  const sessionKey = event.childSessionKey;
  if (!agentId || !sessionKey) return;
  const teamId = state.leaderIdToTeam.get(agentId);
  if (!teamId) return; // not one of our teams
  const meta = state.teams.get(teamId);
  if (!meta) return;

  let executionId = meta.currentExecutionId;
  let workerId = parseWorkerId(event.label, teamId);

  // Label missing / malformed: try to inherit from the spawning member
  // (multi-level spawn), else fall back to a stable anonymous id.
  if (!workerId) {
    const requester = ctx.requesterSessionKey
      ? await resolveMemberBySessionKey(stateDir, ctx.requesterSessionKey)
      : undefined;
    if (requester && requester.role === "worker") {
      workerId = requester.memberId;
      executionId = requester.executionId ?? executionId;
    } else {
      workerId = `unknown-${shortHash(sessionKey)}`;
    }
  }

  const name = meta.workerSpecNames.get(workerId) ?? workerId;
  await registerWorkerEntry(stateDir, meta, {
    memberId: workerId,
    name,
    sessionKey,
    executionId,
    label: event.label,
    runId: event.runId,
  });
}

async function registerWorkerEntry(
  stateDir: string,
  meta: TeamMeta,
  entry: { memberId: string; name: string; sessionKey: string; executionId?: string; label?: string; runId?: string },
): Promise<void> {
  const executionId = entry.executionId || "unassigned";
  await updateMembers(stateDir, meta.teamId, meta.leaderAgentId, (file) => {
    // Idempotent: skip if this exact runtime sessionKey is already registered.
    if (findWorker(file, entry.sessionKey)) return;
    let exec = file.executions.find((e) => e.executionId === executionId);
    if (!exec) {
      exec = { executionId, workers: [] };
      file.executions.push(exec);
    }
    exec.workers.push({
      memberId: entry.memberId,
      name: entry.name,
      sessionKey: entry.sessionKey,
      label: entry.label,
      runId: entry.runId,
      registeredAt: new Date().toISOString(),
    });
  });
}

async function ensureLeaderRegistered(stateDir: string, meta: TeamMeta, sessionKey: string): Promise<void> {
  if (leaderRegistered.has(meta.teamId)) return;
  leaderRegistered.add(meta.teamId);
  try {
    await updateMembers(stateDir, meta.teamId, meta.leaderAgentId, (file) => {
      if (file.leader) return;
      file.leader = {
        memberId: "leader",
        name: meta.leaderName,
        sessionKey,
        registeredAt: new Date().toISOString(),
      };
    });
  } catch {
    // best-effort; resolution never depends on the persisted leader record
    leaderRegistered.delete(meta.teamId);
  }
}

/**
 * Describe the owner of an `output/{X}/` directory for the path-ownership
 * override. `X` is `leader` or a workerId. Uses warm caches (resolve ran first
 * in the same capture flow); falls back to WorkerSpec names, then to the raw id.
 */
export function describeOutputOwner(
  teamId: string,
  memberId: string,
): { role: MemberRole; memberId: string; name: string } | undefined {
  const meta = stateCache?.teams.get(teamId);
  if (!meta) return undefined;
  if (memberId === "leader") {
    return { role: "leader", memberId: "leader", name: meta.leaderName };
  }
  // Prefer a name learned from members.json; fall back to the WorkerSpec name.
  const cached = membersCache.get(teamId)?.file;
  let name: string | undefined;
  if (cached) {
    for (const exec of cached.executions) {
      const w = exec.workers.find((x) => x.memberId === memberId);
      if (w) {
        name = w.name;
        break;
      }
    }
  }
  name = name ?? meta.workerSpecNames.get(memberId) ?? memberId;
  return { role: "worker", memberId, name };
}

/** createdAt (ms) of a given execution, for the mtime cutoff during attribution. */
export function executionCreatedAtMs(teamId: string, executionId: string | undefined): number | undefined {
  if (!executionId) return undefined;
  return stateCache?.teams.get(teamId)?.executionsById.get(executionId)?.createdAtMs;
}
