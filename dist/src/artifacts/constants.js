/**
 * Constants for the artifact-recognition layer (agent-team / dynamic mode).
 *
 * Purely additive: this layer observes tool calls via OpenClaw hooks and records
 * the files each team member actually writes into an artifacts manifest. It never
 * modifies the existing team tools, team state file, or their behavior.
 *
 * Extraction / FS-verification constants below are copied verbatim from the
 * proven static-team implementation — the noisy-filename tradeoffs are already
 * tuned there.
 */
/** Artifacts manifest, stored at the team level: `teams/{teamId}/artifacts.json`. */
export const ARTIFACTS_FILE = "artifacts.json";
/** Member registry, stored at the team level: `teams/{teamId}/members.json`. */
export const MEMBERS_FILE = "members.json";
/** Diagnostic log filename (session-level == team-level here). */
export const ARTIFACT_LOG_FILE = "artifact-recognition.log";
/** Current schema version of the artifacts manifest and member registry. */
export const ARTIFACTS_SCHEMA_VERSION = 1;
/**
 * File extensions treated as deliverable formats. A path candidate whose
 * extension is in this set is a strong artifact signal. This is NOT a hard
 * filter — absolute paths are accepted regardless (see candidates.ts) — it only
 * helps the regex layer recognize bare filenames as likely paths.
 */
export const DELIVERABLE_EXTENSIONS = new Set([
    // documents
    ".pptx", ".ppt", ".docx", ".doc", ".xlsx", ".xls", ".pdf",
    ".md", ".txt", ".csv", ".tsv", ".html", ".htm", ".xml",
    ".json", ".jsonl", ".yaml", ".yml",
    // images / media
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
    // archives
    ".zip", ".tar", ".gz",
    // code (kept so scripts that ARE the deliverable are captured; LLM later tags noise)
    ".py", ".js", ".mjs", ".ts", ".tsx", ".sh",
]);
/** Path segments that mark noise directories; any candidate containing one is ignored. */
export const IGNORE_SEGMENTS = new Set([
    ".git", "node_modules", "__pycache__", ".cache",
    "dist", "build", "coverage", ".next", ".turbo",
]);
/** Extensions that mark temporary / log files; such candidates are ignored. */
export const IGNORE_EXTENSIONS = new Set([
    ".tmp", ".temp", ".part", ".swp", ".lock", ".log", ".pyc",
]);
/** Skip hashing files larger than this (sha256 stays empty for them). */
export const SHA256_MAX_BYTES = 10 * 1024 * 1024;
/** How many bytes of a file to read as a content sample for the LLM labeling step. */
export const SAMPLE_MAX_BYTES = 2048;
