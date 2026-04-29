---
name: agent-team
description: Orchestrate dynamic multi-agent teams for complex tasks that benefit from parallel or pipelined collaboration.
---

# Agent Team Orchestration

You have access to a multi-agent team system. Use it when a task is complex enough to benefit from multiple specialized agents working together.

## When to Use Teams

Consider creating a team when:

- The task requires **multiple distinct skill sets** (research + analysis, writing + review).
- The task benefits from **parallel exploration** (comparing competitors, brainstorming from multiple angles).
- The task has **sequential stages** where each stage's output feeds the next (data collection → analysis → visualization).
- The user explicitly requests a team or collaborative approach.

Do **not** use teams for:

- Simple, single-step tasks you can handle directly.
- Tasks that are already well-defined and don't need decomposition.

## CRITICAL: Delegation Rules

**Once you delegate a task to a team, you MUST NOT do the work yourself.** This is the most important rule.

- Do NOT use `web_search`, `web_fetch`, `read`, `write`, `exec`, or any other tools to do the team's work.
- Do NOT attempt to "help" the team by doing research, writing content, or performing analysis yourself.
- Your ONLY job after `team_execute` (and the required `sessions_send` it tells you to run) is to:
  1. Tell the user the team is working.
  2. End your turn — the Leader will push updates directly to the channel.

If a team member encounters difficulties, **do NOT intervene directly**. The Leader is responsible for managing workers. Trust the delegation chain.

## Workflow

### 1. Plan: `team_plan`

Analyze the task and get ranked template suggestions:

```
team_plan(task: "Research the EV industry trends in China", session_key: "<current_session_key>")
```

Optional: bias toward a template:

```
team_plan(task: "...", preferred_template_id: "deep-research", session_key: "<current_session_key>")
```

**Note:** `session_key` is required to filter reusable teams to the current session. Use the same session key you would pass to `team_provision`.

The tool returns JSON with:

- **`suggestions`** — ranked templates (keyword match score as a percentage).
- **`reusableTeams`** — existing teams in `ready` state that match a suggested template (you may reuse instead of provisioning again).
- **`availableTemplates`** — full catalog.
- **`guidance`** — short next-step text.

If `suggestions` is empty, the task wording did not match any template keywords; you can still call `team_provision` with a `template_id` you choose, or a **custom** team (see below).

**🚨 CRITICAL: Reusing Teams**

If `reusableTeams` contains teams you want to reuse:

1. **Skip `team_provision`** — the team already exists
2. **MUST call `team_execute`** with the new task — this creates a new execution instance with isolated progress tracking
3. **NEVER call `sessions_send` directly** to the Leader — this bypasses execution tracking and breaks progress monitoring

**Correct reuse flow:**
```
team_execute(team_id: "existing-team-abc123", task: "New task here", steps: ["创建 agent 团队", "拆解子任务并分配角色", ...], channel_info: {...})
```

**Wrong (will break tracking):**
```
sessions_send(agentId: "leader-existing-team-abc123", ...)  ❌ DO NOT DO THIS
```

### 2. Provision: `team_provision`

Creates the Leader agent (`leader-<team_id>`), writes **SOUL.md** and **AGENTS.md** under the team workspace, registers the agent in config, and records the team in plugin state.

**Required:** `team_id`, `task` (this is baked into the Leader’s SOUL as the mission), `session_key` (binds the team to the current session).

**Either:**

- Provide **`template_id`** (see table below), or  
- Omit `template_id` and supply **`workers`** and **`collaboration_mode`** (`pipeline` | `mapreduce` | `supervisor`).

Optional overrides: `team_name`, `leader_role`, `leader_personality`, `leader_core_instruction`, `workers` (replaces template workers when combined with `template_id`).

There is a **maximum worker count** enforced by the plugin (currently 5). Custom teams must stay within that limit.

Example:

```
team_provision(
  team_id: "ev-research-2024",
  template_id: "deep-research",
  task: "Research the EV industry trends in China, focusing on...",
  session_key: "<current_session_key>"
)
```

