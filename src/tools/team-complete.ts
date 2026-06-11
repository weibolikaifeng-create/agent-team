import { Type } from "typebox";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import type { AnyAgentTool } from "../types.js";
import { readStateFromDisk, writeStateToDisk } from "../team-state.js";

const execFileAsync = promisify(execFile);

const UPLOAD_SCRIPT = "/root/.openclaw/workspace/skills/uploader/scripts/upload_media.py";
const RESULT_FILE = "result.md";

const TeamCompleteSchema = Type.Object(
  {
    team_id: Type.String({
      description: "Team ID (from __teamId__ in task message).",
    }),
    execution_id: Type.String({
      description: "Execution ID (from __executionId__ in task message).",
    }),
    result_summary: Type.String({
      description:
        "任务完成总结（中文），使用以下格式输出：\n\n[开场白]：用口语化的方式告知用户任务已完成，例如'您安排的xxx任务已顺利完成，可以查看任务结果了，详情如下：'（根据具体任务灵活调整，不要写死）\n\n任务：<重述原始任务内容>\n\n执行摘要：\n<用3-5句话总结最重要的内容，面向最终用户>\n\n详细结果：\n<综合所有工作者的发现，按主题组织，不要按工作者分组>\n\n注意：不要在总结中出现产物名称或者路径的描述。",
    }),
    final_artifact_paths: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "最终产物的URL列表，严禁填写任何中间产物、草稿、临时文件、工作日志、分析笔记、缓存文件、worker 输出草稿、未整合结果或仅供内部处理的文件路径。将中间产物写入此参数会导致执行结果错误、任务失败，如不允许传入调研任务过程中搜索工作者产出的文件。",
      }),
    ),
  },
  { additionalProperties: false },
);

type TeamCompleteParams = {
  team_id: string;
  execution_id: string;
  result_summary: string;
  final_artifact_paths?: string[];
};

async function tryUploadArtifact(artifactPath: string): Promise<{ url: string | null; error: string | null }> {
  // Check if upload script exists
  try {
    await fs.access(UPLOAD_SCRIPT);
  } catch {
    return { url: null, error: `Upload script not found at ${UPLOAD_SCRIPT}` };
  }

  // Check if artifact file exists
  try {
    await fs.access(artifactPath);
  } catch {
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
  } catch (err: any) {
    return {
      url: null,
      error: `Upload failed: ${err.message ?? String(err)}`,
    };
  }
}

async function writeResultMd(
  execDir: string,
  summary: string,
  artifactResults: Array<{ path: string; url: string | null }>,
): Promise<void> {
  const outputDir = path.join(execDir, "output");
  await fs.mkdir(outputDir, { recursive: true });
  const resultPath = path.join(outputDir, RESULT_FILE);

  const lines: string[] = [];
  lines.push(summary);

  if (artifactResults.length > 0) {
    lines.push("");
    lines.push(`**最终产物下载链接：**`);
    for (const item of artifactResults) {
      lines.push(item.url ?? item.path);
    }
  }

  await fs.writeFile(resultPath, lines.join("\n"), "utf-8");
}

export function createTeamCompleteTool(stateDir: string): AnyAgentTool {
  return {
    name: "team_complete",
    description:
      "Mark a team execution as completed. MUST be called by Leader agent when all work is finished. Accepts a result summary and optional final artifact path; uploads the artifact to S3 and writes result.md to the execution output directory. This updates execution status and allows the team to be reused.",
    parameters: TeamCompleteSchema,
    async execute(_toolCallId: string, params: TeamCompleteParams) {
      const { team_id, execution_id, result_summary, final_artifact_paths } = params;

      // 1. Read state file from disk
      let data;
      try {
        data = await readStateFromDisk(stateDir);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to read team state file: ${(err as Error).message}`,
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
              type: "text" as const,
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
              type: "text" as const,
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
              type: "text" as const,
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

      // 5. Upload artifacts (if provided)
      const artifactResults: Array<{ path: string; url: string | null }> = [];
      let uploadError: string | null = null;

      if (final_artifact_paths && final_artifact_paths.length > 0) {
        for (const artifactPath of final_artifact_paths) {
          const uploadResult = await tryUploadArtifact(artifactPath);
          artifactResults.push({
            path: artifactPath,
            url: uploadResult.url,
          });
          if (uploadResult.error) {
            uploadError = (uploadError ? uploadError + " | " : "") + uploadResult.error;
          }
        }
      }

      // 6. Write result.md to execDir/output/
      // Derive execDir from stateDir + team_id + execution_id (same logic as team_execute)
      const execDir = path.join(stateDir, "teams", team_id, "executions", execution_id);
      try {
        await writeResultMd(execDir, result_summary, artifactResults);
      } catch (err) {
        // Non-fatal — log in response but don't abort
        uploadError = (uploadError ? uploadError + " | " : "") +
          `result.md write failed: ${(err as Error).message}`;
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
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                teamId: team_id,
                executionId: execution_id,
                teamStatus: team.status,
                message: "Execution marked as completed. Team is now available for reuse.",
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
