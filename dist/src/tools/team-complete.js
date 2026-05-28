import { Type } from "typebox";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { readStateFromDisk, writeStateToDisk } from "../team-state.js";
const execFileAsync = promisify(execFile);
const UPLOAD_SCRIPT = "/root/.openclaw/workspace/skills/uploader/scripts/upload_media.py";
const RESULT_FILE = "result.md";
const TeamCompleteSchema = Type.Object({
    team_id: Type.String({
        description: "Team ID (from __teamId__ in task message).",
    }),
    execution_id: Type.String({
        description: "Execution ID (from __executionId__ in task message).",
    }),
    result_summary: Type.String({
        description: "任务完成总结（中文），使用以下格式输出：\n\n[开场白]：用口语化的方式告知用户任务已完成，例如'您安排的xxx任务已顺利完成，可以查看任务结果了，详情如下：'（根据具体任务灵活调整，不要写死）\n\n任务：<重述原始任务内容>\n\n执行摘要：\n<用3-5句话总结最重要的内容，面向最终用户>\n\n详细结果：\n<综合所有工作者的发现，按主题组织，不要按工作者分组>",
    }),
    final_artifact_path: Type.Optional(Type.String({
        description: "Absolute path to the final deliverable artifact. This is the PRIMARY output of the task.",
    })),
}, { additionalProperties: false });
async function tryUploadArtifact(artifactPath) {
    // Check if upload script exists
    try {
        await fs.access(UPLOAD_SCRIPT);
    }
    catch {
        return { url: null, error: `Upload script not found at ${UPLOAD_SCRIPT}` };
    }
    // Check if artifact file exists
    try {
        await fs.access(artifactPath);
    }
    catch {
        return { url: null, error: `Artifact file not found at ${artifactPath}` };
    }
    try {
        const { stdout, stderr } = await execFileAsync("python3", [UPLOAD_SCRIPT, artifactPath], {
            timeout: 60000,
        });
        const output = stdout.trim();
        // Extract URL from output — expect the last non-empty line to be the URL
        const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
        const url = lines[lines.length - 1] ?? "";
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return { url, error: null };
        }
        return {
            url: null,
            error: `Upload script did not return a valid URL. stdout: ${output}${stderr ? ` | stderr: ${stderr.trim()}` : ""}`,
        };
    }
    catch (err) {
        return {
            url: null,
            error: `Upload failed: ${err.message ?? String(err)}`,
        };
    }
}
async function writeResultMd(execDir, summary, artifactPath, uploadUrl) {
    const outputDir = path.join(execDir, "output");
    await fs.mkdir(outputDir, { recursive: true });
    const resultPath = path.join(outputDir, RESULT_FILE);
    const lines = [];
    lines.push(summary);
    if (artifactPath) {
        lines.push("");
        lines.push(`**最终产物下载链接：**`);
        lines.push(uploadUrl ?? artifactPath);
    }
    await fs.writeFile(resultPath, lines.join("\n"), "utf-8");
}
export function createTeamCompleteTool(stateDir) {
    return {
        name: "team_complete",
        description: "Mark a team execution as completed. MUST be called by Leader agent when all work is finished. Accepts a result summary and optional final artifact path; uploads the artifact to S3 and writes result.md to the execution output directory. This updates execution status and allows the team to be reused.",
        parameters: TeamCompleteSchema,
        async execute(_toolCallId, params) {
            const { team_id, execution_id, result_summary, final_artifact_path } = params;
            // 1. Read state file from disk
            let data;
            try {
                data = await readStateFromDisk(stateDir);
            }
            catch (err) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: `Failed to read team state file: ${err.message}`,
                            }),
                        },
                    ],
                };
            }
            // 2. Find team
            const team = data.teams.find((t) => t.teamId === team_id);
            if (!team) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: `Team "${team_id}" not found.` }),
                        },
                    ],
                };
            }
            // 3. Find execution record
            const execution = team.executions?.find((e) => e.executionId === execution_id);
            if (!execution) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: `Execution "${execution_id}" not found in team "${team_id}".`,
                            }),
                        },
                    ],
                };
            }
            // 4. Idempotency check
            if (execution.status === "completed") {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                message: "Execution already completed.",
                                teamId: team_id,
                                executionId: execution_id,
                                teamStatus: team.status,
                            }),
                        },
                    ],
                };
            }
            // 5. Upload artifact (if provided)
            let uploadUrl = null;
            let uploadError = null;
            if (final_artifact_path) {
                const uploadResult = await tryUploadArtifact(final_artifact_path);
                uploadUrl = uploadResult.url;
                uploadError = uploadResult.error;
            }
            // 6. Write result.md to execDir/output/
            // Derive execDir from stateDir + team_id + execution_id (same logic as team_execute)
            const execDir = path.join(stateDir, "teams", team_id, "executions", execution_id);
            try {
                await writeResultMd(execDir, result_summary, final_artifact_path, uploadUrl);
            }
            catch (err) {
                // Non-fatal — log in response but don't abort
                uploadError = (uploadError ? uploadError + " | " : "") +
                    `result.md write failed: ${err.message}`;
            }
            // 7. Update execution status
            execution.status = "completed";
            execution.completedAt = new Date().toISOString();
            // 8. Clear currentExecutionId
            if (team.currentExecutionId === execution_id) {
                team.currentExecutionId = undefined;
            }
            // 9. Update team status
            const hasRunning = team.executions.some((e) => e.status === "running");
            if (!hasRunning) {
                team.status = "ready";
            }
            // 10. Write back to disk
            await writeStateToDisk(stateDir, data);
            // 11. Return success (include upload result for Leader to use in final message)
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            success: true,
                            teamId: team_id,
                            executionId: execution_id,
                            teamStatus: team.status,
                            message: "Execution marked as completed. Team is now available for reuse.",
                        }, null, 2),
                    },
                ],
            };
        },
    };
}
