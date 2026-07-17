import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DELIVERABLE_EXTENSIONS, IGNORE_SEGMENTS, IGNORE_EXTENSIONS, SHA256_MAX_BYTES, SAMPLE_MAX_BYTES, } from "./constants.js";
/**
 * Pure path-extraction + filesystem-verification helpers. These functions know
 * nothing about teams; they turn "the text of a tool call" into a set of real,
 * existing files. The team-attribution layer lives elsewhere.
 *
 * Copied verbatim from the proven static-team implementation.
 */
function stripTrailingPunctuation(value) {
    return value.replace(/[),.;:!?'"`，。；：！？）】》]+$/u, "");
}
/** Regexes that surface local-file path candidates from arbitrary text. */
const PATH_PATTERNS = [
    // absolute / ./ / ../ paths (POSIX — the production shape, e.g. /root/...)
    /(?:^|[\s("'`\\])((?:\/|\.\/|\.\.\/)[^\s"'`<>]+)/g,
    // Windows drive-letter paths (e.g. C:/Users/... or C:\Users\...) — harmless
    // on Linux (no such shape) and keeps the extractor cross-platform.
    /(?:^|[\s("'`])([A-Za-z]:[\\/][^\s"'`<>]+)/g,
    // dir/file.ext (has a separator)
    /(?:^|[\s("'`\\])([A-Za-z0-9_.@一-鿿-]+\/[A-Za-z0-9_.@一-鿿/-]*[A-Za-z0-9_.@一-鿿-]+\.[A-Za-z0-9]{1,12})/g,
    // bare filename with an extension (e.g. report.pptx, 报告.pptx) — noisy on
    // purpose; the filesystem + mtime filter culls anything that isn't real.
    /(?:^|[\s("'`\\/])([A-Za-z0-9_.@一-鿿-]+\.[A-Za-z0-9]{1,12})(?=[\s)"'`,.;:!?\\]|$)/g,
    // backtick-wrapped filename
    /`([^`]+\.[A-Za-z0-9]{1,12})`/g,
];
function hasDeliverableExtension(value) {
    const clean = value.split("#")[0].split("?")[0];
    return DELIVERABLE_EXTENSIONS.has(path.extname(clean).toLowerCase());
}
function isLikelyPathToken(value) {
    const trimmed = stripTrailingPunctuation(value);
    if (!trimmed || trimmed.length > 512)
        return false;
    // Explicit path shapes are always worth checking.
    if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) {
        return true;
    }
    if (trimmed.includes("/"))
        return true;
    // Otherwise require a known deliverable extension to reduce noise.
    return hasDeliverableExtension(trimmed);
}
/**
 * Extract unique local-path candidates from a blob of text
 * (typically `toolName + JSON(params) + JSON(result)`).
 */
export function extractPathCandidates(text) {
    if (!text)
        return [];
    const out = new Set();
    for (const pattern of PATH_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
            const raw = stripTrailingPunctuation(match[1] ?? match[0] ?? "");
            if (isLikelyPathToken(raw))
                out.add(raw);
        }
    }
    return Array.from(out);
}
function expandTilde(value) {
    if (value === "~")
        return os.homedir();
    if (value.startsWith("~/"))
        return path.join(os.homedir(), value.slice(2));
    return value;
}
/**
 * Resolve a raw candidate to an absolute path, replicating OpenClaw's own rule:
 * `~` is expanded, `file://` stripped, absolute paths kept as-is, relative paths
 * resolved against the run's workspace (or an explicit bash cwd when given).
 * Returns null when no base is available for a relative path.
 */
export function resolveToAbsolute(raw, opts) {
    let value = stripTrailingPunctuation(raw).replace(/^file:\/\//i, "");
    value = expandTilde(value);
    if (path.isAbsolute(value))
        return path.resolve(value);
    const base = opts.cwd || opts.workspaceDir;
    if (!base)
        return null;
    return path.resolve(base, value);
}
/** True when a resolved path contains an ignored segment or extension. */
export function isIgnoredPath(absPath) {
    const parts = absPath.split(/[\\/]+/);
    if (parts.some((p) => IGNORE_SEGMENTS.has(p)))
        return true;
    return IGNORE_EXTENSIONS.has(path.extname(absPath).toLowerCase());
}
/**
 * Verify a resolved absolute path is a real artifact and gather its metadata.
 * Requirements: exists, is a regular file, not ignored, and modified at/after
 * `startedAtMs` (i.e. produced during the current execution — not a pre-existing
 * input). Returns null when any requirement fails.
 */
export async function enrichIfArtifact(absPath, opts) {
    if (isIgnoredPath(absPath))
        return null;
    let stat;
    try {
        stat = await fsp.stat(absPath);
    }
    catch {
        return null;
    }
    if (!stat.isFile())
        return null;
    if (Number.isFinite(opts.startedAtMs) && stat.mtimeMs < opts.startedAtMs)
        return null;
    let sha256;
    let sample = "";
    try {
        if (stat.size <= SHA256_MAX_BYTES) {
            const buf = await fsp.readFile(absPath);
            sha256 = crypto.createHash("sha256").update(buf).digest("hex");
            sample = buf.subarray(0, SAMPLE_MAX_BYTES).toString("utf8");
        }
        else {
            const handle = await fsp.open(absPath, "r");
            try {
                const buf = Buffer.alloc(SAMPLE_MAX_BYTES);
                const { bytesRead } = await handle.read(buf, 0, SAMPLE_MAX_BYTES, 0);
                sample = buf.subarray(0, bytesRead).toString("utf8");
            }
            finally {
                await handle.close();
            }
        }
    }
    catch {
        // Metadata best-effort; a file we could stat but not fully read still counts.
    }
    return {
        path: absPath,
        filename: path.basename(absPath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256,
        sample,
    };
}
