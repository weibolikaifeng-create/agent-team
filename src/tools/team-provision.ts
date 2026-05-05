import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-team";
import { TEAM_DIR_NAME, MAX_WORKERS, MAX_SPAWN_DEPTH, EXECUTIONS_DIR } from "../constants.js";
import { generateSoulMd, generateAgentsMd } from "../soul-generator.js";
import { readStateFromDisk, writeStateToDisk } from "../team-state.js";
import type { TeamRecord } from "../team-state.js";
import type { CollaborationMode, WorkerSpec } from "../templates.js";
import { TEMPLATES } from "../templates.js";

function stringEnum<T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    description,
  });
}

const WorkerSchema = Type.Object({
  id: Type.String({ description: "Worker identifier (lowercase, no spaces)." }),
  role: Type.String({ description: "Worker role name." }),
  responsibility: Type.String({ description: "What this worker does." }),
});

const TeamProvisionSchema = Type.Object(
  {
    team_id: Type.String({
      description: "Unique team identifier (lowercase alphanumeric with hyphens).",
    }),
    team_name: Type.Optional(Type.String({ description: "Human-readable team name." })),
    template_id: Type.Optional(
      Type.String({
        description:
          "Template ID to use. If omitted, leader/workers/collaboration_mode must be provided.",
      }),
    ),
    leader_role: Type.Optional(Type.String({ description: "Custom leader role name." })),
    leader_personality: Type.Optional(
      Type.String({ description: "Custom leader personality description." }),
    ),
    leader_core_instruction: Type.Optional(
      Type.String({ description: "Custom core instruction for the leader." }),
    ),
    workers: Type.Optional(
      Type.Array(WorkerSchema, {
        description: "Custom worker definitions. Overrides template workers. For mapreduce and supervisor modes, no more than 3 workers should run in parallel at the same time — this is a concurrency limit, not a total limit (e.g. 3 parallel search workers + 1 sequential writer is fine; 4 simultaneous search workers is not).",
      }),
    ),
    collaboration_mode: Type.Optional(
      stringEnum(
        ["pipeline", "mapreduce", "supervisor"] as const,
        "How workers collaborate. Required if no template_id.",
      ),
    ),
    task: Type.String({
      description: "The task this team will work on.",
    }),
    session_key: Type.String({
      description: "Session key to bind this team to the current session. Required for session-based team filtering. If the task originates from a channel (feishu, discord, slack, etc.), you MUST use the channel-bound session key, not the default 'main' session key.",
    }),
  },
  { additionalProperties: false },
);

type TeamProvisionParams = {
  team_id: string;
  team_name?: string;
  template_id?: string;
  leader_role?: string;
  leader_personality?: string;
  leader_core_instruction?: string;
  workers?: WorkerSpec[];
  collaboration_mode?: CollaborationMode;
  task: string;
  session_key: string;
};

type RuntimeConfig = {
  loadConfig: () => Record<string, unknown>;
  writeConfigFile: (cfg: Record<string, unknown>) => Promise<void>;
};

type ApplyAgentConfigFn = (
  cfg: Record<string, unknown>,
  params: {
    agentId: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string;
  },
) => Record<string, unknown>;

