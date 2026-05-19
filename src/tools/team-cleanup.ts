import path from "node:path";
import { Type } from "typebox";
import type { AnyAgentTool } from "../types.js";
import { TEAM_DIR_NAME } from "../constants.js";
import { readStateFromDisk, writeStateToDisk } from "../team-state.js";

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

      // Read latest state from disk.
      const state = await readStateFromDisk(stateDir);
      const team = state.teams.find((t) => t.teamId === team_id);
      if (!team) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Team "${team_id}" not found.` }) }],
        };
      }

      const results: string[] = [];

      // Remove Leader from config.
      let configCleaned = false;
      try {
        const cfg = runtimeConfig.loadConfig();
        const { config: nextCfg, removedBindings, removedAllow } = pruneAgentConfigFn(
          cfg as Record<string, unknown>,
          team.leaderAgentId,
        );
        await runtimeConfig.writeConfigFile(nextCfg);
        results.push(`Agent config pruned (${removedBindings} bindings, ${removedAllow} allow entries removed).`);
        configCleaned = true;
      } catch (err) {
        results.push(`Config cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!configCleaned) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to clean up config for team "${team_id}". Team state preserved to avoid inconsistency.`,
                details: results,
              }, null, 2),
            },
          ],
        };
      }

      // Keep workspace directory so that generated artifacts remain accessible.
      const teamDir = path.join(stateDir, TEAM_DIR_NAME, team_id);
      results.push(`Workspace preserved at: ${teamDir}`);

      // Remove from state and persist.
      state.teams = state.teams.filter((t) => t.teamId !== team_id);
      await writeStateToDisk(stateDir, state);
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
