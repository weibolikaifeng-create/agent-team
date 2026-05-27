import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AnyAgentTool } from "../types.js";
import { readStateFromDisk } from "../team-state.js";
import { TEAM_DIR_NAME, EXECUTIONS_DIR, TODO_FILE } from "../constants.js";

const UpdateItemSchema = Type.Object({
  step_index: Type.Number({ description: "Step index (starting from 1)" }),
  status: Type.Union(
    [
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
      Type.Literal("failed"),
    ],
    { description: "New status for the step" }
  ),
});

const TeamUpdateProgressSchema = Type.Object(
  {
    team_id: Type.String({ description: "ID of the team" }),
    execution_id: Type.String({ description: "Execution ID" }),
    updates: Type.Array(UpdateItemSchema, {
      description: "Array of step updates to apply",
      minItems: 1,
    }),
  },
  { additionalProperties: false }
);

type UpdateItem = {
  step_index: number;
  status: "pending" | "in_progress" | "completed" | "failed";
};

type TeamUpdateProgressParams = {
  team_id: string;
  execution_id: string;
  updates: UpdateItem[];
};

const STATUS_MARKERS = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  failed: "[-]",
} as const;

export function createTeamUpdateProgressTool(stateDir: string): AnyAgentTool {
  return {
    name: "team_update_progress",
    description:
      "Update progress tracking for team execution. Updates step statuses in todo.md and automatically inserts retry steps for failed items. Returns the updated todo.md content.",
    parameters: TeamUpdateProgressSchema,
    async execute(_toolCallId: string, params: TeamUpdateProgressParams) {
      const { team_id, execution_id, updates } = params;

      // Verify team exists
      const state = await readStateFromDisk(stateDir);
      const team = state.teams.find((t) => t.teamId === team_id);
      if (!team) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Team "${team_id}" not found.` }),
            },
          ],
        };
      }

      // Locate todo.md file
      const todoPath = path.join(
        stateDir,
        TEAM_DIR_NAME,
        team_id,
        EXECUTIONS_DIR,
        execution_id,
        TODO_FILE
      );

      // Read current todo.md
      let content: string;
      try {
        content = await fs.readFile(todoPath, "utf-8");
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to read todo.md: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
        };
      }

      const lines = content.split("\n");

      // Find all step lines (lines starting with "- [")
      const stepIndices: number[] = [];
      const stepContents: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^- \[[ ~x\-]\] /.test(line)) {
          stepIndices.push(i);
          // Extract step content (text after the marker)
          const match = line.match(/^- \[[ ~x\-]\] (.+)$/);
          stepContents.push(match ? match[1] : "");
        }
      }

      // Validate step_index in updates
      for (const update of updates) {
        if (update.step_index < 1 || update.step_index > stepIndices.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Step index ${update.step_index} out of range (1-${stepIndices.length})`,
                }),
              },
            ],
          };
        }
      }

      // Deduplicate: if same step_index appears multiple times, keep the last one
      const deduped = new Map<number, UpdateItem>();
      for (const update of updates) {
        deduped.set(update.step_index, update);
      }

      // Phase 1: Update all status markers
      const failedSteps: Array<{ index: number; content: string }> = [];
      for (const update of deduped.values()) {
        const arrayIndex = update.step_index - 1;
        const lineIndex = stepIndices[arrayIndex];
        const stepContent = stepContents[arrayIndex];
        const newMarker = STATUS_MARKERS[update.status];

        lines[lineIndex] = `- ${newMarker} ${stepContent}`;

        if (update.status === "failed") {
          failedSteps.push({ index: lineIndex, content: stepContent });
        }
      }

      // Phase 2: Insert retry steps after failed steps (in reverse order to maintain indices)
      failedSteps.sort((a, b) => b.index - a.index);
      for (const failed of failedSteps) {
        // Avoid nested "重试:" prefix if the step is already a retry step
        const retryPrefix = failed.content.startsWith("重试:") ? "" : "重试: ";
        const retryLine = `- [ ] ${retryPrefix}${failed.content}`;
        lines.splice(failed.index + 1, 0, retryLine);
      }

      // Atomic write: write to temp file then rename to avoid partial reads
      const updatedContent = lines.join("\n");
      const tmpPath = todoPath + ".tmp";
      try {
        await fs.writeFile(tmpPath, updatedContent, "utf-8");
        await fs.rename(tmpPath, todoPath);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to write todo.md: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
        };
      }

      // Build numbered step list for response
      const updatedLines = updatedContent.split("\n");
      const numberedSteps: string[] = [];
      let stepNum = 0;
      for (const line of updatedLines) {
        if (/^- \[[ ~x\-]\] /.test(line)) {
          stepNum++;
          // Replace "- " prefix with numbered prefix
          numberedSteps.push(`${stepNum}、${line.slice(2)}`);
        }
      }

      const response: { content: string; numbered_steps: string; notice?: string } = {
        content: updatedContent,
        numbered_steps: numberedSteps.join("\n"),
      };

      if (failedSteps.length > 0) {
        response.notice =
          "Retry steps have been inserted. Step indices have shifted — use the numbered_steps above for subsequent updates.";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    },
  } as AnyAgentTool;
}
