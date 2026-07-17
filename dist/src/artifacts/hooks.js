import { captureFromToolCall } from "./capture.js";
import { rememberWorkspaceDir, forgetWorkspaceDir } from "./workspace-cache.js";
import { labelArtifacts } from "./analysis.js";
import { registerWorkerFromSpawn } from "./members-registry.js";
import { setArtifactLogEnabled, glog } from "./filelog.js";
/**
 * Register the artifact-recognition hooks on the agent-team plugin API.
 *
 * Purely additive: this observes agent lifecycle + tool calls and records the
 * files members produce. It never touches the existing team tools or state.
 *
 * - subagent_spawned: register the worker (childSessionKey -> memberId). This is
 *   the ONLY moment both identities are visible together (doc §3.2).
 * - agent_turn_prepare: cache runId -> workspaceDir (needed to resolve relative
 *   write paths later; after_tool_call's context lacks workspaceDir).
 * - after_tool_call: capture produced files into the artifacts manifest.
 * - agent_end: drop the workspace cache entry, then (on success) LLM-label the
 *   member's captured artifacts. Labeling runs detached so a host per-hook
 *   timeout can't cut the model call short.
 *
 * Every handler swallows its own errors — team sessions must never be affected.
 */
export function registerArtifactHooks(api, stateDir) {
    const log = (msg) => {
        try {
            api?.logger?.info?.(msg);
        }
        catch {
            // ignore logging failures
        }
    };
    const warn = (msg) => {
        try {
            api?.logger?.warn?.(msg);
        }
        catch {
            // ignore logging failures
        }
    };
    // Diagnostic file logging is opt-in via plugin config `logs: true`.
    try {
        const cfg = api?.pluginConfig;
        setArtifactLogEnabled(cfg && typeof cfg === "object" && cfg.logs === true);
    }
    catch {
        setArtifactLogEnabled(false);
    }
    // Hard guard: registration must never throw out of the plugin's register(),
    // so it can never affect the already-registered team tools.
    if (typeof api?.on !== "function") {
        warn("[astron-agent-team] api.on unavailable; artifact recognition disabled");
        return;
    }
    try {
        registerHooks(api, stateDir, log, warn);
    }
    catch (err) {
        warn(`[astron-agent-team] hook registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function registerHooks(api, stateDir, log, warn) {
    glog(stateDir, "[register] agent-team artifact hooks registered: subagent_spawned, agent_turn_prepare, after_tool_call, agent_end");
    api.on("subagent_spawned", (event, ctx) => {
        // The one moment childSessionKey + label are visible together. Detached:
        // registration writes members.json; failures must not affect the spawn.
        void registerWorkerFromSpawn(stateDir, {
            agentId: event?.agentId,
            label: event?.label,
            childSessionKey: event?.childSessionKey ?? ctx?.childSessionKey,
            runId: event?.runId ?? ctx?.runId,
        }, { requesterSessionKey: ctx?.requesterSessionKey }).catch((err) => {
            warn(`[astron-agent-team] worker registration failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    });
    api.on("agent_turn_prepare", (_event, ctx) => {
        try {
            rememberWorkspaceDir(ctx?.runId, ctx?.workspaceDir);
        }
        catch {
            // never interfere with prompt building
        }
        // Return nothing: do not participate in prompt-mutation merge.
    });
    api.on("after_tool_call", async (event, ctx) => {
        try {
            await captureFromToolCall({
                stateDir,
                toolName: String(event?.toolName ?? ""),
                params: event?.params,
                result: event?.result,
                sessionKey: ctx?.sessionKey,
                runId: ctx?.runId ?? event?.runId,
                log,
            });
        }
        catch (err) {
            warn(`[astron-agent-team] capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    api.on("agent_end", (event, ctx) => {
        try {
            forgetWorkspaceDir(ctx?.runId);
        }
        catch {
            // ignore
        }
        const messages = Array.isArray(event?.messages) ? event.messages : [];
        // Detached: the model call is bounded by its own timeout, not the host's.
        // All gating (success / empty messages / non-team) and its logging happens
        // inside labelArtifacts, so the team log shows exactly why labeling ran or
        // was skipped — and proves whether agent_end fired at all for a member.
        void labelArtifacts({
            api,
            stateDir,
            sessionKey: ctx?.sessionKey,
            messages,
            success: event?.success,
            log,
        }).catch((err) => {
            warn(`[astron-agent-team] label failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    });
}
