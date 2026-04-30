import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-team";
import { readStateFromDisk, writeStateToDisk } from "../team-state.js";

const TeamCompleteSchema = Type.Object(
  {
    team_id: Type.String({
      description: "Team ID (from __teamId__ in task message).",
    }),
    execution_id: Type.String({
      description: "Execution ID (from __executionId__ in task message).",
    }),
  },
  { additionalProperties: false },
);

type TeamCompleteParams = {
  team_id: string;
  execution_id: string;
};

export function createTeamCompleteTool(stateDir: string): AnyAgentTool {
  return {
    name: "team_complete",
    description:
      "Mark a team execution as completed. MUST be called by Leader agent when all work is finished. This updates execution status and allows the team to be reused.",
    parameters: TeamCompleteSchema,
    async execute(_toolCallId: string, params: TeamCompleteParams) {
      const { team_id, execution_id } = params;

      // 1. Read state file from disk
      let data;
      try {
        data = await readStateFromDisk(stateDir);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to read team state file: ${(err as Error).message}`,
              }),
            },
          ],
        };
      }

      // 2. Find team
      const team = data.teams.find((t) => t.teamId === team_id);
      if (!team) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Team "${team_id}" not found.`,
              }),
            },
          ],
        };
      }

      // 3. Find execution record
      const execution = team.executions?.find((e) => e.executionId === execution_id);
      if (!execution) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Execution "${execution_id}" not found in team "${team_id}".`,
              }),
            },
          ],
        };
      }

      // 4. Update execution status (idempotent)
      if (execution.status === "completed") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "Execution already completed.",
                teamId: team_id,
                executionId: execution_id,
                teamStatus: team.status,
              }),
            },
          ],
        };
      }

      execution.status = "completed";
      execution.completedAt = new Date().toISOString();

      // 5. Clear currentExecutionId
      if (team.currentExecutionId === execution_id) {
        team.currentExecutionId = undefined;
      }

      // 6. Update team status
      const hasRunning = team.executions.some((e) => e.status === "running");
      if (!hasRunning) {
        team.status = "ready";
      }

      // 7. Write back to disk
      await writeStateToDisk(stateDir, data);

      // 8. Return success
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                teamId: team_id,
                executionId: execution_id,
                teamStatus: team.status,
                message: "Execution marked as completed. Team is now available for reuse.",
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
