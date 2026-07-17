import { resolveMemberBySessionKey } from "./members-registry.js";
import { artifactsManifestPath } from "./paths.js";
import { updateManifest, type ArtifactLabel, type ManifestArtifact } from "./manifest.js";
import { slog } from "./filelog.js";

/**
 * LLM labeling layer (invoked from agent_end).
 *
 * The mechanism has already captured the real, existing files; this layer only
 * TAGS each file as final / supporting / noise. It never adds or removes files.
 *
 * LLM invocation mirrors astronclaw-plugins' proven approach (as shipped in
 * static-team): it spawns the `openclaw infer model run` CLI subprocess (hard
 * SIGTERM timeout), the model is resolved from config/defaults, and the plugin
 * never touches an API key — credential resolution is the CLI's job.
 */

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TEXT_CHARS = 2500;
const MAX_FILES = 40;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(text: string, max: number): string {
  const v = asString(text);
  return v.length <= max ? v : v.slice(0, max);
}

// ── message extraction ───────────────────────────────────────────────

function roleOf(message: unknown): string {
  const m = asObject(message);
  return asString(m.role) || asString(asObject(m.message).role) || asString(m.type) || "";
}

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  const p = asObject(part);
  return asString(p.text) || asString(p.content) || asString(p.output) || asString(p.result);
}

function messageText(message: unknown): string {
  const m = asObject(message);
  const content = m.content ?? asObject(m.message).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partText).filter(Boolean).join("\n");
  return partText(content);
}

function lastTextByRole(messages: unknown[], role: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (roleOf(messages[i]) === role) {
      const text = messageText(messages[i]);
      if (text) return text;
    }
  }
  return "";
}

// ── model resolution (config/defaults; never an API key) ─────────────

type ModelRef = { provider?: string; model?: string };

function readPluginLabelConfig(api: any): Record<string, unknown> {
  return asObject(asObject(api?.pluginConfig).artifactLabel);
}

function resolveModelRef(api: any, cfg: any): ModelRef {
  const labelCfg = readPluginLabelConfig(api);
  const cfgProvider = asString(labelCfg.provider);
  const cfgModel = asString(labelCfg.model);
  if (cfgProvider || cfgModel) return { provider: cfgProvider || undefined, model: cfgModel || undefined };

  // agents.defaults.model may be a "provider/model" string or a { primary } object.
  const defaultsModel = asObject(asObject(asObject(cfg).agents).defaults).model;
  const primary =
    typeof defaultsModel === "string" ? defaultsModel : asString(asObject(defaultsModel).primary);
  if (primary.includes("/")) {
    const [provider, ...rest] = primary.split("/");
    return { provider: provider || undefined, model: rest.join("/") || undefined };
  }

  const defaults = asObject(api?.runtime?.agent?.defaults);
  return {
    provider: asString(defaults.provider) || undefined,
    model: asString(defaults.model) || primary || undefined,
  };
}

function formatModelRef(ref: ModelRef): string {
  if (ref.provider && ref.model) return `${ref.provider}/${ref.model}`;
  return ref.model || ref.provider || "";
}

// ── LLM call: `openclaw infer model run` subprocess ──────────────────
//
// Mirrors astronclaw-plugins' proven approach: spawn the openclaw CLI, feed the
// prompt, read JSON from stdout. A hard SIGTERM timeout guarantees the call
// always returns (the in-process embedded runner has only an HTTP-stream idle
// timeout, which can hang indefinitely). The plugin never touches an API key —
// credential resolution is the CLI's job.

