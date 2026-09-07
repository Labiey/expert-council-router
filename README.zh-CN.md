# Expert Council

[English](README.md) | [简体中文](README.zh-CN.md)

Expert Council 是一个面向 Pi 与 Codex 等 MCP 宿主的本地、多模型、成本感知专家编排系统。它会发现 Pi 当前注册的 LLM API 与 Coding Plan 中连接的模型，将运行时元数据与用户定义的计费策略、能力画像和本地可靠性数据结合，动态组建一个精简的语义专家团队，并通过 Pi 执行有明确边界的任务，最后向主代理返回紧凑的结构化结果。

主要优势：

| 优势 | 说明 |
|---|---|
| 省钱 | 灵活运用所订阅的 Plan 和 LLM API，根据任务难度自动调配最合适的模型 |
| 快速 | 可同时并发多个最合适的模型进行工作，快速完成仓库探索与上下文压缩 |
| 更安全 | 为不同专家分配不同的只读/可写权限，可写专家在 Git worktree 写入后经主代理审查后并入主分支 |
| 上下文节省 | 主代理不再需要包含过多工具调用产生的冗长上下文，只接收专家返回的摘要化处理结果 |

Expert Council在首次运行时会调用网络聚合搜索模型能力评价刻画当前可用的模型能力画像； 
在实践中发现，理论上最强的模型不一定是最合适的执行者。一个工具调用稳定、Shell 行为可靠、边际成本较低的模型，可能比更强但执行不稳定的模型拥有更高的实际任务价值。推荐配置执行能力强、成本较低的模型作为主代理，当遇到复杂问题时 Expert Council 可派遣强思考能力模型进行审查或 Plan。

## 当前状态

当前版本（0.5.5）已包含：

- 与宿主无关的 Core：配置校验、模型归一化、计费策略、画像分层、角色评分、任务分类、动态团队规模、重试/升级和遥测聚合。
- 基于 Pi 当前 `ModelRuntime` 与 `createAgentSession` API 的执行运行时。
- 每个专家会话的硬工具白名单和已安装 Skill 过滤。
- 写入型专家的独立 Git worktree 隔离。
- 支持 JSON 输出的 CLI。
- 包含 10 个异步语义工具、事件驱动完成等待、验收反馈闭环及显式 worktree 清理能力的 MCP Server。
- 原生 Pi Package。
- 运行时可用性标记：调用失败带失效模型证据时，自动把该模型标记进持久化评估，后续组建、委派与升级硬性规避，24 小时后自动过期重试。
- 提供商会话错误透传：`403 AccessDenied` 等上游拒绝不再被吞掉，会以真实诊断和正确失败类型返回主代理。
- 跨进程共享模型评估：多实例并行时，可用性标记无需重启即可互相可见。
- 自包含的 Codex 插件，内置共享 Skill、stdio MCP Server 与经过验证的 Pi SDK 运行时，通过 Codex 宿主自有的 `codex/sandbox-state-meta` 能力发现工作区（无需 hook 或全局 SDK 解析）。
- 不会消耗模型额度的确定性自动化测试。

## 架构

```text
Codex 或 Pi 主代理
        |
        | 语义工具 / 共享 Skill
        v
 Expert Council Core
 - 资源与模型归一化
 - 计费与能力画像
 - 确定性路由
 - 角色与团队规模
 - 重试与升级
 - 遥测聚合
        |
        v
     Pi Runtime
 - 可调用模型发现
 - 工具硬白名单
 - 已安装 Skill 过滤
 - 有边界的专家会话
 - 工作区隔离
     /     |      \
   CLI  Pi Package  MCP Server
                        |
                   Codex 插件
```

TypeScript project references 保证依赖只能按以下方向流动：

```text
core <- pi-runtime <- cli
                   <- mcp-server <- codex-integration
                   <- pi-package
```

Core 不导入 Pi、Codex、MCP transport、文件系统、Shell 或进程 API。CLI、MCP Server 和宿主分发层使用的是同一套服务与路由逻辑。

## 快速开始

环境要求：

- Node.js 22.19 或更高版本。
- npm 11 或兼容版本。
- 已安装并配置至少一个可用模型的 Pi。
- 当写入型专家需要 worktree 隔离时，Git 仓库必须至少有一个提交。

### 安装 Pi Package

从 npm 安装（推荐）：

```bash
pi install npm:@expert-council/pi-package
pi list
pi --verbose
```

`pi list` 应显示 `npm:@expert-council/pi-package` 及其解析后的目录；新启动的 verbose Pi 会话应加载 `dist/extension.js`、`expert-council` Skill 和 10 个语义工具。后续升级：

```bash
pi update npm:@expert-council/pi-package
```

### 安装 Codex 插件（可选）

若要由 Codex 担任主代理，可直接从 Git Marketplace 安装固定版本的预构建插件，无需克隆仓库或在本地构建：

```bash
codex plugin marketplace add Labiey/expert-council-router --ref v0.5.5 --json
codex plugin add expert-council@expert-council-router --json
```

