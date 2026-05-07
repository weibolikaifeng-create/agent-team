import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-team";
import { readStateFromDisk, writeStateToDisk, getNextExecutionId } from "../team-state.js";
import { TEAM_DIR_NAME, EXECUTIONS_DIR, TODO_FILE, OUTPUT_DIR } from "../constants.js";

const ChannelInfoSchema = Type.Object({
  channel: Type.String({ description: "Channel type: feishu, discord, slack, etc." }),
  target: Type.String({ description: "User or channel ID to send messages to." }),
  msg_id: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Original message ID (for reply/react actions)." })),
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
        'Array of step descriptions for progress tracking. Include 1-2 preparation steps (e.g., "Set up agent team", "Break down tasks"), then one step per worker with their specific task. Example: ["Set up agent team", "Break down tasks and assign roles", "Search Specialist 1: Research DeepSeek V4 architecture", "Search Specialist 2: Research DeepSeek V4 training methods", "Report Writer: Write technical comparison report"]',
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

export function createTeamExecuteToolCompat(stateDir: string): AnyAgentTool {
  return {
    name: "team_execute",
    description:
      "Start a team execution. Creates an execution instance with todo.md and output/ directory. Returns the sessions_send parameters you must call to activate the Leader agent. The Leader will push progress updates directly to the channel using the message tool.",
    parameters: TeamExecuteSchema,
    async execute(_toolCallId: string, params: TeamExecuteParams) {
      const { team_id, task, channel_info } = params;

      // Read latest state from disk.
      const state = await readStateFromDisk(stateDir);
      const team = state.teams.find((t) => t.teamId === team_id);
      if (!team) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Team "${team_id}" not found. Use team_provision first.` }) }],
        };
      }

      // Check team status
      if (team.status !== "ready") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Team "${team_id}" is in "${team.status}" state. Expected "ready". Wait for current execution to complete or call team_cleanup to reset.`,
              }),
            },
          ],
        };
      }

      // Check if there's already a running execution
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
      const executionId = getNextExecutionId(team);
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

      // Record execution and update status — write back to disk.
      team.executions.push({
        executionId,
        taskPrompt: task,
        taskName,
        status: "running",
        createdAt: new Date().toISOString(),
      });
      team.currentExecutionId = executionId;
      team.status = "running";
      await writeStateToDisk(stateDir, state);

      // Embed channel_info and executionId into the task message so the Leader knows where to push progress updates
      // Embed channel info, team ID, execution ID, and exec dir into the task message
      const taskWithCallback =
        `__teamId__: ${team_id}\n` +
        `__executionId__: ${executionId}\n` +
        `__execDir__: ${execDir}\n` +
        `__channelInfo__: ${JSON.stringify(channel_info)}\n\n${task}`;

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

