import { readStateFromDisk } from "./src/team-state.js";
import { createTeamPlanTool } from "./src/tools/team-plan.js";
import { createTeamProvisionTool } from "./src/tools/team-provision.js";
import { createTeamExecuteToolCompat } from "./src/tools/team-execute.js";
import { createTeamCleanupToolCompat } from "./src/tools/team-cleanup.js";
import { createTeamCompleteTool } from "./src/tools/team-complete.js";
import { createTeamUpdateProgressTool } from "./src/tools/team-update-progress.js";
function applyAgentConfig(cfg, params) {
    const agentId = params.agentId.toLowerCase();
    const list = cfg.agents?.list ?? [];
    const index = list.findIndex((e) => e.id?.toLowerCase() === agentId);
    const base = index >= 0 ? list[index] : { id: agentId };
    const entry = {
        ...base,
        ...(params.name ? { name: params.name.trim() } : {}),
        ...(params.workspace ? { workspace: params.workspace } : {}),
        ...(params.agentDir ? { agentDir: params.agentDir } : {}),
        ...(params.model ? { model: params.model } : {}),
    };
    const nextList = [...list];
    if (index >= 0) {
        nextList[index] = entry;
    }
    else {
        // If list was empty and we're adding a non-main agent, ensure main is present first.
        if (nextList.length === 0 && agentId !== "main") {
            nextList.push({ id: "main" });
        }
        nextList.push(entry);
    }
    return { ...cfg, agents: { ...cfg.agents, list: nextList } };
}
function pruneAgentConfig(cfg, agentId) {
    const id = agentId.toLowerCase();
    const agents = cfg.agents?.list ?? [];
    const nextAgents = agents.filter((e) => e.id?.toLowerCase() !== id);
    const bindings = cfg.bindings ?? [];
    const nextBindings = bindings.filter((b) => b.agentId?.toLowerCase() !== id);
    const allow = cfg.tools?.agentToAgent?.allow ?? [];
    const nextAllow = allow.filter((e) => e !== id);
    return {
        config: {
            ...cfg,
            agents: { ...cfg.agents, list: nextAgents },
            bindings: nextBindings.length ? nextBindings : undefined,
            tools: cfg.tools?.agentToAgent
                ? {
                    ...cfg.tools,
                    agentToAgent: {
                        ...cfg.tools.agentToAgent,
                        allow: nextAllow.length ? nextAllow : undefined,
                    },
                }
                : cfg.tools,
        },
        removedBindings: bindings.length - nextBindings.length,
        removedAllow: allow.length - nextAllow.length,
    };
}
// ── Plugin entry ──────────────────────────────────────────────────
const plugin = {
    id: "agent-team",
    name: "Agent Team",
    description: "Dynamic multi-agent team orchestration.",
    register(api) {
        console.log("[agent-team] register() called");
        const runtimeConfig = api.runtime.config;
        const stateDir = api.runtime.state.resolveStateDir();
        console.log("[agent-team] stateDir:", stateDir);
        // Register the 6 team tools.
        api.registerTool((ctx) => {
            const sessionKey = ctx.sessionKey ?? "default";
            return createTeamPlanTool(stateDir, sessionKey);
        }, { name: "team_plan" });
        api.registerTool((ctx) => {
            const sessionKey = ctx.sessionKey ?? "default";
            return createTeamProvisionTool(stateDir, sessionKey, runtimeConfig, applyAgentConfig);
        }, { name: "team_provision" });
        api.registerTool((ctx) => {
            const sessionKey = ctx.sessionKey ?? "default";
            return createTeamExecuteToolCompat(stateDir, sessionKey);
        }, { name: "team_execute" });
        api.registerTool(createTeamCompleteTool(stateDir), { name: "team_complete" });
        api.registerTool(createTeamUpdateProgressTool(stateDir), { name: "team_update_progress" });
        api.registerTool(createTeamCleanupToolCompat(stateDir, runtimeConfig, pruneAgentConfig), { name: "team_cleanup" });
        // Allow team leader sessions to use mode="session" + thread=true
        // without requiring a channel plugin (Discord, Feishu, etc.).
        // Only intercepts agent-team's own leader spawns; other agents are
        // left to channel-specific hooks.
        api.on("subagent_spawning", async (event) => {
            if (!event.threadRequested)
                return;
            const isTeamLeader = event.agentId?.startsWith("leader-") || event.label?.startsWith("team-");
            if (!isTeamLeader)
                return;
            return { status: "ok", threadBindingReady: true };
        });
        // Inject active teams routing table and message handling guidelines into main's system prompt.
        api.on("before_prompt_build", async (_event, ctx) => {
            if (ctx.agentId !== "main")
                return;
            const state = await readStateFromDisk(stateDir);
            const active = state.teams.filter((t) => t.status !== "completed" && t.status !== "error");
            const lines = active.map((t) => `- **${t.teamName}** (\`${t.teamId}\`) | Leader: \`${t.leaderAgentId}\` | Status: ${t.status}`);
            let append = `\n## Active Agent Teams\n${lines.join("\n")}\n`;
            return { appendSystemContext: append };
        });
    },
};
export default plugin;