安装后请完全重启 Codex Desktop。插件自带经过测试的 Pi SDK 运行时，运行时不依赖全局安装的 `pi` 包；但仍需至少安装并配置过一次 Pi（或手动把提供商凭据放入 `~/.pi`），账号与模型目录才可用。Windows CLI 定位、验证、升级和卸载步骤见 [Codex 插件](#codex-插件)。

### 从源码构建（开发）

```bash
npm install
npm run build
npm test
```

只发现模型，不调用任何模型：

```bash
node packages/cli/dist/bin.js models --json
node packages/cli/dist/bin.js inspect --json
```

只构建专家团队，不执行专家：

```bash
node packages/cli/dist/bin.js build "修复设备热插拔竞态问题" --max-experts 4 --json
```

只有在你确定需要实际调用 Pi 模型时才执行委派：

```bash
node packages/cli/dist/bin.js delegate architecture-oracle "分析并发调用路径" --workspace /path/to/repo --json
```

零配置模式会使用保守的能力默认值，将无法确认的计费类型标记为 `unknown`，并拒绝未隔离的写入操作。它不会猜测某个 API 是免费的，也不会根据模型名称臆测其能力强弱。

## 模型发现

`PiExpertRuntime` 调用 Pi 的 `ModelRuntime.getAvailable()`，而不是使用硬编码模型列表。仅仅出现在模型注册表或用户画像中的模型不会自动进入路由；只有 Pi 报告当前可调用的模型才会被使用。

运行时会归一化以下信息：

- Provider 与模型 ID；
- 显示名称；
- 推理支持以及 Pi 暴露的推理等级映射；
- 上下文窗口和最大输出；
- 输入模态；
- 已发布的 API 价格字段；
- 安全的兼容性元数据。

运行时会依次尝试解析本地兼容 Pi SDK、`PI_CODING_AGENT_MODULE` 指定目录，以及全局 npm Pi 安装。若全部失败，会返回可操作的诊断信息，而不是伪造模型列表。

Pi 在每个会话内只构建一次这份清单，且提供商目录可能保留失效的模型名称，因此 `listAvailableModels()` 可能包含一个上游已无法服务的模型。在真实调用失败之前，路由会把它视为可调用；这正是带失效模型证据的失败会在持久化模型评估中标记该模型不可用的原因（见下文路由一节）。标记会在 24 小时后过期，恢复的模型会自动重新被尝试。

## 配置

通过 `EXPERT_COUNCIL_CONFIG` 环境变量，或 CLI 的 `--config PATH` 参数指定配置文件。可以从 [`config/examples/balanced.example.json`](config/examples/balanced.example.json) 开始。

画像优先级为：

```text
内置保守默认值
  < 用户配置或可选预设
  < 当前任务运行时覆盖
```

客观运行时元数据单独合并。本地结果数据只有在积累至少 3 个样本后才会影响路由，而且调整幅度受 `routing.localLearningMaxAdjustment` 限制。显式用户配置始终拥有更高权威。

### 计费策略

支持以下计费类型：

```text
subscription  metered  quota  free  unknown
```

边际成本和使用偏好是两个独立字段，因为公开 Token 单价无法表达订阅计划、固定额度、本地推理和促销额度。Pi Runtime 适配器会把运行时明确报告的订阅或具名 Token Plan 目录识别为 `subscription`；否则，Pi 模型目录存在非零单价的 Provider 识别为 `metered`，没有可靠证据的保持 `unknown`。`expert_inspect` 会返回推断来源，显式用户配置始终具有最高优先级。同一按量 Provider 内的模型仍会通过 `routing.apiPriceWeight`（默认 `0.35`）比较具体单价；全零价格表按“未提供”处理，不会猜测为免费。

**按模型的计费条目。** 订阅 token plan 带有周期配额（常见为周限额）且各模型消耗倍率不同，单一 provider 级档位无法表达真实边际成本。为特定模型增加 `provider/id` 键即可覆盖 provider 默认值——路由先查显式 `billingProfile`，再查模型级条目，最后才是 provider 级。同样的键也可用于 `model-assessment.json` 的 billing 段与用户配置：

```json
{
  "billing": {
    "providers": {
      "subscription-provider": {
        "billingType": "subscription",
        "marginalCostClass": "very-low",
        "usagePreference": "consume-first"
      },
      "subscription-provider/qwen3.8-max": {
        "billingType": "subscription",
        "marginalCostClass": "low",
        "usagePreference": "consume-first"
      },
      "scarce-provider": {
        "billingType": "quota",
        "marginalCostClass": "scarce",
        "usagePreference": "escalation-only"
      }
    }
  }
}
```

`config/examples/` 提供以下示例：

- `balanced.example.json`：适用于零配置的保守策略。
- `subscription-heavy.example.json`：优先消耗订阅资源，保护稀缺额度。
- `metered-quality.example.json`：区分经济型与高质量按量 API。
- `qwen-glm.example.json`：明确标记为假设性用户偏好的示例，不代表客观评测结论。

### 能力画像

模型可以在以下维度获得 0 到 10 分的用户评分：

```text
reasoning planning architecture coding debugging review longContext
toolReliability bashReliability autonomousExecution speed
```

模型键必须使用 `models --json` 返回的精确 `provider/model`。新发现或没有本地画像的模型会获得保守默认值；不可用模型的残留配置只会产生警告，不会导致路由崩溃。

### 主代理能力审查与首次组建偏好

用户不需要逐个模型维护使用优先级。主代理决定当前任务值得组建委员会后，如果这是新对话中的第一个委员会且用户尚未表达偏好，应先询问一次：

```text
价格优先（economy）
综合价格、时间与成功率（balanced）
速度优先（speed）
```

Pi Package 把选择记录在当前 Pi Session 的隐藏扩展状态中；本对话后续委员会自动复用，除非用户主动改变。`economy` 会增强成本权重，`speed` 会增强经过审查的速度维度，`balanced` 使用正常的角色权重。旧的 `quality` API 值保留兼容，但不会作为默认提问选项。

模型能力由主代理审查，而不是要求用户手工排序。`expert_inspect` 会返回强制评估门禁：若尚无审查、审查已超过 30 天、可调用模型发生变化，或用户明确要求重新审查，主代理必须使用宿主已经具备的联网工具研究门禁列出的每个可调用模型；完成前 `expert_build` 不会组建委员会。主代理提交一份完整 `modelAssessment`，其中 ISO 时间必须读取宿主真实时钟，来源应合并为 1–12 个 URL，并包含 0–10 能力维度及可验证 Provider 访问/计费方式。未来时间戳会单独报告，修正时间时无需重新联网研究。若检查结果表明已保存评估仍为 `current`，宿主调用 `expert_build` 时应省略 `modelAssessment`；不完整、过期或未来时间的替代表不能覆盖当前有效快照。评估在当前用户数据目录只保存一份，只要可调用模型清单仍兼容，新对话和其他工作区都直接复用；普通计划和执行状态保存只保留全局评估，不会让持有旧内存快照的服务实例覆盖它，只有显式提交并成功通过门禁的新评估才会全局替换旧评分。显式用户计费配置始终高于主代理判断，不能确认的计费方式保持 `unknown`。

推荐交叉验证而不是信任单榜：[Artificial Analysis Data API](https://artificialanalysis.ai/data-api/docs) 可提供 Coding、Agentic、价格、吞吐与延迟数据，[LiveBench](https://livebench.ai/) 提供 Coding 与 Agentic Coding，[Arena](https://arena.ai/leaderboard/text) 反映人类偏好，Provider 官方资料用于核对版本、上下文、工具与访问方式。[OpenRouter Rankings](https://openrouter.ai/rankings?category=programming) 主要反映实际使用量，只作为采用度信号，不能单独证明模型质量。门禁要求审查而宿主没有联网工具时，主代理必须说明限制并停止组建，不能静默使用未经审查的默认值；Expert Council 不会自动安装插件、Skill 或第三方可执行包。

### 角色权重

每个语义角色都有归一化默认权重。Implementation Worker 更重视工具可靠性、编码、自治执行与 Shell 可靠性；Architecture Oracle 更重视架构、规划、长上下文与审查。

```json
{
  "routing": {
    "roleWeights": {
      "implementation-worker": {
        "toolReliability": 0.4,
        "coding": 0.3,
        "costEfficiency": 0.1
      }
    }
  }
}
```

权重会自动重新归一化。`costPolicy: economy` 会提高成本因素的影响，`speed` 会提高速度并降低成本因素的影响，旧的 `quality` 会降低成本因素；它们都不会绕过安全或兼容性硬约束。

## 语义角色与团队规模

角色由任务语义定义，不与任何模型名称绑定：

| 角色 | 默认权限 | 目的 |
|---|---|---|
| Planner | 只读 | 任务拆解、依赖与风险 |
| Scout | 只读 | 仓库探索与上下文压缩 |
| Architecture Oracle | 只读 | 困难跨文件推理与第二意见 |
| Implementation Worker | 可写 | 有边界的代码修改和聚焦测试 |
| Debugger | 可写 | 复现、定位、修复和验证 |
| Reviewer | 只读 | 回归、边界条件和设计审查 |
| Verifier | 只读 | 检查已报告的测试、Diff 与验收标准 |

微小任务只使用一个 Worker；普通任务使用 Worker 与 Verifier；复杂功能使用 Planner、Worker、Reviewer 与 Verifier；复杂调试使用 Scout、Debugger、Oracle 与 Verifier。`maxExperts` 会限制团队规模，主代理永远不会再被复制成一个多余的 `lead` 专家。

任务分类和全部评分运算都是确定性的。宿主可以在委派前检查已选模型、备选模型、分数和简明理由。组建 Council 时还会应用可配置的多样性惩罚；Reviewer 会在经济合理时优先选择与先前成员不同的 Provider 和推断模型家族，但角色适配度与硬约束仍然优先。

## 路由过程

```text
发现当前可调用候选模型
  -> 应用硬约束
  -> 合并能力与画像层
  -> 计算角色适配度和有效成本
  -> 保守应用本地结果调整
  -> 使用稳定规则排序
  -> 返回选择、备选项和理由
```

硬约束会排除不可用或已禁用模型、不兼容角色、工具可靠性不足、上下文不足、运行时不支持写入、日常任务中的 `escalation-only` 资源，以及带有活跃运行时可用性标记的模型。

Pi 会在会话内缓存模型清单，提供商目录也可能保留失效的模型名称，否则 Council 可能围绕一个上游已无法服务的模型组建。当一次委派尝试以 `provider_error` 失败且带失效模型证据（例如 `model_not_found`、未知或已停产的模型、以及运行时自身的预检可用性检查）时，服务会通过一次原子 read-modify-write 把 `modelAvailability` 标记写入持久化的共享模型评估（`EXPERT_COUNCIL_DATA_DIR`，Windows 上即 `%LOCALAPPDATA%/ExpertCouncil/model-assessment.json`），且不会回退其他正在运行的 Pi/Codex 实例写入的更新快照。受影响的 `expert_result` 会在 `executionMetadata.unavailableModels` 和 `risks` 中点名该模型，`expert_inspect` 会警告活跃标记，后续 `expert_build`、委派和升级会以硬约束拒绝被标记的模型。标记是保守的本地证据：24 小时后自动过期，在提交全新审计时保留，并且显式的 `modelOverrides["provider/model"].overrideUnavailableMarker: true` 可以重新启用某个模型。限流或认证错误等瞬态提供商失败永远不会产生标记。若尚无已保存的评估，标记无法持久化，但失败仍会报告给主代理并记入本地遥测。

推理等级是可选且与模型相关的。只有当 Pi 明确暴露选定模型支持某个等级时，角色偏好才会生效；否则 Pi 会保留或钳制到模型支持的默认值。

## Skill 与最小权限

平台无关的主代理指导唯一源文件是 [`shared/skills/expert-council/SKILL.md`](shared/skills/expert-council/SKILL.md)。构建过程会把它与 `shared/skills/expert-council/hosts/` 下的小型宿主适配层合成，生成不同的 Pi 与 Codex `SKILL.md`，而不复制公共工作流。Pi 产物只说明完成后的 `steer`/`followUp` 行为，完全不暴露 `expert_wait`；Codex 产物才说明有限时的 `expert_wait` 流程。共享角色提示位于 `packages/core/src/roles/prompts/`，作为包资源复制，而不是为不同宿主重复编写。

只读角色永远不会获得 `edit`、`write`、`bash` 或 `powershell`，即使调用者试图把它们加入工具列表。Pi 会话使用真实的 `tools` allowlist，因此它比仅靠 Prompt 约束更强。在提供专用的无副作用命令运行器之前，需要 Shell 执行测试的任务应交给隔离 worktree 中的写入型角色。

系统只会激活已经安装并启用、且当前角色需要的 Pi Skill。用户级 Skill 默认可信；项目级和临时 Skill 默认排除，只有名称精确列入 `security.trustedSkills` 才能启用。每个专家资源加载器都会禁用扩展、Prompt 模板、主题和项目上下文文件；无法强制这些策略的 Pi SDK 版本会被拒绝。Expert Council 不会下载或安装任何 Skill 或可执行扩展。

专家提示要求：修改前先阅读、验证路径、优先局部编辑、失败后诊断再换方法、使用有限时非交互命令、检查执行结果、禁止递归委派，并返回紧凑 JSON，而不是私人思维过程。

## 重试与升级

失败类型会被归一化为：

```text
tool_call_error reasoning_failure test_failure timeout provider_error
missing_context permission_error unknown
```

默认情况下，第一次可纠正的工具、上下文或测试失败最多获得一次改变方法后的重试。重复的相关失败或 Provider 错误会切换到下一个符合条件且尚未尝试的模型。尝试次数与升级次数分别设有上限；没有候选或预算耗尽时，未解决状态会返回主代理。

系统不存在无限循环，也不会按策略盲目重复同一种失败操作。

## 结构化结果与上下文效率

专家结果包含状态、角色、模型、摘要、修改文件、测试、发现、风险、下一步建议、失败类型、Pi 可提供的近似用量，以及有限的执行元数据。系统优先使用专家返回的结构化失败类型，并确定性识别测试、Provider、工具和上下文失败；无法解析的非 JSON 输出会标记为 `reasoning_failure`。系统不会请求或保存私有思维过程，也不会把整份源码复制回主代理上下文。

## 工作区安全

系统不会因为 Codex 自身处于沙箱就假设外部 Pi 进程同样安全。Pi Runtime 使用独立边界：

1. 规范化请求工作区路径。
2. 要求路径位于允许的根目录内。
3. 从仓库当前 `HEAD` 在系统临时目录内当前用户专属的私有目录中创建 detached worktree。
4. 在该 worktree 中为 Worker 提供写入工具。
5. 返回 worktree 路径和修改文件列表。
6. 由 Codex 或 Pi 主代理检查、整合并最终验收。
7. 整合或拒绝结果后调用 `expert_cleanup`。一次调用会删除该 execution ID 因重试或升级创建的全部 worktree，并返回所有已删除路径。无人认领的 worktree 会在 `security.worktreeRetentionMs` 后自动清理，默认保留 24 小时，并同步 prune Git 元数据。

非 Git 工作区默认拒绝写入。若确实需要原地修改，必须显式配置：

```json
{
  "security": {
    "workspaceStrategy": "bounded-in-place",
    "allowInPlaceMutations": true,
    "allowedWorkspaceRoots": ["/absolute/path/to/project"]
  }
}
```

启用前请阅读 [`SECURITY.md`](SECURITY.md)。

## 遥测与本地学习

默认用户数据根目录为：Windows `%LOCALAPPDATA%\ExpertCouncil`，Linux `$XDG_STATE_HOME/expert-council` 或 `~/.local/state/expert-council`，macOS `~/Library/Application Support/ExpertCouncil`。共享的 `telemetry.jsonl` 保存不透明执行结果，使实际可靠性能够跨对话和工作区复用；同一 execution 的反馈会覆盖早期样本，不会重复计数。共享的 `model-assessment.json` 保存最新的显式能力与计费评分，以及运行时学习到的模型可用性标记。可用 `EXPERT_COUNCIL_DATA_DIR`、`EXPERT_COUNCIL_TELEMETRY`、`EXPERT_COUNCIL_MODEL_ASSESSMENT` 和 `EXPERT_COUNCIL_STATE` 覆盖位置。

它不会记录 Prompt、源码内容、凭据、API Key、Secret 或思维过程。聚合指标包括按角色成功率、首轮成功率、工具错误率、重试率、验证通过率和平均尝试次数。Expert Council 没有远程分析端点。

计划、执行状态和已完成结构化结果仍按工作区隔离，保存在 `workspaces/<工作区哈希>/state.json`。进程重启后仍可查询；重启时仍在运行的任务会被关闭为明确的中断失败。旧版项目内 `.expert-council` 和 `%USERPROFILE%\.expert-council` 目录不会被自动删除。

## CLI

CLI 与 MCP、Pi Package 使用完全相同的 Core 和 Pi Runtime：

```text
expert-council models
expert-council inspect
expert-council build <task>
expert-council delegate <role> <task>
expert-council feedback <execution-id> --verification passed|failed
expert-council cleanup <execution-id>
expert-council status
```

常用参数：

- `--json`：机器可读输出。
- `--cwd`：项目工作区。
- `--config`：用户策略文件。
- `--telemetry`：自定义本地遥测路径。
- `--state`：自定义持久化计划、执行和结果状态路径。
- `--timeout-ms`：专家执行超时。

## MCP Server

MCP 表面刻意保持为 10 个语义工具：

- `expert_inspect`
- `expert_build`
- `expert_delegate`
- `expert_wait`
- `expert_result`
- `expert_abort`
- `expert_feedback`
- `expert_cleanup`
- `expert_escalate`
- `expert_status`

`expert_inspect` 和 `expert_build` 默认返回面向宿主的紧凑视图。只有确实需要准确模型元数据、备选项、评分、工具或 Skill 时才传入 `detail: "full"`。

### 路由策略文件

模型黑白名单保存在共享状态目录中与 `model-assessment.json` 同级的 `route-policy.json`——不新增任何工具。文件包含所有会话共同遵守的 `system` 条目，以及按宿主会话键组织的 `sessions` 条目（Pi 会话 ID 在 resume 后保持不变；MCP stdio 会话使用稳定的 `"default"` 键）。会话只能收紧系统策略：deny 取并集、allow 取交集、deny 恒胜。条目为 `provider/id` 或裸 `provider`（整个供应商）。`expert_inspect` 会返回本会话的 `sessionKey`、当前 `effective` 策略与文件 `sourcePath`，宿主（或你）可以直接编辑该文件；改动在下次专家调用即生效，超过 30 天的会话条目自动清理，损坏文件会带警告忽略。

```json
{
  "version": 1,
  "system": { "deny": ["bailian"] },
  "sessions": {
    "4f0c…": { "allow": ["qwen-token-plan-cn/qwen3.8-max"], "updatedAt": "2026-09-07T02:00:00+08:00" }
  }
}
```

`expert_delegate` 会启动后台任务并立即返回 execution ID，原有单任务参数保持兼容。主代理应根据任务难度为每项任务显式设置 `timeoutMs`，而不是依赖运行时的十分钟兜底值。存在两个以上相互独立的任务时，应在继续其他主代理工作前一次发配整个批次：

```json
{
  "assignments": [
    { "role": "scout", "task": "定位相关文件", "taskDescription": "仓库映射", "timeoutMs": 300000 },
    { "role": "reviewer", "task": "审查边界设计", "taskDescription": "边界审查", "timeoutMs": 600000 }
  ]
}
```

`assignments` 必须是实际 JSON 数组，不能是包含 JSON 文本的字符串。原生 Pi 适配器对部分模型偶发的字符串化数组提供有界兼容解析，但正常调用仍应直接生成数组。

可选的 `taskDescription` 是供宿主识别任务的简短标签，不属于专家实际任务内容。派发后主代理应继续所有可独立完成的工作；无其他有用工作时，调用一次 `expert_wait`，传入最多 8 个 execution ID、通常使用 `mode: "all"`（任一早期结果即可推进时使用 `"any"`），并按预计剩余难度设置 `timeoutMs`。等待由执行 Promise 的完成事件驱动而不是轮询；阻断当前 MCP 调用属于预期行为，等待期间不会继续消耗主模型 Token。

```json
{
  "executionIds": ["exec_a", "exec_b"],
  "mode": "all",
  "timeoutMs": 900000
}
```

`expert_wait` 只返回完成状态和任务 ID，随后使用 `expert_result` 获取正式反馈，并在主代理验收后调用 `expert_feedback`。`expert_wait.timeoutMs` 只限制本次等待，不会延长各专家自己的执行期限。所有可能阻断的 Expert Council、Bash、PowerShell 或其他 MCP 调用仍必须按操作难度附带显式的有限超时；其余同步 Expert Council 操作受独立的 30 秒 Server 内部上限保护。`expert_status` 会返回有界的逐次尝试历史。原生 Pi Package 使用主动完成通知，因此不暴露 `expert_wait`。

直接启动 stdio Server：

```bash
node packages/mcp-server/dist/bin.js
```

支持以下环境变量：

- `EXPERT_COUNCIL_WORKSPACE`：默认允许工作区。
- `EXPERT_COUNCIL_CONFIG`：用户 JSON 配置。
- `EXPERT_COUNCIL_TELEMETRY`：本地遥测 JSONL 路径。
- `EXPERT_COUNCIL_STATE`：持久化计划、执行和结果状态路径。
- `EXPERT_COUNCIL_MCP_TIMEOUT_MS`：同步 MCP 操作的有限超时，默认 30000 毫秒。
- `PI_CODING_AGENT_MODULE`：自动解析失败时显式指定 Pi 包目录。

环境变量覆盖和 CLI 路径参数属于“受信任的操作者输入”。其中 `PI_CODING_AGENT_MODULE` 会加载可执行代码，配置、工作区、遥测和状态路径会选择本地文件；不要从不受信任仓库、任务文本或模型输出中接受这些值。

## 原生 Pi Package

日常使用推荐通过 npm 安装（见[快速开始](#安装-pi-package)）；本节面向源码开发与本地候选版验证。

在仓库根目录构建并安装本地候选版。即使在 Windows 上，只要命令可能经过 Pi 的 Bash 兼容 Shell，也应使用正斜杠；未正确引用的 `.\packages\pi-package` 会在到达 Pi 前丢失反斜杠。

```bash
npm run build
pi install "./packages/pi-package"
pi list
pi --verbose
```

`pi list` 应显示配置中的 source 及解析后的绝对 Package 目录。新启动的 verbose Pi 会话应显示 `dist/extension.js`、`expert-council` Skill，以及不含 `expert_wait` 的 8 个语义工具。已经运行的 Pi 进程不会热加载重新构建或已移除的 Package。

或仅在当前运行中临时加载：

```bash
pi --verbose -e "./packages/pi-package"
```

无费用装载检查只需让 Pi 调用 `expert_inspect`。真实编排检查应在新对话中组建一个只读委员会，一次性批量派发两个相互独立的只读任务，确认 `expert_delegate` 立即返回 execution ID，再用 `expert_result` 和 `expert_feedback` 验收每个完成结果。若测试写入型专家，还应确认一次 `expert_cleanup` 会在 `workspaces` 中报告该 execution 的全部重试 worktree，且随后 `git worktree list` 只剩主工作区。

移除持久安装前，先退出所有已经加载该 Package 的 Pi 进程，然后仍在仓库根目录执行：

```bash
pi remove "./packages/pi-package"
pi list
```

如果当前目录已经变化，请改用解析后的绝对路径。PowerShell 示例：

```powershell
$ecPiPackage = (Resolve-Path "./packages/pi-package").Path
pi remove "$ecPiPackage"
pi list
```

如果通过 Pi 的 Bash 兼容 Shell 执行移除，请使用 `pi list` 第二行显示的正斜杠绝对路径，例如 `pi remove "C:/path/to/ExpertCouncil/packages/pi-package"`。不要直接复制 `pi list` 中缩进显示的相对 source，除非命令也从相同的 settings 目录上下文解析。

Pi 会通过当前包清单中的 `pi.extensions` 与 `pi.skills` 加载 `dist/extension.js` 和同步后的 `expert-council` Skill。扩展注册 8 个语义工具；由于原生 Pi 已提供完成 `steer`/`followUp`，因此省略 MCP 专用的 `expert_wait`。它不包含另一套路由实现。

Pi 委派是非阻断式的；一个调用最多可在返回前启动 8 个相互独立的后台任务。专家完成后，扩展发送精简 JSON：必含已完成的 `executionId`，仅在调用时提供过 `taskDescription` 才包含该描述，绝不直接携带 feedback。主 Agent 工作中时通知使用 `steer`；主 Agent 空闲时使用带 `triggerTurn` 的 `followUp` 立即唤醒。随后由主 Agent 调用 `expert_result` 获取结构化反馈。主 Agent 应先发完当前已准备好的整个批次再结束回合，之后不要轮询或静默等待消耗 token。

## Codex 插件

Codex 插件让 Codex 成为主代理：它内置共享的 `expert-council` Skill 与 stdio MCP Server，专家通过 Pi 执行。插件不包含任何 hook——服务器优先使用 MCP roots，其次从 Codex 宿主自有的 `codex/sandbox-state-meta` 能力解析当前任务工作区，最后回退到 `EXPERT_COUNCIL_WORKSPACE` 覆盖项，并且拒绝把插件安装目录当作工作区。

构建产物根目录：

```text
packages/codex-integration/plugin/expert-council/
  .codex-plugin/plugin.json
  .mcp.json
  skills/expert-council/SKILL.md
  dist/server.mjs
  dist/roles/*.md
  THIRD_PARTY_NOTICES.md
```

### 安装

`v0.5.2` 已包含预构建 MCP Server 及经过验证的 Pi SDK 运行时，Codex 可以直接把本仓库作为固定版本的 Git Marketplace 安装。运行时需要 Node.js 22.19 或更高版本，以及已经配置好的 Pi 账户/模型目录；无需克隆仓库、执行 `npm install`，也不再依赖从全局 npm 目录解析 `@earendil-works/pi-coding-agent`。

```bash
codex plugin marketplace add Labiey/expert-council-router --ref v0.5.5 --json
codex plugin marketplace list --json
codex plugin list --marketplace expert-council-router --available --json
codex plugin add expert-council@expert-council-router --json
codex plugin list --json
```

每个发布版本只需执行一次 `marketplace add`。如果已经用旧版本或本地路径注册了同名 Marketplace，请先移除旧来源，或按下方升级流程操作。`plugin list --json` 应显示 `expert-council` 已从 `expert-council-router` 安装。

Windows 版 Codex Desktop 内置 CLI，但它可能不在 `PATH` 中。可以在 PowerShell 定位正在运行的 Desktop CLI，再执行同样的远程安装命令：

```powershell
$ecCodex = (Get-Command codex.exe -ErrorAction SilentlyContinue).Source
if (-not $ecCodex) {
    $ecCodex = Get-Process codex -ErrorAction SilentlyContinue |
        Where-Object Path |
        Select-Object -First 1 -ExpandProperty Path
}
if (-not $ecCodex) {
    $ecCodex = Get-ChildItem (Join-Path $env:LOCALAPPDATA "OpenAI/Codex/bin") `
        -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ecCodex) { throw "未找到 Codex Desktop CLI。" }

& $ecCodex plugin marketplace add Labiey/expert-council-router --ref v0.5.5 --json
& $ecCodex plugin marketplace list --json
& $ecCodex plugin list --marketplace expert-council-router --available --json
& $ecCodex plugin add "expert-council@expert-council-router" --json
& $ecCodex plugin list --json
```

完全退出 Codex Desktop，等待其后端进程结束，再重新打开并新建任务。部分 Desktop 版本仅新建任务并不能可靠触发 MCP 重载。

若要开发插件，可克隆仓库、执行 `npm ci && npm run build`，再把仓库根目录的绝对路径传给 `codex plugin marketplace add`。普通使用建议安装固定版本的远程 Release。

加载成功时会同时出现 `expert-council` Skill 和全部 10 个 `expert_*` MCP 工具；`expert_inspect` 必须返回真实资源清单，而不是 “No compatible Pi SDK is installed” 诊断。如果只有 Skill 而没有工具，或检查仍出现该诊断，请先确认 Marketplace 固定到 `v0.5.2` 或更高版本，再重启或重装插件；不要手动启动 `dist/server.mjs` 或手写 JSON-RPC。

在新的 Codex 任务中输入以下提示以验证安装：

```text
使用 Expert Council 检查当前可用的 Pi 模型、Provider、计费分类和模型评估状态。只返回紧凑摘要，不组建委员会，也不派遣专家。
```

任务应调用 `expert_inspect`，不应要求信任 hook、手工启动 MCP Server，也不应把插件缓存目录当作项目工作区。

### 升级

使用 `--ref` 固定的 Marketplace 会有意停留在该发布版本。升级时请移除已安装插件与旧 Marketplace，然后添加新标签并重新安装：

```bash
codex plugin remove expert-council@expert-council-router --json
codex plugin marketplace remove expert-council-router --json
codex plugin marketplace add Labiey/expert-council-router --ref vX.Y.Z --json
codex plugin add expert-council@expert-council-router --json
```

请把 `vX.Y.Z` 替换为目标版本。如果明确希望跟随默认分支，可以在首次添加时省略 `--ref`，以后执行 `codex plugin marketplace upgrade expert-council-router --json`；普通使用仍建议固定标签。重装后请完全重启 Codex Desktop，并在新任务中测试。不要同时安装多个都声明 `expert_council` MCP Server 的副本。

### 行为要点

- 内置 `.mcp.json` 将宿主工具调用上限提升到 3660 秒，让单次有边界的 `expert_wait` 可以阻塞到完成；Skill 仍要求为每个操作设定明确时限，而不是把该上限当作默认预算。
- 对话中第一次组建委员会时，主代理会与你确定唯一的成本策略（economy、balanced 或 speed）；在此之前 `expert_build` 与 `expert_delegate` 的响应都会携带询问提醒。
- 可写专家在受信任工作区下的独立 Git worktree 内修改；变更返回给主代理审查，永不自动合并。

### 卸载

移除插件及其 Marketplace 注册：

```bash
codex plugin remove expert-council@expert-council-router --json
codex plugin marketplace remove expert-council-router --json
codex plugin list --json
codex plugin marketplace list --json
```

如果 PowerShell 找不到 `codex`，先定位 Codex Desktop 自带的 CLI（Codex Desktop 运行时可从进程取路径，否则回退到安装目录）：

```powershell
$ecCodex = Get-Process codex -ErrorAction SilentlyContinue |
    Where-Object Path |
    Select-Object -First 1 -ExpandProperty Path

if (-not $ecCodex) {
    $ecCodex = Get-ChildItem (Join-Path $env:LOCALAPPDATA "OpenAI\Codex") `
        -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}

if (-not $ecCodex) {
    throw "未找到 Codex Desktop 自带的 codex.exe"
}
```

然后通过定位到的 CLI 卸载：

```powershell
& $ecCodex plugin remove "expert-council@expert-council-router" --json
& $ecCodex plugin marketplace remove "expert-council-router" --json

& $ecCodex plugin list --json
& $ecCodex plugin marketplace list --json
```

如果重新打开后仍显示，可在 Codex 关闭状态下安全清理旧 Expert Council 缓存（仅删除 `%USERPROFILE%\.codex\plugins\cache\expert-council-*`）：

```powershell
$ecCacheRoot = [IO.Path]::GetFullPath(
    (Join-Path $env:USERPROFILE ".codex\plugins\cache")
)
$ecCachePrefix = $ecCacheRoot.TrimEnd("\") + "\"

$ecTargets = Get-ChildItem -LiteralPath $ecCacheRoot `
    -Directory -ErrorAction SilentlyContinue |
    Where-Object Name -Like "expert-council-*"

foreach ($ecTarget in $ecTargets) {
    $ecResolved = [IO.Path]::GetFullPath($ecTarget.FullName)

    if (
        $ecResolved.StartsWith(
            $ecCachePrefix,
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        (Split-Path $ecResolved -Leaf) -like "expert-council-*"
    ) {
        Write-Host "删除缓存: $ecResolved"
        Remove-Item -LiteralPath $ecResolved -Recurse -Force
    }
}
```

之后请完全退出 Codex Desktop，再开始新任务。

## 测试

```bash
npm test
npm run typecheck
npm run build
npm run pack:check
npm run validate
```

`npm run validate` 会先构建，确保全新克隆在测试前已经生成 workspace 包入口。测试覆盖模型归一化、公开价格与真实策略计费、Worker 可靠性、Oracle 评分、Reviewer 多样性、硬约束、未知和缺失模型、团队规模、重试和逐次诊断、结构化失败分类、升级、重试上限、角色权限、紧凑宿主输出、配置校验、遥测隐私/反馈/用量聚合、Core 宿主独立性、模拟 Pi 发现与执行、CLI JSON、MCP Schema、真实 Pi 0.84.4 扩展加载/包装及异步批量通知、Pi 扩展注册和真实 Git worktree 隔离。

普通测试只使用 Mock Runtime，绝不会调用付费模型。真实只读 Pi 执行必须同时指定模型并明确确认成本：

```powershell
$env:EXPERT_COUNCIL_LIVE_MODEL = "provider/model"
$env:EXPERT_COUNCIL_LIVE_CONFIRM = "YES"
npm run smoke:live:pi
```

普通验证流程永远不会执行该脚本。

## 发布

先运行 `npm run validate`，检查每个 `npm pack --dry-run` 文件列表，再按依赖顺序发布：

```text
@expert-council/core
@expert-council/pi-runtime
@expert-council/cli
@expert-council/mcp-server
@expert-council/pi-package
```

## 已知限制

- Pi API 变化较快。当前版本已在本机 0.84.4 SDK 上验证；运行时会检查 SDK、模型运行时、资源加载器和 Session 必需方法，并在不兼容时明确列出缺失合约。
- Pi 没有统一的真实计费类型 API。运行时订阅信号和具名 Token Plan 优先；否则非零目录价格按按量计费处理，没有可靠证据的 Provider 保持 `unknown`，直到评估或显式用户配置确认。
- Expert Council 不会根据模型名称推断主观编码质量，也不会自动下载基准预设。
- Detached worktree 从已提交的 `HEAD` 开始，不会复制主工作区未提交改动。这是刻意的隔离设计；运行时会检测脏源工作区，并在委派前通过运行时限制和 mutation 委员会警告提示该偏差。
- Worktree 修改只返回给主代理审查，不会自动合并或应用；验收或拒绝后应调用 `expert_cleanup`，否则将在保留期结束后自动清理。
- 非 Git 工作区的写入需要显式原地修改授权。
- 正在进行的模型调用不会在 Server 重启后续跑；持久化状态会把它关闭为明确的中断失败，同时保留计划和已完成结果。
- Codex 自身的沙箱不会自动包含外部 Pi Runtime，因此 Expert Council 使用单独的允许根目录和 worktree 边界。
- Expert Council 不包含任意第三方包自动安装、递归专家树、图形界面、远程控制平面或远程遥测。

## 许可证

MIT，详见 [`LICENSE`](LICENSE)。
