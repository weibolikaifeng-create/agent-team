import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateSoulMd, generateAgentsMd } from "./src/soul-generator.js";
import { TeamStateManager } from "./src/team-state.js";
import { TEMPLATES, scoreTemplate, rankTemplates } from "./src/templates.js";

// ── Templates ────────────────────────────────────────────────────────────

describe("templates", () => {
  it("has at least 5 templates", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  it("each template has required fields", () => {
    for (const t of TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.keywords.length).toBeGreaterThan(0);
      expect(t.workers.length).toBeGreaterThan(0);
      expect(["pipeline", "mapreduce", "supervisor"]).toContain(t.collaborationMode);
    }
  });

  it("scoreTemplate returns 0 for unrelated task", () => {
    const t = TEMPLATES.find((t) => t.id === "deep-research")!;
    expect(scoreTemplate(t, "bake a chocolate cake")).toBe(0);
  });

  it("scoreTemplate returns positive for matching task", () => {
    const t = TEMPLATES.find((t) => t.id === "deep-research")!;
    expect(scoreTemplate(t, "research the AI industry")).toBeGreaterThan(0);
  });

  it("rankTemplates returns best match first", () => {
    const ranked = rankTemplates("write an article about research trends");
    expect(ranked.length).toBeGreaterThan(0);
    // "content-creation" or "deep-research" should rank high.
    const topIds = ranked.slice(0, 2).map((r) => r.template.id);
    expect(topIds.includes("content-creation") || topIds.includes("deep-research")).toBe(true);
  });

  it("rankTemplates filters zero-score templates", () => {
    const ranked = rankTemplates("xyzzy nonsense gibberish");
    expect(ranked.length).toBe(0);
  });
});

// ── TeamStateManager ─────────────────────────────────────────────────────

