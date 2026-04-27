import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-team";
import type { TeamStateManager } from "../team-state.js";
import { TEMPLATES, rankTemplates } from "../templates.js";

const TeamPlanSchema = Type.Object(
  {
    task: Type.String({
      description: "Description of the task that needs a multi-agent team.",
    }),
    preferred_template_id: Type.Optional(
      Type.String({
        description: "Optional preferred template ID to bias selection.",
      }),
    ),
  },
  { additionalProperties: false },
);

type TeamPlanParams = {
  task: string;
  preferred_template_id?: string;
};

export function createTeamPlanTool(teamState: TeamStateManager): AnyAgentTool {
  return {
    name: "team_plan",
    description:
      "Analyze a task and suggest the best multi-agent team template. Returns ranked template suggestions and any reusable existing teams.",
    parameters: TeamPlanSchema,
    async execute(_toolCallId: string, params: TeamPlanParams) {
      const { task, preferred_template_id } = params;

      const ranked = rankTemplates(task);

      // If a preferred template is specified, boost it to the top.
      if (preferred_template_id) {
        const idx = ranked.findIndex((r) => r.template.id === preferred_template_id);
        if (idx > 0) {
          const [entry] = ranked.splice(idx, 1);
          ranked.unshift(entry!);
        } else if (idx === -1) {
          const preferred = TEMPLATES.find((t) => t.id === preferred_template_id);
          if (preferred) {
            ranked.unshift({ template: preferred, score: 0 });
          }
        }
      }

      // Check for reusable teams from existing state.
      const reusableTeams = ranked.flatMap((r) =>
        teamState.findReusableTeams(r.template.id).map((team) => ({
          teamId: team.teamId,
          teamName: team.teamName,
          templateId: team.templateId,
          status: team.status,
        })),
      );

      const suggestions = ranked.map((r) => ({
        templateId: r.template.id,
        name: r.template.name,
        description: r.template.description,
        collaborationMode: r.template.collaborationMode,
        workerCount: r.template.workers.length,
        score: Math.round(r.score * 100),
      }));

      const allTemplates = TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
      }));

      const guidance =
        suggestions.length > 0
          ? `Best match: "${suggestions[0]!.name}" (${suggestions[0]!.score}% keyword match). Use team_provision to create this team, or pick a different template.`
          : "No strong template match found. You can still use team_provision with any template ID, or design a custom team by specifying leader/workers directly. When planning custom teams: avoid using generic roles like 'reviewer', 'editor', or 'checker' that merely validate others' work without producing original content; instead, focus on roles that generate tangible outputs (e.g., researcher, writer, analyst, designer, developer). For mapreduce and supervisor modes, limit workers that run in parallel to 2 (recommended) or 3 (maximum) — this is a concurrency limit, not a total worker limit. For example, 3 parallel search workers + 1 sequential writer is fine; 4 simultaneous search workers is not.";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                suggestions,
                reusableTeams,
                availableTemplates: allTemplates,
                guidance,
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
