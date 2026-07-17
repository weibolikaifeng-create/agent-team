import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { ARTIFACTS_SCHEMA_VERSION } from "./constants.js";

export type MemberRole = "leader" | "worker";

/** LLM-produced label for an artifact (added by the agent_end step). */
export type ArtifactLabel = {
  status: "final" | "supporting" | "noise";
  confidence?: number;
  title?: string;
  reason?: string;
  labeledAt?: string;
};

export type ManifestArtifact = {
  path: string;
  filename: string;
  size: number;
  mtimeMs: number;
  sha256?: string;
  tool: string;
  capturedAt: string;
  label?: ArtifactLabel;
};

/**
 * Grouping granularity is (executionId, memberId). A member re-spawned after a
 * failure gets a new sessionKey but the SAME memberId, so its artifacts merge
 * into one group — hence this layer carries no sessionKey (use members.json to
 * trace a memberId back to its runtime sessionKeys).
 */
export type ManifestMemberGroup = {
  role: MemberRole;
  memberId: string;
  name: string;
  artifacts: ManifestArtifact[];
};

export type ManifestExecution = {
  executionId: string;
  taskName?: string;
  createdAt?: string;
  members: ManifestMemberGroup[];
};

export type Manifest = {
  schemaVersion: number;
  teamId: string;
  updatedAt: string;
  executions: ManifestExecution[];
};

export function emptyManifest(teamId: string): Manifest {
  return {
    schemaVersion: ARTIFACTS_SCHEMA_VERSION,
    teamId,
    updatedAt: new Date().toISOString(),
    executions: [],
  };
}

/** Read a manifest from disk; returns undefined when the file does not exist. */
export async function readManifest(manifestPath: string): Promise<Manifest | undefined> {
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    const data = JSON.parse(raw) as Manifest;
    if (data && Array.isArray(data.executions)) return data;
    return undefined;
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/** Find-or-create an execution group inside the manifest. */
export function ensureExecutionGroup(
  manifest: Manifest,
  executionId: string,
  meta?: { taskName?: string; createdAt?: string },
): ManifestExecution {
  let exec = manifest.executions.find((e) => e.executionId === executionId);
  if (!exec) {
    exec = { executionId, taskName: meta?.taskName, createdAt: meta?.createdAt, members: [] };
    manifest.executions.push(exec);
  } else {
    if (meta?.taskName && !exec.taskName) exec.taskName = meta.taskName;
    if (meta?.createdAt && !exec.createdAt) exec.createdAt = meta.createdAt;
  }
  return exec;
}

/** Find-or-create a member group inside an execution. */
export function ensureMemberGroup(
  exec: ManifestExecution,
  member: { memberId: string; role: MemberRole; name: string },
): ManifestMemberGroup {
  let group = exec.members.find((m) => m.memberId === member.memberId);
  if (!group) {
    group = { role: member.role, memberId: member.memberId, name: member.name, artifacts: [] };
    exec.members.push(group);
  }
  return group;
}

/**
 * Insert or refresh an artifact in a member group, deduped by absolute path.
 * Capture is additive: an existing entry is updated in place (metadata
 * refreshed), never removed. The label is preserved across re-captures of the
 * SAME content, but cleared when the file's content changed (sha256 differs) —
 * a rewritten file must go back to the unlabeled pool and be judged against
 * the round that produced it. When either sha256 is unavailable we keep the
 * label (conservative: never drop a judgment without proof of change).
 */
export function upsertArtifact(group: ManifestMemberGroup, incoming: ManifestArtifact): void {
  const existing = group.artifacts.find((a) => a.path === incoming.path);
  if (!existing) {
    group.artifacts.push(incoming);
    return;
  }
  const contentChanged =
    typeof existing.sha256 === "string" &&
    typeof incoming.sha256 === "string" &&
    existing.sha256 !== incoming.sha256;
  existing.size = incoming.size;
  existing.mtimeMs = incoming.mtimeMs;
  existing.sha256 = incoming.sha256;
  existing.tool = incoming.tool;
  existing.capturedAt = incoming.capturedAt;
  if (contentChanged) delete existing.label;
}

async function ensureFileExists(manifestPath: string, teamId: string): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  try {
    await fs.access(manifestPath);
  } catch {
    try {
      await fs.writeFile(
        manifestPath,
        JSON.stringify(emptyManifest(teamId), null, 2),
        { encoding: "utf-8", flag: "wx" },
      );
    } catch {
      // EEXIST — created concurrently, safe to ignore.
    }
  }
}

async function writeAtomic(manifestPath: string, manifest: Manifest): Promise<void> {
  const tmp = manifestPath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf-8");
  await fs.rename(tmp, manifestPath);
}

/**
 * Lock the manifest, read (or seed) it, apply `mutate`, and atomically write it
 * back. Concurrent updates to the same manifest are serialized per process by
 * the file lock; different teams write different files and never contend.
 *
 * Lock/retry machinery copied verbatim from the proven static-team implementation.
 */
export async function updateManifest(
  manifestPath: string,
  seed: { teamId: string },
  mutate: (manifest: Manifest) => void | Promise<void>,
): Promise<void> {
  await ensureFileExists(manifestPath, seed.teamId);
  // Team manifests can be written concurrently by several members' hooks
  // (parallel workers, rapid successive writes). Writes are tiny and fast, so
  // generous retries absorb contention without dropping a capture.
  const release = await lockfile.lock(manifestPath, {
    retries: { retries: 20, minTimeout: 100, maxTimeout: 1000, randomize: true },
  });
  try {
    const manifest = (await readManifest(manifestPath)) ?? emptyManifest(seed.teamId);
    await mutate(manifest);
    manifest.updatedAt = new Date().toISOString();
    await writeAtomic(manifestPath, manifest);
  } finally {
    await release();
  }
}
