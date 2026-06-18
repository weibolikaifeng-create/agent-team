---
name: agent-team
description: 能够动态编排并创建多智能体团队，将复杂任务拆分给多个专业角色，通过并行、流水线或MapReduce模式协作完成。适用于用户想要使用 Team 模式帮助用户完成任务，当用户要求“使用 Team 模式”，并告知“任务要求”时使用。未明确使用 Team 模式的任务不要触发，避免过度激活。
---

## 工作流

### 1. 规划：`team_plan`

分析任务并获取按优先级排序的模板建议：

```text
team_plan(task: "Research the EV industry trends in China")
```

该工具会返回 JSON，包含：

- **`suggestions`**：排序后的模板建议，关键词匹配分数以百分比表示。
- **`reusableTeams`**：与建议模板匹配的现有团队，你可以复用它们，而不是重新创建。
- **`availableTemplates`**：完整模板目录。
- **`guidance`**：简短的下一步提示。

如果 `suggestions` 为空，说明任务措辞没有匹配到任何模板关键词；你仍然可以选择一个 `template_id` 调用 `team_provision`，也可以创建**自定义**团队。

**🚨 关键：复用团队**

如果 `reusableTeams` 中包含你想复用的团队：

1. **跳过 `team_provision`**，因为团队已经存在。
2. **必须调用 `team_execute`** 并传入新任务，这会创建一个新的执行实例，并使用独立的进度跟踪。
3. **绝不要直接调用 `sessions_send` 给 Leader**，这会绕过执行跟踪并破坏进度监控。

**正确的复用流程：**

```text
team_execute(team_id: "existing-team-abc123", task: "New task here", steps: ["创建 agent 团队", "拆解子任务并分配角色", ...], channel_info: {...})
```

**错误示例，会破坏跟踪：**

```text
sessions_send(agentId: "leader-existing-team-abc123", ...)  ❌ 不要这样做
```

### 2. 创建：`team_provision`

创建 Leader 智能体，即 `leader-<team_id>`；在团队工作区下写入 **AGENTS.md**（Leader 的完整提示词）；将智能体注册到配置中；并把团队记录到插件状态里。

**必填：** `team_id`、`task`，该任务会写入 Leader 的 AGENTS.md 作为使命。

你可以二选一：

- 提供 **`template_id`**，见下方表格；或
- 省略 `template_id`，并提供 **`workers`** 和 **`collaboration_mode`**，可选值为 `pipeline`、`mapreduce`、`supervisor`。

可选覆盖项：`team_name`、`leader_name`（Leader 中文显示名）、`leader_role`、`leader_personality`、`leader_core_instruction`、`workers`。当 `workers` 与 `template_id` 一起使用时，会替换模板中的工作人员配置。

**workers 字段格式：** 每个 worker 包含 `id`（标识符）、`name`（中文显示名，必填）、`role`（角色名）、`responsibility`（职责描述）。

插件会强制限制最大 worker 数量，目前为 5。自定义团队必须保持在该限制内。

示例：

```text
team_provision(
  team_id: "ev-research-2024",
  template_id: "deep-research",
  task: "Research the EV industry trends in China, focusing on..."
)
```

成功后，团队即完成创建。创建过程可能需要一小段时间，因为系统需要写入配置并重新加载网关。

### 3. 执行：`team_execute`

通过创建一个新的执行实例来启动工作，并使用独立的进度跟踪，包括 `todo.md` 和 `output/` 目录。

**关键：** 无论是新团队还是复用团队，这一步都是必需的。绝不要跳过。

**必填参数：**

- `team_id`：要执行任务的团队。
- `task`：给 Leader 的任务描述。
- `steps`：任务专属的进度步骤数组，格式见下方。
- `channel_info`：频道路由信息。

**Steps 格式：** 必须满足以下要求：  
第一步和第二步分别是 `"创建 agent 团队"` 和 `"拆解子任务并分配角色"`；随后每个 worker 一个步骤，包含角色 + 具体主题；最后是综合汇总步骤。

