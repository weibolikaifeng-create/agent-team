import path from "node:path";
import { TEAM_DIR_NAME, EXECUTIONS_DIR, OUTPUT_DIR } from "../constants.js";
import { resolveMemberBySessionKey, describeOutputOwner, } from "./members-registry.js";
import { getWorkspaceDir } from "./workspace-cache.js";
import { artifactsManifestPath } from "./paths.js";
import { extractPathCandidates, resolveToAbsolute, enrichIfArtifact, } from "./candidates.js";
import { updateManifest, ensureExecutionGroup, ensureMemberGroup, upsertArtifact, } from "./manifest.js";
import { slog, glog } from "./filelog.js";
const MAX_JSON_CHARS = 100_000;
// Diagnostic: remember which unrecognized session keys we've already logged, so
// a non-team agent surfaces once in the global log without flooding it.
const loggedUnrecognized = new Set();
/**
 * Tools that never *produce* a member artifact. Their events are skipped:
 * - the plugin's own team-management tools (their results carry infrastructure
 *   paths — execDir, todo.md, output dir — not products);
 * - the single-agent todo tools, whose results carry their internal todo.json
 *   path (infrastructure state, not a product) — same lesson as static-team;
 * - `read`, which consumes files rather than producing them.
 * Note: `sessions_spawn` is intentionally NOT skipped — the leader's dispatch
 * task text names the worker's output dir, and the path-ownership override
 * re-attributes anything found there to the right worker (doc §3.4/§3.5).
 * Producing tools (write / edit / apply_patch / bash / exec) are kept.
 */
const SKIP_TOOLS = new Set([
    "read",
    "team_plan",
    "team_provision",
    "team_execute",
    "team_complete",
    "team_update_progress",
    "team_cleanup",
    "astron_single_agent_todo_create",
    "astron_single_agent_todo_get",
    "astron_single_agent_todo_update",
    "astron_single_agent_todo_complete",
]);
function safeJson(value) {
    try {
        const s = JSON.stringify(value);
        return s.length > MAX_JSON_CHARS ? s.slice(0, MAX_JSON_CHARS) : s;
    }
    catch {
        return "";
    }
}
/**
 * Path-ownership override: if a resolved artifact lives under
 * `teams/{teamId}/executions/{executionId}/output/{X}/`, attribute it to that
 * directory's owner `X` (`leader` or a workerId) in that execution — not to the
 * agent that issued the tool call. Corrects the case where the leader's spawn
 * task carries a worker's output path. Returns undefined when the path is not
 * under a known output dir.
 */
function ownerFromPath(stateDir, teamId, absPath) {
    const execRoot = path.join(stateDir, TEAM_DIR_NAME, teamId, EXECUTIONS_DIR);
    const rel = path.relative(execRoot, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel))
        return undefined;
    const parts = rel.split(path.sep);
    // Need at least: executionId / output / X / file
    if (parts.length < 4)
        return undefined;
    const [executionId, outDir, memberId] = parts;
    if (outDir !== OUTPUT_DIR)
        return undefined;
    const desc = describeOutputOwner(teamId, memberId);
    if (!desc)
        return undefined;
    return { executionId, memberId: desc.memberId, role: desc.role, name: desc.name };
}
/**
 * The after_tool_call capture pipeline: short-circuit non-team calls, mine
 * paths from the event, resolve + verify them on disk, attribute each to a
 * member and execution, and record them in the manifest. Additive only.
 */