export function createTeamProvisionTool(
  stateDir: string,
  runtimeConfig: RuntimeConfig,
  applyAgentConfig: ApplyAgentConfigFn,
): AnyAgentTool {
  return {
    name: "team_provision",
    description:
      "Create a new multi-agent team. Provisions a Leader agent with workspace, SOUL.md, and AGENTS.md. The Leader will orchestrate workers via sessions_spawn.",
    parameters: TeamProvisionSchema,
    async execute(_toolCallId: string, params: TeamProvisionParams) {
      const { task } = params;

      // Auto-append short UUID suffix to ensure uniqueness.
      const suffix = crypto.randomBytes(3).toString("hex");
      const team_id = `${params.team_id}-${suffix}`;

      // Resolve template or custom config.
      const template = params.template_id
        ? TEMPLATES.find((t) => t.id === params.template_id)
        : undefined;

      if (params.template_id && !template) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Template "${params.template_id}" not found.`,
                availableTemplates: TEMPLATES.map((t) => t.id),
              }),
            },
          ],
        };
      }

      const leaderRole = params.leader_role ?? template?.leader.role ?? "Team Leader";
      const leaderPersonality =
        params.leader_personality ??
        template?.leader.personality ??
        "Professional, organized, results-oriented.";
      const coreInstruction =
        params.leader_core_instruction ??
        template?.leader.coreInstruction ??
        "Coordinate team workers to accomplish the task.";
      const workers: WorkerSpec[] = params.workers ?? template?.workers ?? [];
      const collaborationMode: CollaborationMode =
        params.collaboration_mode ?? template?.collaborationMode ?? "supervisor";
      const modeInstruction =
        template?.modeInstruction ?? "Manage workers based on the collaboration mode.";
      const teamName = params.team_name ?? template?.name ?? `Team ${team_id}`;

      if (workers.length > MAX_WORKERS) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Too many workers (${workers.length}). Maximum is ${MAX_WORKERS}.`,
              }),
            },
          ],
        };
      }

      const leaderAgentId = `leader-${team_id}`;
      const teamDir = path.join(stateDir, TEAM_DIR_NAME, team_id);
      const workspaceDir = path.join(teamDir, "workspace");

      // Create workspace directory.
      await fs.mkdir(workspaceDir, { recursive: true });

      // Create subdirectories for file organization
      await fs.mkdir(path.join(workspaceDir, "outputs"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, "scratch"), { recursive: true });

      // Create executions directory for execution instances.
      await fs.mkdir(path.join(teamDir, EXECUTIONS_DIR), { recursive: true });

      // Generate and write SOUL.md.
      const soulContent = generateSoulMd({
        teamId: team_id,
        teamName,
        leaderRole,
        leaderPersonality,
        coreInstruction,
        workers,
        collaborationMode,
        modeInstruction,
        task,
      });
      await fs.writeFile(path.join(workspaceDir, "SOUL.md"), soulContent, "utf-8");

      // Generate and write AGENTS.md + symlink CLAUDE.md.
      const agentsContent = generateAgentsMd({
        teamId: team_id,
        teamName,
        leaderRole,
        workers,
      });
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), agentsContent, "utf-8");
      const claudeMdPath = path.join(workspaceDir, "CLAUDE.md");
      try {
        await fs.symlink("AGENTS.md", claudeMdPath);
      } catch (err) {
        // Ignore if symlink already exists, but log other errors.
        if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "EEXIST") {
          console.warn(`[agent-team] Failed to create CLAUDE.md symlink: ${err.message}`);
        }
      }

      // Register the Leader agent in config.
      const cfg = runtimeConfig.loadConfig();
      let nextCfg = applyAgentConfig(cfg, {
        agentId: leaderAgentId,
        name: teamName,
        workspace: workspaceDir,
      });

      // Ensure subagents can spawn deep enough: Leader (depth 1) → Workers (depth 2+).
      const agentsObj = (nextCfg as Record<string, Record<string, unknown>>).agents ?? {};
      const agentDefaults = (agentsObj.defaults as Record<string, unknown>) ?? {};
      const subagentDefaults = (agentDefaults.subagents as Record<string, unknown>) ?? {};
      const currentDepth = typeof subagentDefaults.maxSpawnDepth === "number"
        ? subagentDefaults.maxSpawnDepth
        : 0;
      if (currentDepth < MAX_SPAWN_DEPTH) {
        nextCfg = {
          ...nextCfg,
          agents: {
            ...agentsObj,
            defaults: {
              ...agentDefaults,
              subagents: { ...subagentDefaults, maxSpawnDepth: MAX_SPAWN_DEPTH },
            },
            list: agentsObj.list,
          },
        };
      }

      // Add Leader and main to A2A allow list and ensure A2A is enabled.
      const tools = (nextCfg as Record<string, Record<string, unknown>>).tools ?? {};
      const a2a = (tools.agentToAgent as Record<string, unknown>) ?? {};
      const allow = Array.isArray(a2a.allow) ? [...a2a.allow] : [];
      if (!allow.includes("main")) {
        allow.push("main");
      }
      if (!allow.includes(leaderAgentId)) {
        allow.push(leaderAgentId);
      }
      const sessions = (tools.sessions as Record<string, unknown>) ?? {};
      nextCfg = {
        ...nextCfg,
        tools: {
          ...tools,
          agentToAgent: { ...a2a, enabled: true, allow },
          sessions: { ...sessions, visibility: "all" },
        },
      };

      await runtimeConfig.writeConfigFile(nextCfg);

      // Brief delay for the gateway file watcher to pick up changes.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Record team state — read from disk, append, write back.
      const state = await readStateFromDisk(stateDir);
      const newTeam: TeamRecord = {
        teamId: team_id,
        teamName,
        templateId: params.template_id ?? "custom",
        leaderAgentId,
        workers,
        collaborationMode,
        status: "ready",
        createdAt: new Date().toISOString(),
        sessionKey: params.session_key,
        executions: [],
      };
      state.teams.push(newTeam);
      await writeStateToDisk(stateDir, state);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                teamId: team_id,
                teamName,
                leaderAgentId,
                workspaceDir,
                collaborationMode,
                workerInfo: workers.map((w) => w.role).join(", "),
                status: "ready",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  } as AnyAgentTool;
}
