import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-team";
import { TEAM_DIR_NAME } from "../constants.js";
import type { TeamStateManager } from "../team-state.js";

const TeamCleanupSchema = Type.Object(
  { team_id: Type.String({ description: "ID of the team to clean up and remove." }) },
  { additionalProperties: false },
);

export type RuntimeConfig = {
  loadConfig: () => Record<string, unknown>;
  writeConfigFile: (cfg: Record<string, unknown>) => Promise<void>;
};

export type PruneAgentConfigFn = (
  cfg: Record<string, unknown>,
  agentId: string,
) => { config: Record<string, unknown>; removedBindings: number; removedAllow: number };

export function createTeamCleanupToolCompat(
  teamState: TeamStateManager,
  stateDir: string,
  runtimeConfig: RuntimeConfig,
  pruneAgentConfigFn: PruneAgentConfigFn,
): AnyAgentTool {
  return {
    name: "team_cleanup",
    description:
      "Remove a team: remove the agent from config, clean up the workspace directory, and clear team state.",
    parameters: TeamCleanupSchema,
    async execute(_toolCallId: string, params: { team_id: string }) {
      const { team_id } = params;
      const team = teamState.getTeam(team_id);
      if (!team) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Team "${team_id}" not found.` }) }],
        };
      }

      const results: string[] = [];

      // Remove Leader from config.
      try {
        const cfg = runtimeConfig.loadConfig();
        const { config: nextCfg, removedBindings, removedAllow } = pruneAgentConfigFn(
          cfg as Record<string, unknown>,
          team.leaderAgentId,
        );
        await runtimeConfig.writeConfigFile(nextCfg);
        results.push(`Agent config pruned (${removedBindings} bindings, ${removedAllow} allow entries removed).`);
      } catch (err) {
        results.push(`Config cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Keep workspace directory so that generated artifacts remain accessible.
      const teamDir = path.join(stateDir, TEAM_DIR_NAME, team_id);
      results.push(`Workspace preserved at: ${teamDir}`);

      // Remove from state.
      teamState.removeTeam(team_id);
      results.push("Team state cleared.");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ teamId: team_id, status: "cleaned", details: results }, null, 2),
          },
        ],
      };
    },
  } as AnyAgentTool;
}
