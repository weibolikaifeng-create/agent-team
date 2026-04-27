import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-team";
import type { TeamStateManager } from "../team-state.js";

const ChannelInfoSchema = Type.Object({
  channel: Type.String({ description: "Channel type: feishu, discord, slack, etc." }),
  target: Type.String({ description: "User or channel ID to send messages to." }),
  msg_id: Type.Optional(Type.String({ description: "Original message ID (for reply/react actions)." })),
});

const TeamExecuteSchema = Type.Object(
  {
    team_id: Type.String({ description: "ID of the team to execute." }),
    task: Type.String({ description: "Task message to send to the Leader agent." }),
    channel_info: ChannelInfoSchema,
  },
  { additionalProperties: false },
);

type ChannelInfo = { channel: string; target: string; msg_id?: string };

export function createTeamExecuteToolCompat(teamState: TeamStateManager): AnyAgentTool {
  return {
    name: "team_execute",
    description:
      "Start a team execution. Returns the sessions_send parameters you must call to activate the Leader agent. The Leader will push progress updates directly to the channel using the message tool.",
    parameters: TeamExecuteSchema,
    async execute(_toolCallId: string, params: { team_id: string; task: string; channel_info: ChannelInfo }) {
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

      teamState.updateStatus(team_id, "running");

      // Embed channel_info into the task message so the Leader knows where to push progress updates
      const taskWithCallback = `__channelInfo__: ${JSON.stringify(channel_info)}\n\n${task}`;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                teamId: team_id,
                teamName: team.teamName,
                leaderAgentId: team.leaderAgentId,
                status: "running",
                action_required:
                  "You MUST execute ONE tool call, then END YOUR TURN:\n\n" +
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