示例：

```text
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

**工具返回内容，JSON：**

- **`sessions_send_params`**：使用这些参数调用 `sessions_send`：
  - `agentId`：Leader 智能体 ID。
  - `sessionKey`：Leader 的 session key。
  - `message`：带有 `__teamId__`、`__executionId__`、`__execDir__` 元数据前缀（非直接输出渠道还会包含 `__channelInfo__`），后面接任务内容。
  - `timeoutSeconds`：`0`，表示 fire-and-forget。

调用 `sessions_send` 并传入这些参数后，告诉用户团队正在工作，然后结束你的回合。Leader 会直接向频道推送更新（webchat/astron-claw 渠道通过文本直接输出，其他渠道通过 message 工具推送）。

**🚨 警告：** 绝不要在没有先通过 `team_execute` 的情况下，直接调用 `sessions_send` 给 Leader。这样会绕过执行跟踪并破坏进度监控。

### 4. 清理：`team_cleanup`

当你不再需要该团队时，或用户取消任务时：

```text
team_cleanup(team_id: "ev-research-2024")
```

这会**从配置中移除 Leader 智能体**，包括相关绑定和 agent-to-agent allow 条目；**将团队状态标记为 completed**（状态记录保留供查阅）；**不会删除**团队工作区文件夹。产物仍会保留在配置的状态目录下，例如 `teams/<team_id>/...`，用户仍然可以访问这些文件。

## 活跃团队，主智能体

当你是**主智能体**时，网关会向你的上下文注入一个 **Active Agent Teams** 区块，列出团队及其状态。

## 可用模板

| 模板                   | 模式      | 工作人员                              | 最适合                  |
| ---------------------- | --------- | ------------------------------------- | ----------------------- |
| `deep-research`        | mapreduce | 2 个搜索专家，并行 → 报告撰写者        | 深度调研                |
| `content-creation`     | pipeline  | 研究员 → 写作者 → 审阅者              | 文章、报告、论文        |
| `data-analysis`        | pipeline  | 收集者 → 分析师 → 可视化专家          | 数据驱动的洞察          |
| `competitive-analysis` | mapreduce | 2 个研究员 → 分析师 → 报告员          | 比较多个对象            |
| `brainstorm`           | mapreduce | 乐观者 + 批判者 + 实用主义者          | 创意构思                |

## 关键：委派规则

**一旦你把任务委派给团队，就绝不能自己执行该任务。** 这是最重要的规则。

- 不要使用 `web_search`、`web_fetch`、`read`、`write`、`exec` 或任何其他工具来完成团队的工作。
- 不要试图通过自己做研究、写内容或执行分析来“帮助”团队。
- 在调用 `team_execute` 以及它要求你调用的 `sessions_send` 之后，你唯一的职责是：
  1. 告诉用户团队正在工作。
  2. 结束你的回合，由 Leader 直接向频道推送更新。

如果团队成员遇到困难，**不要直接介入**。Leader 负责管理工作人员。信任委派链路。

## 向用户说明

在规划团队时，简要告诉用户：

1. 你使用哪个模板，以及为什么。
2. 团队组成，即各角色。
3. 协作方式，即流水线还是并行。

## 处理结果

Leader 会直接向频道推送进度更新（webchat/astron-claw 渠道通过文本直接输出，其他渠道通过 message 工具推送），你不需要转发消息。

### 向团队传递频道信息

`channel_info` 字段：

- `channel`：必填。
- `target`：必填。
- `msg_id`：可选，用于回复或响应。

### 团队完成后

当团队完成任务后，为该 `team_id` 调用 `team_cleanup`。

## 进度与停滞

Leader 会直接向频道推送更新，你不会收到这些更新。如果用户询问状态，请说明这一点。不要从该技能中虚构出 `sessions_spawn` 步骤。