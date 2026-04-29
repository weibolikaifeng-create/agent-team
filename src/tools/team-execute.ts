import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-team";
import type { TeamStateManager } from "../team-state.js";
import { TEAM_DIR_NAME, EXECUTIONS_DIR, TODO_FILE, OUTPUT_DIR } from "../constants.js";

const ChannelInfoSchema = Type.Object({
  channel: Type.String({ description: "Channel type: feishu, discord, slack, etc." }),
  target: Type.String({ description: "User or channel ID to send messages to." }),
  msg_id: Type.Optional(Type.String({ description: "Original message ID (for reply/react actions)." })),
});

const TeamExecuteSchema = Type.Object(
  {
    team_id: Type.String({ description: "ID of the team to execute." }),
    task: Type.String({ description: "Task message to send to the Leader agent." }),
    task_name: Type.Optional(
      Type.String({ description: "Short task name for display (max 15 chars). AI-generated summary of the task." }),
    ),
    steps: Type.Array(Type.String(), {
      description:
        'Task-specific step descriptions for todo.md progress tracking. Structure: (1) 1-2 general preparation steps (e.g. team setup, task breakdown), (2) one step per team worker matching their role and responsibility — use the worker\'s role name as prefix followed by their specific task from this execution (e.g. "Search Specialist 1: Research DeepSeek V4 architecture and MoE design"). The number of worker steps MUST equal the number of workers in the team, and each step should correspond to one worker. Do NOT add extra steps for roles that don\'t exist in the team. Example for a team with [Search Specialist 1, Search Specialist 2, Report Writer]: ["Set up agent team", "Break down tasks and assign roles", "Search Specialist 1: Research DeepSeek V4 architecture and MoE design", "Search Specialist 2: Research DeepSeek V4 training methods and performance", "Report Writer: Synthesize findings into DeepSeek V4 technical report"].',
    }),
    channel_info: ChannelInfoSchema,
  },
  { additionalProperties: false },
);

type ChannelInfo = { channel: string; target: string; msg_id?: string };
type TeamExecuteParams = {
  team_id: string;
  task: string;
  task_name?: string;
  steps: string[];
  channel_info: ChannelInfo;
};

export function createTeamExecuteToolCompat(teamState: TeamStateManager, stateDir: string): AnyAgentTool {
  return {
    name: "team_execute",
    description:
      "Start a team execution. Creates an execution instance with todo.md and output/ directory. Returns the sessions_send parameters you must call to activate the Leader agent. The Leader will push progress updates directly to the channel using the message tool.",
    parameters: TeamExecuteSchema,
    async execute(_toolCallId: string, params: TeamExecuteParams) {
      const { team_id, task, channel_info } = params;
      const team = teamState.getTeam(team_id);
      if (!team) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Team "${team_id}" not found. Use team_provision first.` }) }],
        };
      }
      if (team.status !== "ready" && team.status !== "running") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Team "${team_id}" is in "${team.status}" state. Expected "ready" or "running".` }) }],
        };
      }

      // Check if there's already a running execution.
      const hasRunningExecution = team.executions.some((e) => e.status === "running");
      if (hasRunningExecution) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Team "${team_id}" already has a running execution. Wait for it to complete before starting a new one.`,
              }),
            },
          ],
        };
      }

      // Resolve steps from required parameter.
      const steps = params.steps;

      // Generate execution instance.
      const executionId = teamState.getNextExecutionId(team_id);
      const execDir = path.join(stateDir, TEAM_DIR_NAME, team_id, EXECUTIONS_DIR, executionId);
      const outputDir = path.join(execDir, OUTPUT_DIR);

      // Create execution directory and output directory.
      await fs.mkdir(outputDir, { recursive: true });

      // Initialize todo.md with steps in pending state.
      const taskName = params.task_name ?? team.teamName;
      const todoLines = [
        `# ${taskName}`,
        "",
        ...steps.map((s) => `- [ ] ${s}`),
      ];
      await fs.writeFile(path.join(execDir, TODO_FILE), todoLines.join("\n"), "utf-8");

      // Record execution instance.
      teamState.addExecution(team_id, {
        executionId,
        taskPrompt: task,
        taskName,
        status: "running",
        createdAt: new Date().toISOString(),
      });
      teamState.updateStatus(team_id, "running");
      await teamState.saveToDisk(stateDir);

      // Embed channel_info and executionId into the task message so the Leader knows where to push progress updates
      const taskWithCallback =
        `__channelInfo__: ${JSON.stringify(channel_info)}\n` +
        `__executionId__: ${executionId}\n` +
        `__execDir__: ${execDir}\n\n${task}`;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                teamId: team_id,
                teamName: team.teamName,
                leaderAgentId: team.leaderAgentId,
                executionId,
                execDir,
                action_required:
                  "CRITICAL: The team has NOT started yet. You MUST call sessions_send immediately with the parameters below to activate the Leader.\n\n" +
                  "STEP 1 — Call sessions_send with the parameters in 'sessions_send_params'. " +
                  "This is a FIRE-AND-FORGET call (timeoutSeconds=0) — it returns immediately.\n\n" +
                  "STEP 2 — After sessions_send returns, inform the user that the team is now working and END YOUR TURN. " +
                  "The Leader will directly push progress updates and final results to the channel. " +
                  "You do NOT need to relay messages — the Leader handles channel communication.",
                sessions_send_params: {
                  agentId: team.leaderAgentId,
                  task: taskWithCallback,
                  sessionKey: `agent:${team.leaderAgentId}:${team.leaderAgentId}`,
                  timeoutSeconds: 0,
                },
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