export async function captureFromToolCall(input) {
    const { stateDir, toolName } = input;
    // 0. Skip non-producing tools (cheap, before any I/O).
    if (SKIP_TOOLS.has(toolName))
        return;
    // 1. Short-circuit: only team sessions (leader or worker).
    const identity = await resolveMemberBySessionKey(stateDir, input.sessionKey);
    if (!identity) {
        const sk = input.sessionKey;
        if (sk && !loggedUnrecognized.has(sk)) {
            loggedUnrecognized.add(sk);
            glog(stateDir, `[capture] short-circuit: sessionKey not a known team member key=${sk} tool=${toolName}`);
        }
        return;
    }
    const T = identity.teamId;
    // Need an execution to attribute to (member acted before any execution -> skip).
    if (!identity.executionId) {
        slog(stateDir, T, `[capture] tool=${toolName} member=${identity.memberId} -> skip: no current execution`);
        return;
    }
    const startedAtMs = identity.execCreatedAtMs ?? 0;
    // 2. Mine path candidates from the whole event.
    const text = `${toolName} ${safeJson(input.params)} ${safeJson(input.result)}`;
    const candidates = extractPathCandidates(text);
    // Any tool may carry a `cwd` param (bash, exec, ...); use it to resolve
    // relative candidates, falling back to the run's cached workspaceDir.
    const paramsObj = input.params && typeof input.params === "object" ? input.params : undefined;
    const cwd = typeof paramsObj?.cwd === "string" ? paramsObj.cwd : undefined;
    const workspaceDir = getWorkspaceDir(input.runId);
    slog(stateDir, T, `[capture] tool=${toolName} exec=${identity.executionId} member=${identity.memberId} role=${identity.role} cwd=${cwd ?? "-"} workspaceDir=${workspaceDir ?? "-"} startedAtMs=${startedAtMs} candidates=${candidates.length} ${JSON.stringify(candidates.slice(0, 20))}`);
    if (candidates.length === 0)
        return;
    // 3. Resolve + verify each candidate on disk.
    const seen = new Set();
    const enriched = [];
    const rejected = [];
    for (const raw of candidates) {
        const abs = resolveToAbsolute(raw, { workspaceDir, cwd });
        if (!abs || seen.has(abs))
            continue;
        seen.add(abs);
        const art = await enrichIfArtifact(abs, { startedAtMs });
        if (art)
            enriched.push(art);
        else
            rejected.push(abs);
    }
    slog(stateDir, T, `[capture] tool=${toolName} enriched=${enriched.length} rejected=${rejected.length} rejectedPaths=${JSON.stringify(rejected.slice(0, 20))}`);
    if (enriched.length === 0)
        return;
    // 4. Attribute each artifact to an (execution, member) owner.
    const defaultOwner = {
        executionId: identity.executionId,
        memberId: identity.memberId,
        role: identity.role,
        name: identity.name,
    };
    const capturedAt = new Date().toISOString();
    // Group by (executionId, memberId) so a single locked write covers everything.
    const byGroup = new Map();
    for (const art of enriched) {
        const owner = ownerFromPath(stateDir, T, art.path) ?? defaultOwner;
        const key = `${owner.executionId}::${owner.memberId}`;
        let bucket = byGroup.get(key);
        if (!bucket) {
            bucket = { owner, artifacts: [] };
            byGroup.set(key, bucket);
        }
        bucket.artifacts.push({
            path: art.path,
            filename: art.filename,
            size: art.size,
            mtimeMs: art.mtimeMs,
            sha256: art.sha256,
            tool: toolName,
            capturedAt,
        });
    }
    // 5. Persist under a single manifest lock.
    const manifestPath = artifactsManifestPath(stateDir, T);
    await updateManifest(manifestPath, { teamId: T }, (manifest) => {
        for (const { owner, artifacts } of byGroup.values()) {
            const exec = ensureExecutionGroup(manifest, owner.executionId, { taskName: identity.taskName });
            const group = ensureMemberGroup(exec, {
                memberId: owner.memberId,
                role: owner.role,
                name: owner.name,
            });
            for (const art of artifacts)
                upsertArtifact(group, art);
        }
    });
    slog(stateDir, T, `[capture] WROTE ${enriched.length} artifact(s) exec=${identity.executionId} owners=${JSON.stringify([...byGroup.values()].map((b) => `${b.owner.executionId}/${b.owner.memberId}:${b.artifacts.length}`))}`);
    input.log?.(`[astron-agent-team] captured ${enriched.length} artifact(s) for team=${T} exec=${identity.executionId}`);
}