After success, the team is **`ready`**. Provisioning may take a short moment while config is written and the gateway reloads.

### 3. Execute: `team_execute`

Starts work by creating a new execution instance with isolated progress tracking (todo.md and output/ directory).

**CRITICAL:** This step is REQUIRED for both new teams and reused teams. Never skip this step.

**Required parameters:**
- `team_id`: The team to execute
- `task`: Task description for the Leader
- `steps`: Array of task-specific progress steps (see format below)
- `channel_info`: Channel routing information

**Steps format:** Must include (1) "创建 agent 团队" and "拆解子任务并分配角色" as first two steps, (2) one step per worker with role + specific topic, (3) final synthesis step. Example:

```
team_execute(
  team_id: "ev-research-2024",
  task: "Research the EV industry trends in China, focusing on...",
  steps: [
    "创建 agent 团队",
    "拆解子任务并分配角色",
    "搜索专家1: 调研中国电动车市场规模与增长趋势",
    "搜索专家2: 调研中国电动车政策与补贴变化",
    "整合搜索结果并撰写中国电动车行业趋势报告"
  ],
  channel_info: { channel: "feishu", target: "ou_xxx", msg_id: "msg_xxx" }
)
```

**What the tool returns (JSON):**

- **`sessions_send_params`** — call `sessions_send` with these parameters:
  - `agentId`: Leader agent ID
  - `sessionKey`: Leader’s session key
  - `task`: includes `__channelInfo__` prefix with channel routing information
  - `timeoutSeconds`: `0` (fire-and-forget)

Call `sessions_send` with these params, tell the user the team is working, then end your turn. The Leader pushes updates directly to the channel.

**Team state:** `team_execute` succeeds when the team is **`ready`** or **`running`**. Avoid calling `team_execute` again for the same team while a run is already in progress unless you intend to send another task (which can duplicate work).

**🚨 WARNING:** Never call `sessions_send` directly to a Leader without going through `team_execute` first. This will bypass execution tracking and break progress monitoring.

### 4. Cleanup: `team_cleanup`

When you no longer need the team (or if the user cancels):

```
team_cleanup(team_id: "ev-research-2024")
```

This **removes the Leader agent from config** (including related bindings and agent-to-agent allow entries), **removes the team from plugin state**, and **does not delete** the team workspace folder — artifacts remain on disk under the configured state directory (`teams/<team_id>/...`) so the user can still access files.

## Active teams (main agent)

When you are **main**, the gateway injects an **Active Agent Teams** section into your context listing teams and their status.

## Available Templates

| Template               | Mode      | Workers                             | Best For                  |
| ---------------------- | --------- | ----------------------------------- | ------------------------- |
| `deep-research`        | mapreduce | 2 search specialists (parallel) → report writer | In-depth investigation    |
| `content-creation`     | pipeline  | researcher → writer → reviewer      | Articles, reports, essays |
| `data-analysis`        | pipeline  | collector → analyst → visualizer    | Data-driven insights      |
| `competitive-analysis` | mapreduce | 2 researchers → analyst → reporter  | Comparing subjects        |
| `brainstorm`           | mapreduce | optimist + critic + pragmatist      | Creative ideation         |

## Presenting to Users

When you plan a team, briefly tell the user:

1. Which template you’re using and why.
2. The team composition (roles).
3. How the collaboration will work (pipeline vs. parallel).

## Handling Results

The Leader pushes progress updates directly to the channel using the `message` tool. You do NOT need to relay messages.

### Passing channel info to the team

`channel_info` fields: `channel` (required), `target` (required), `msg_id` (optional, for reply/react).

### After team completion

Call `team_cleanup` for that `team_id` when the team is done.

## Progress and stalls

The Leader pushes updates directly to the channel — you do not receive them. If the user asks for status, explain this. Do not invent a `sessions_spawn` step from this skill.
