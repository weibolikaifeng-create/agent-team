import { readStateFromDisk } from "./src/team-state.js";
import { createTeamPlanTool } from "./src/tools/team-plan.js";
import { createTeamProvisionTool } from "./src/tools/team-provision.js";
import { createTeamExecuteToolCompat } from "./src/tools/team-execute.js";
import { createTeamCleanupToolCompat } from "./src/tools/team-cleanup.js";
import { createTeamCompleteTool } from "./src/tools/team-complete.js";
import { createTeamUpdateProgressTool } from "./src/tools/team-update-progress.js";
import { registerArtifactHooks } from "./src/artifacts/hooks.js";
import type { RuntimeConfig, PruneAgentConfigFn } from "./src/tools/team-cleanup.js";

// Inlined from core to avoid relative path dependency on src/ (not shipped in npm).

type AgentEntry = {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: string;
  tools?: {
    deny?: string[];
    allow?: string[];
    alsoAllow?: string[];
  };
};

function applyAgentConfig(
  cfg: Record<string, any>,
  params: {
    agentId: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string;
    tools?: {
      deny?: string[];
      allow?: string[];
      alsoAllow?: string[];
    };
  },
): Record<string, any> {
  const agentId = params.agentId.toLowerCase();
  const list: AgentEntry[] = (cfg as any).agents?.list ?? [];
  const index = list.findIndex((e) => e.id?.toLowerCase() === agentId);
  const base = index >= 0 ? list[index]! : { id: agentId };
  const entry: AgentEntry = {
    ...base,
    ...(params.name ? { name: params.name.trim() } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.tools ? { tools: params.tools } : {}),
  };
  const nextList = [...list];
  if (index >= 0) {
    nextList[index] = entry;
  } else {
    // If list was empty and we're adding a non-main agent, ensure main is present first.
    if (nextList.length === 0 && agentId !== "main") {
      nextList.push({ id: "main" });
    }
    nextList.push(entry);
  }
  return { ...cfg, agents: { ...(cfg as any).agents, list: nextList } };
}

function pruneAgentConfig(
  cfg: Record<string, any>,
  agentId: string,
): { config: Record<string, any>; removedBindings: number; removedAllow: number } {
  const id = agentId.toLowerCase();
  const agents: AgentEntry[] = (cfg as any).agents?.list ?? [];
  const nextAgents = agents.filter((e) => e.id?.toLowerCase() !== id);

  const bindings: any[] = (cfg as any).bindings ?? [];
  const nextBindings = bindings.filter((b: any) => b.agentId?.toLowerCase() !== id);

  const allow: string[] = (cfg as any).tools?.agentToAgent?.allow ?? [];
  const nextAllow = allow.filter((e) => e !== id);

  return {
    config: {
      ...cfg,
      agents: { ...(cfg as any).agents, list: nextAgents },
      bindings: nextBindings.length ? nextBindings : undefined,
      tools: (cfg as any).tools?.agentToAgent
        ? {
            ...(cfg as any).tools,
            agentToAgent: {
              ...(cfg as any).tools.agentToAgent,
              allow: nextAllow.length ? nextAllow : undefined,
            },
          }
        : (cfg as any).tools,
    },
    removedBindings: bindings.length - nextBindings.length,
    removedAllow: allow.length - nextAllow.length,
  };
}

// ── Plugin entry ──────────────────────────────────────────────────

const plugin = {
  id: "astron-agent-team",
  name: "Agent Team",
  description: "Dynamic multi-agent team orchestration.",
  register(api: any) {
    console.log("[agent-team] register() called");
    const runtimeConfig = api.runtime.config;
    const stateDir = api.runtime.state.resolveStateDir();
    console.log("[agent-team] stateDir:", stateDir);

    // Register the 6 team tools.
    api.registerTool((ctx: any) => {
      const sessionKey = ctx.sessionKey ?? "default";
      return createTeamPlanTool(stateDir, sessionKey);
    }, { name: "team_plan" });
    api.registerTool((ctx: any) => {
      const sessionKey = ctx.sessionKey ?? "default";
      const messageChannel = ctx.messageChannel;
      return createTeamProvisionTool(
        stateDir,
        sessionKey,
        runtimeConfig,
        applyAgentConfig as Parameters<typeof createTeamProvisionTool>[3],
        messageChannel,
      );
    }, { name: "team_provision" });
    api.registerTool((ctx: any) => {
      const sessionKey = ctx.sessionKey ?? "default";
      const messageChannel = ctx.messageChannel;
      return createTeamExecuteToolCompat(stateDir, sessionKey, messageChannel);
    }, { name: "team_execute" });
    api.registerTool(createTeamCompleteTool(stateDir), { name: "team_complete" });
    api.registerTool(createTeamUpdateProgressTool(stateDir), { name: "team_update_progress" });
    api.registerTool(
      createTeamCleanupToolCompat(
        stateDir,
        runtimeConfig,
        pruneAgentConfig as unknown as PruneAgentConfigFn,
      ),
      { name: "team_cleanup" },
    );

    // Allow team leader sessions to use mode="session" + thread=true
    // without requiring a channel plugin (Discord, Feishu, etc.).
    // Only intercepts agent-team's own leader spawns; other agents are
    // left to channel-specific hooks.
    api.on("subagent_spawning", async (event: any) => {
      if (!event.threadRequested) return;
      const isTeamLeader =
        event.agentId?.startsWith("leader-") || event.label?.startsWith("team-");
      if (!isTeamLeader) return;
      return { status: "ok" as const, threadBindingReady: true };
    });

    // Inject active teams routing table and message handling guidelines into main's system prompt.
    api.on("before_prompt_build", async (_event: any, ctx: any) => {
      if (ctx.agentId !== "main") return;
      const state = await readStateFromDisk(stateDir);
      const active = state.teams.filter((t: any) => t.status !== "completed" && t.status !== "error");
      const lines = active.map(
        (t: any) =>
          `- **${t.teamName}** (\`${t.teamId}\`) | Leader: \`${t.leaderAgentId}\` | Status: ${t.status}`,
      );

      let append = `\n## Active Agent Teams\n${lines.join("\n")}\n`;

      return { appendSystemContext: append };
    });

    // Additive: artifact recognition via observational hooks (subagent_spawned,
    // agent_turn_prepare, after_tool_call, agent_end). Never modifies the tools
    // or state above; failures inside are swallowed per-handler.
    registerArtifactHooks(api, stateDir);
  },
};

export default plugin;