describe("TeamStateManager", () => {
  let manager: TeamStateManager;
  let tmpDir: string;

  const sampleRecord = () => ({
    teamId: "test-team",
    teamName: "Test Team",
    templateId: "deep-research",
    leaderAgentId: "leader-test-team",
    workers: [{ id: "w1", role: "Worker", responsibility: "Do stuff" }],
    collaborationMode: "pipeline" as const,
    status: "ready" as const,
    createdAt: new Date().toISOString(),
    sessionKey: "session-default",
    executions: [] as { executionId: string; taskPrompt: string; taskName: string; status: "pending" | "running" | "completed" | "failed"; createdAt: string; completedAt?: string }[],
  });

  beforeEach(async () => {
    manager = new TeamStateManager();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-team-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("addTeam and getTeam", () => {
    const record = sampleRecord();
    manager.addTeam(record);
    expect(manager.getTeam("test-team")).toEqual(record);
  });

  it("updateStatus", () => {
    manager.addTeam(sampleRecord());
    manager.updateStatus("test-team", "running");
    expect(manager.getTeam("test-team")?.status).toBe("running");
  });

  it("removeTeam", () => {
    manager.addTeam(sampleRecord());
    manager.removeTeam("test-team");
    expect(manager.getTeam("test-team")).toBeUndefined();
  });

  it("getActiveTeams excludes completed/error", () => {
    const r1 = { ...sampleRecord(), teamId: "t1", status: "ready" as const };
    const r2 = { ...sampleRecord(), teamId: "t2", status: "completed" as const };
    const r3 = { ...sampleRecord(), teamId: "t3", status: "error" as const };
    const r4 = { ...sampleRecord(), teamId: "t4", status: "running" as const };
    manager.addTeam(r1);
    manager.addTeam(r2);
    manager.addTeam(r3);
    manager.addTeam(r4);
    const active = manager.getActiveTeams();
    expect(active.map((t) => t.teamId).sort()).toEqual(["t1", "t4"]);
  });

  it("findReusableTeams matches by templateId, ready status, and sessionKey", () => {
    const r1 = {
      ...sampleRecord(),
      teamId: "t1",
      templateId: "deep-research",
      status: "ready" as const,
      sessionKey: "session-a",
    };
    const r2 = {
      ...sampleRecord(),
      teamId: "t2",
      templateId: "deep-research",
      status: "running" as const,
      sessionKey: "session-a",
    };
    const r3 = {
      ...sampleRecord(),
      teamId: "t3",
      templateId: "brainstorm",
      status: "ready" as const,
      sessionKey: "session-a",
    };
    const r4 = {
      ...sampleRecord(),
      teamId: "t4",
      templateId: "deep-research",
      status: "ready" as const,
      sessionKey: "session-b",
    };
    manager.addTeam(r1);
    manager.addTeam(r2);
    manager.addTeam(r3);
    manager.addTeam(r4);

    // Without sessionKey filter, returns all ready teams with matching templateId
    const allReusable = manager.findReusableTeams("deep-research");
    expect(allReusable.length).toBe(2);
    expect(allReusable.map((t) => t.teamId).sort()).toEqual(["t1", "t4"]);

    // With sessionKey filter, returns only teams from that session
    const sessionAReusable = manager.findReusableTeams("deep-research", "session-a");
    expect(sessionAReusable.length).toBe(1);
    expect(sessionAReusable[0]!.teamId).toBe("t1");

    const sessionBReusable = manager.findReusableTeams("deep-research", "session-b");
    expect(sessionBReusable.length).toBe(1);
    expect(sessionBReusable[0]!.teamId).toBe("t4");

    // With empty string sessionKey, should match teams with empty sessionKey
    const r5 = {
      ...sampleRecord(),
      teamId: "t5",
      templateId: "deep-research",
      status: "ready" as const,
      sessionKey: "",
    };
    manager.addTeam(r5);
    const emptySessionReusable = manager.findReusableTeams("deep-research", "");
    expect(emptySessionReusable.length).toBe(1);
    expect(emptySessionReusable[0]!.teamId).toBe("t5");
  });

  it("persists and restores from disk", async () => {
    manager.addTeam(sampleRecord());
    await manager.saveToDisk(tmpDir);

    const manager2 = new TeamStateManager();
    await manager2.loadFromDisk(tmpDir);
    expect(manager2.getTeam("test-team")?.teamName).toBe("Test Team");
  });

  it("loadFromDisk handles missing file gracefully", async () => {
    await manager.loadFromDisk(tmpDir);
    expect(manager.getAllTeams().length).toBe(0);
  });

  it("getTeamsBySession filters by sessionKey", () => {
    const r1 = { ...sampleRecord(), teamId: "t1", sessionKey: "session-a" };
    const r2 = { ...sampleRecord(), teamId: "t2", sessionKey: "session-b" };
    const r3 = { ...sampleRecord(), teamId: "t3", sessionKey: "session-a" };
    manager.addTeam(r1);
    manager.addTeam(r2);
    manager.addTeam(r3);
    const result = manager.getTeamsBySession("session-a");
    expect(result.map((t) => t.teamId).sort()).toEqual(["t1", "t3"]);
  });

  it("addExecution adds an execution record and sets currentExecutionId", () => {
    manager.addTeam(sampleRecord());
    manager.addExecution("test-team", {
      executionId: "exec-1",
      taskPrompt: "Write an article",
      taskName: "AI Article",
      status: "running",
      createdAt: new Date().toISOString(),
    });
    const team = manager.getTeam("test-team")!;
    expect(team.executions.length).toBe(1);
    expect(team.executions[0]!.executionId).toBe("exec-1");
    expect(team.currentExecutionId).toBe("exec-1");
  });

  it("updateExecutionStatus updates status and sets completedAt", () => {
    manager.addTeam(sampleRecord());
    manager.addExecution("test-team", {
      executionId: "exec-1",
      taskPrompt: "Write an article",
      taskName: "AI Article",
      status: "running",
      createdAt: new Date().toISOString(),
    });
    manager.updateExecutionStatus("test-team", "exec-1", "completed");
    const exec = manager.getTeam("test-team")!.executions[0]!;
    expect(exec.status).toBe("completed");
    expect(exec.completedAt).toBeTruthy();
  });

  it("getNextExecutionId returns incremental IDs", () => {
    manager.addTeam(sampleRecord());
    expect(manager.getNextExecutionId("test-team")).toBe("exec-1");
    manager.addExecution("test-team", {
      executionId: "exec-1",
      taskPrompt: "Task 1",
      taskName: "Task 1",
      status: "running",
      createdAt: new Date().toISOString(),
    });
    expect(manager.getNextExecutionId("test-team")).toBe("exec-2");
  });

  it("persists executions to disk and restores them", async () => {
    manager.addTeam(sampleRecord());
    manager.addExecution("test-team", {
      executionId: "exec-1",
      taskPrompt: "Write an article",
      taskName: "AI Article",
      status: "completed",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await manager.saveToDisk(tmpDir);

    const manager2 = new TeamStateManager();
    await manager2.loadFromDisk(tmpDir);
    const team = manager2.getTeam("test-team")!;
    expect(team.executions.length).toBe(1);
    expect(team.executions[0]!.executionId).toBe("exec-1");
    expect(team.executions[0]!.status).toBe("completed");
  });

  it("loadFromDisk handles old records without executions field", async () => {
    // Simulate an old state file without executions field.
    const teamsDir = path.join(tmpDir, "teams");
    await fs.mkdir(teamsDir, { recursive: true });
    const oldState = {
      version: 1,
      teams: [
        {
          teamId: "old-team",
          teamName: "Old Team",
          templateId: "custom",
          leaderAgentId: "leader-old-team",
          workers: [],
          collaborationMode: "pipeline",
          status: "ready",
          createdAt: new Date().toISOString(),
          // no executions field, no sessionKey field
        },
      ],
    };
    await fs.writeFile(
      path.join(teamsDir, "agent-team-state.json"),
      JSON.stringify(oldState),
      "utf-8",
    );

    await manager.loadFromDisk(tmpDir);
    const team = manager.getTeam("old-team")!;
    expect(team).toBeTruthy();
    expect(Array.isArray(team.executions)).toBe(true);
    expect(team.executions.length).toBe(0);
    expect(team.sessionKey).toBe("");
  });
});

// ── Soul Generator ───────────────────────────────────────────────────────

describe("soul-generator", () => {
  const baseParams = {
    teamId: "test-123",
    teamName: "Test Research Team",
    leaderRole: "Research Director",
    leaderPersonality: "Methodical and thorough.",
    coreInstruction: "Coordinate three-stage research.",
    workers: [
      { id: "researcher", role: "Researcher", responsibility: "Gather data." },
      { id: "analyst", role: "Analyst", responsibility: "Analyze findings." },
    ],
    collaborationMode: "pipeline" as const,
    modeInstruction: "Run sequentially: researcher → analyst.",
    task: "Research AI trends",
  };

  it("generateSoulMd includes all required sections", () => {
    const soul = generateSoulMd(baseParams);
    expect(soul).toContain("Research Director");
    expect(soul).toContain("Methodical and thorough.");
    expect(soul).toContain("Coordinate three-stage research.");
    expect(soul).toContain("researcher");
    expect(soul).toContain("analyst");
    expect(soul).toContain("Research AI trends");
    expect(soul).toContain("sessions_spawn");
    expect(soul).toContain("message");
    expect(soul).toContain("Pipeline Execution Guide");
  });

  it("generateSoulMd uses mapreduce guide for mapreduce mode", () => {
    const soul = generateSoulMd({
      ...baseParams,
      collaborationMode: "mapreduce",
    });
    expect(soul).toContain("Map-Reduce Execution Guide");
  });

  it("generateSoulMd uses supervisor guide for supervisor mode", () => {
    const soul = generateSoulMd({
      ...baseParams,
      collaborationMode: "supervisor",
    });
    expect(soul).toContain("Supervisor Execution Guide");
  });

  it("generateSoulMd includes execution tracking section", () => {
    const soul = generateSoulMd(baseParams);
    expect(soul).toContain("Execution Tracking");
    expect(soul).toContain("todo.md");
    expect(soul).toContain("__execDir__/output/");
    expect(soul).toContain("__executionId__");
  });

  it("generateAgentsMd produces a markdown table", () => {
    const md = generateAgentsMd({
      teamId: "test-123",
      teamName: "Test Team",
      leaderRole: "Director",
      workers: [
        { id: "w1", role: "Worker 1", responsibility: "Task A" },
        { id: "w2", role: "Worker 2", responsibility: "Task B" },
      ],
    });
    expect(md).toContain("# Team: Test Team");
    expect(md).toContain("| Director (Leader)");
    expect(md).toContain("| Worker 1 |");
    expect(md).toContain("| Worker 2 |");
  });
});