async function runInferCli(prompt: string, modelRef: ModelRef, timeoutMs: number): Promise<string> {
  const { spawn } = await import("node:child_process");
  const args = ["infer", "model", "run", "--json", "--prompt", prompt];
  const model = formatModelRef(modelRef);
  if (model) args.push("--model", model);

  return await new Promise<string>((resolve, reject) => {
    const child = spawn("openclaw", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`openclaw infer model run timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`openclaw infer model run exited ${code}: ${(stderr || stdout).slice(0, 2000)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(asString(parsed?.outputs?.[0]?.text ?? parsed?.text));
      } catch (error) {
        reject(new Error(`failed to parse openclaw infer output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

// ── LLM result parsing ───────────────────────────────────────────────

function parseJson(text: string): any {
  const v = asString(text);
  const fenced = v.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = (fenced?.[1] ?? v).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function normalizeStatus(value: unknown): ArtifactLabel["status"] | undefined {
  const s = asString(value).toLowerCase();
  if (s === "final" || s === "supporting" || s === "noise") return s;
  return undefined;
}

// ── prompt ───────────────────────────────────────────────────────────

function buildPrompt(params: {
  taskInstruction: string;
  report: string;
  files: ManifestArtifact[];
}): string {
  const fileLines = params.files
    .map((f, i) =>
      [
        `${i + 1}. path: ${f.path}`,
        `   filename: ${f.filename}`,
        `   size: ${f.size}`,
      ].join("\n"),
    )
    .join("\n\n");

  return `你是团队任务的产物分类器。下面给出一个团队成员的任务指令、结果汇报，以及系统已经在文件系统中确认存在的产物文件清单。

请只对给定的这些文件做分类，输出中文 JSON，不要输出 Markdown。严格遵守：
- 只能对下面清单中的文件打标，不得新增任何文件，也不得删除任何文件。
- status 取值：final（符合任务要求的交付物）、supporting（支撑材料）、noise（脚本、临时数据、参考文件等中间过程文件）。
- 结合任务指令和汇报判断：被汇报为产物（如各种格式文档、html等）、或符合任务要求交付格式的，判断为final；用户提供的原始材料，或者参照的已有的内部文件，判断为 supporting；为生成产物而写并执行的脚本、日志文件、临时数据文件等判断为 noise。
输出结构：
{
  "labels": [
    { "path": "文件的完整路径（须与清单一致）", "status": "final|supporting|noise", "confidence": 0.0, "title": "简短标题", "reason": "判定理由" }
  ]
}

任务指令：
${truncate(params.taskInstruction, MAX_TEXT_CHARS)}

结果汇报：
${truncate(params.report, MAX_TEXT_CHARS)}

已确认存在的产物文件清单：
${fileLines || "(空)"}`;
}

// ── entry point ──────────────────────────────────────────────────────

export type LabelInput = {
  api: any;
  stateDir: string;
  sessionKey?: string;
  messages: unknown[];
  success?: boolean;
  log?: (msg: string) => void;
};

/**
 * Label the calling member's captured artifacts (under its current execution).
 * Best-effort: any failure leaves the mechanically-captured manifest untouched.
 */
export async function labelArtifacts(input: LabelInput): Promise<void> {
  const { api, stateDir } = input;

  // Non-team sessions: silent short-circuit (agent_end fires for every agent).
  const identity = await resolveMemberBySessionKey(stateDir, input.sessionKey);
  if (!identity) return;

  const T = identity.teamId;
  // Proves agent_end actually fired for a team member (i.e. was NOT blocked by
  // the conversation-hook policy). If this line is absent from the team log
  // after a real run, agent_end never reached us.
  slog(stateDir, T, `[agent_end] reached member=${identity.memberId} role=${identity.role} success=${input.success} msgs=${input.messages.length} exec=${identity.executionId}`);

  if (!identity.executionId) {
    slog(stateDir, T, "[label] skip: no current execution");
    return;
  }
  if (input.success === false) {
    slog(stateDir, T, "[label] skip: run failed (success=false)");
    return;
  }
  if (input.messages.length === 0) {
    slog(stateDir, T, "[label] skip: no messages");
    return;
  }
  if (readPluginLabelConfig(api).enabled === false) {
    slog(stateDir, T, "[label] skip: disabled by config");
    return;
  }

  const manifestPath = artifactsManifestPath(stateDir, T);

  // Collect this member's unlabeled artifacts under the current execution.
  const { readManifest } = await import("./manifest.js");
  const manifest = await readManifest(manifestPath);
  if (!manifest) {
    slog(stateDir, T, "[label] skip: no manifest yet");
    return;
  }
  const exec = manifest.executions.find((e) => e.executionId === identity.executionId);
  const group = exec?.members.find((m) => m.memberId === identity.memberId);
  if (!group || group.artifacts.length === 0) {
    slog(stateDir, T, "[label] skip: no artifacts for this member under current execution");
    return;
  }
  const needLabeling = group.artifacts.filter((a) => !a.label);
  if (needLabeling.length === 0) {
    slog(stateDir, T, "[label] skip: all artifacts already labeled");
    return; // dedup: nothing new to judge
  }

  // Only the unlabeled artifacts are sent for judgment AND allowed in the
  // write-back: existing labels were judged against their own round's
  // instruction/report and must never be re-judged with a later, possibly
  // unrelated round's context (labels are write-once per content version).
  const files = needLabeling.slice(0, MAX_FILES);
  const taskInstruction = lastTextByRole(input.messages, "user");
  const report = lastTextByRole(input.messages, "assistant");

  // Resolve model + timeout for the one-shot classification call.
  const cfg = api?.runtime?.config?.current?.();
  const modelRef = resolveModelRef(api, cfg);
  const labelCfg = readPluginLabelConfig(api);
  const timeoutMs = Number.isFinite(Number(labelCfg.timeoutMs))
    ? Math.max(5000, Math.min(300_000, Number(labelCfg.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const prompt = buildPrompt({ taskInstruction, report, files });

  slog(
    stateDir, T,
    `[label] calling LLM (infer-cli) model=${formatModelRef(modelRef) || "-"} files=${files.length} timeoutMs=${timeoutMs}`,
  );
  slog(stateDir, T, `[label] LLM prompt >>>>>\n${prompt}\n<<<<< end prompt`);

  let text = "";
  try {
    text = await runInferCli(prompt, modelRef, timeoutMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    slog(stateDir, T, `[label] LLM call FAILED: ${msg}`);
    input.log?.(`[astron-agent-team] label LLM call failed: ${msg}`);
    return;
  }

  slog(stateDir, T, `[label] LLM returned textChars=${text.length}`);
  slog(stateDir, T, `[label] LLM raw response >>>>>\n${text}\n<<<<< end response`);

  const parsed = parseJson(text);
  const labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
  if (labels.length === 0) {
    slog(stateDir, T, `[label] skip: LLM output parsed to 0 labels (textHead=${JSON.stringify(text.slice(0, 200))})`);
    return;
  }

  // Build path -> label map, only for the unlabeled paths that were sent for
  // judgment — already-labeled artifacts can never be overwritten here.
  const validPaths = new Set(files.map((a) => a.path));
  const labeledAt = new Date().toISOString();
  const labelByPath = new Map<string, ArtifactLabel>();
  for (const raw of labels) {
    const item = asObject(raw);
    const p = asString(item.path);
    const status = normalizeStatus(item.status);
    if (!p || !status || !validPaths.has(p)) continue;
    labelByPath.set(p, {
      status,
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : undefined,
      title: asString(item.title) || undefined,
      reason: asString(item.reason) || undefined,
      labeledAt,
    });
  }
  if (labelByPath.size === 0) {
    slog(stateDir, T, "[label] skip: no returned label matched a captured path");
    return;
  }

  // Write labels back — only tag, never remove.
  await updateManifest(manifestPath, { teamId: T }, (m) => {
    const e = m.executions.find((x) => x.executionId === identity.executionId);
    const g = e?.members.find((mm) => mm.memberId === identity.memberId);
    if (!g) return;
    for (const a of g.artifacts) {
      const label = labelByPath.get(a.path);
      if (label) a.label = label;
    }
  });

  slog(stateDir, T, `[label] WROTE ${labelByPath.size} label(s) exec=${identity.executionId} member=${identity.memberId}`);
  input.log?.(
    `[astron-agent-team] labeled ${labelByPath.size} artifact(s) for team=${T} exec=${identity.executionId} member=${identity.memberId}`,
  );
}
