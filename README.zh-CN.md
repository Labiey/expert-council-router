# Expert Council

[English](README.md) | [简体中文](README.zh-CN.md)

Expert Council 是一个面向 Pi 与 Codex 等 MCP 宿主的本地、多模型、成本感知专家编排系统。它会发现 Pi 当前真正可调用的模型，将运行时元数据与用户定义的计费策略、能力画像和本地可靠性数据结合，动态组建一个精简的语义专家团队，并通过 Pi 执行有明确边界的任务，最后向主代理返回紧凑的结构化结果。

理论上最强的模型不一定是最合适的执行者。一个工具调用稳定、Shell 行为可靠、边际成本较低的模型，可能比更强但执行不稳定的模型拥有更高的实际任务价值。Expert Council 通过可配置、确定性的代码完成这些权衡，同时把模糊判断、架构决策和最终验收保留给主代理。

## 当前状态

V1 已包含：

- 与宿主无关的 Core：配置校验、模型归一化、计费策略、画像分层、角色评分、任务分类、动态团队规模、重试/升级和遥测聚合。
- 基于 Pi 当前 `ModelRuntime` 与 `createAgentSession` API 的执行运行时。
- 每个专家会话的硬工具白名单和已安装 Skill 过滤。
- 写入型专家的独立 Git worktree 隔离。
- 支持 JSON 输出的 CLI。
- 包含 7 个异步语义工具及显式 worktree 清理能力的 MCP Server。
- 原生 Pi Package。
- 带共享 Skill 和内置 stdio MCP Server 的 Codex 插件。
- 不会消耗模型额度的确定性自动化测试。

当前实现已在本机 Pi `@earendil-works/pi-coding-agent` 0.84.4 上完成验证，同时会通过能力探测尝试兼容上游 `@mariozechner/pi-coding-agent`。明确的降级行为请参阅[已知限制](#已知限制)。

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

边际成本和使用偏好是两个独立字段，因为公开 Token 单价无法表达订阅计划、固定额度、本地推理和促销额度。

```json
{
  "billing": {
    "providers": {
      "subscription-provider": {
        "billingType": "subscription",
        "marginalCostClass": "very-low",
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

权重会自动重新归一化。`costPolicy: economy` 会提高成本因素的影响，`quality` 则会降低成本因素，但它们不会绕过安全或兼容性硬约束。

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
| Verifier | 只读 + Shell | 测试、Diff 与验收标准验证 |

微小任务只使用一个 Worker；普通任务使用 Worker 与 Verifier；复杂功能使用 Planner、Worker、Reviewer 与 Verifier；复杂调试使用 Scout、Debugger、Oracle 与 Verifier。`maxExperts` 会限制团队规模，主代理永远不会再被复制成一个多余的 `lead` 专家。

任务分类和全部评分运算都是确定性的。宿主可以在委派前检查已选模型、备选模型、分数和简明理由。

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

硬约束会排除不可用或已禁用模型、不兼容角色、工具可靠性不足、上下文不足、运行时不支持写入，以及日常任务中的 `escalation-only` 资源。

推理等级是可选且与模型相关的。只有当 Pi 明确暴露选定模型支持某个等级时，角色偏好才会生效；否则 Pi 会保留或钳制到模型支持的默认值。

## Skill 与最小权限

主代理共享指导的唯一源文件是 [`shared/skills/expert-council/SKILL.md`](shared/skills/expert-council/SKILL.md)。构建过程会把它同步到 Pi 与 Codex 分发。共享角色提示位于 `packages/core/src/roles/prompts/`，作为包资源复制，而不是为不同宿主重复编写。

只读角色永远不会获得 `edit` 或 `write`，即使调用者试图把它们加入工具列表。Pi 会话使用真实的 `tools` allowlist，因此它比仅靠 Prompt 约束更强。Windows 使用 `powershell`，Unix 使用 `bash`。

系统只会激活已经安装并启用、且当前角色需要的 Pi Skill。被标记为不受信任的 Skill 默认排除，除非用户通过 `security.trustedSkills` 显式允许。Expert Council 不会下载或安装任何 Skill 或可执行扩展。

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

专家结果包含状态、角色、模型、摘要、修改文件、测试、发现、风险、下一步建议和有限的执行元数据。系统不会请求或保存私有思维过程，也不会把整份源码复制回主代理上下文。返回前会限制文本和数组大小。

## 工作区安全

系统不会因为 Codex 自身处于沙箱就假设外部 Pi 进程同样安全。Pi Runtime 使用独立边界：

1. 规范化请求工作区路径。
2. 要求路径位于允许的根目录内。
3. 从仓库当前 `HEAD` 在系统临时目录创建 detached worktree。
4. 在该 worktree 中为 Worker 提供写入工具。
5. 返回 worktree 路径和修改文件列表。
6. 由 Codex 或 Pi 主代理检查、整合并最终验收。
7. 整合或拒绝结果后调用 `expert_cleanup`。无人认领的 worktree 会在 `security.worktreeRetentionMs` 后自动清理，默认保留 24 小时，并同步 prune Git 元数据。

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

默认本地存储文件为 `.expert-council/telemetry.jsonl`。它只记录模型、Provider、角色、任务分类、成功状态、首轮成功、工具错误数量、重试、超时、可选验证结果、升级次数、总尝试次数、宿主类型和可选 Token 用量。

它不会记录 Prompt、源码内容、凭据、API Key、Secret 或思维过程。聚合指标包括按角色成功率、首轮成功率、工具错误率、重试率、验证通过率和平均尝试次数。V1 没有远程分析端点。

计划、执行状态和已完成的结构化结果另行保存在 `.expert-council/state.json`。进程重启后仍可查询计划和已完成结果；重启时仍在运行的任务会被关闭为明确的中断失败，而不会继续显示为活动任务。该本地状态可能包含有限的任务描述和专家摘要，应按项目数据保护。

## CLI

CLI 与 MCP、Pi Package 使用完全相同的 Core 和 Pi Runtime：

```text
expert-council models
expert-council inspect
expert-council build <task>
expert-council delegate <role> <task>
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

MCP 表面刻意保持为 7 个语义工具：

- `expert_inspect`
- `expert_build`
- `expert_delegate`
- `expert_result`
- `expert_cleanup`
- `expert_escalate`
- `expert_status`

`expert_delegate` 会启动后台任务并立即返回 `executionId`。可选的 `taskDescription` 是供宿主识别任务的简短标签，不属于专家实际任务内容。任务完成后使用 `expert_result` 获取反馈。通用 MCP 宿主通过 `expert_result` 或 `expert_status` 查询；原生 Pi Package 还会主动向主 Agent 发送完成通知。

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

Codex 插件已经内置并配置该 MCP Server，不需要复制业务逻辑。

## 原生 Pi Package

构建 monorepo 后可在本地试用：

```bash
pi install ./packages/pi-package
```

或仅在当前运行中临时加载：

```bash
pi -e ./packages/pi-package
```

Pi 会通过当前包清单中的 `pi.extensions` 与 `pi.skills` 加载 `dist/extension.js` 和同步后的 `expert-council` Skill。扩展注册与 MCP 相同的 7 个语义工具，不包含另一套独立路由实现。

Pi 委派是非阻断式的。专家完成后，扩展发送精简 JSON：必含已完成的 `executionId`，仅在调用时提供过 `taskDescription` 才包含该描述，绝不直接携带 feedback。主 Agent 工作中时通知使用 `steer`；主 Agent 空闲时使用带 `triggerTurn` 的 `followUp` 立即唤醒。随后由主 Agent 调用 `expert_result` 获取结构化反馈。由于原生 Pi 会在任务完成后自动重新唤醒主 Agent，主 Agent 派发完任务或完成其他有价值操作后应直接结束当前回合，不要轮询或静默等待消耗 token。

## Codex 插件

构建后的插件位于：

```text
packages/codex-integration/plugin/expert-council/
  .codex-plugin/plugin.json
  .mcp.json
  skills/expert-council/SKILL.md
  dist/server.mjs
  dist/roles/*.md
```

它遵循当前 Codex 插件布局，清单引用 `skills/` 和内置 `.mcp.json`，stdio MCP Server 被打包在插件内，并通过用户现有的 Pi SDK 使用凭据，而不会嵌入或复制凭据。

本地安装应通过个人或仓库 marketplace 暴露该插件。项目不会自动修改用户或团队的 Codex marketplace 配置。

## 测试

```bash
npm test
npm run typecheck
npm run build
npm run pack:check
```

测试覆盖模型归一化、计费、Worker 可靠性、Oracle 评分、硬约束、未知和缺失模型、团队规模、重试、升级、重试上限、角色权限、配置校验、遥测隐私与聚合、Core 宿主独立性、模拟 Pi 发现与执行、CLI JSON、MCP Schema、Pi 扩展注册和真实 Git worktree 隔离。

普通测试只使用 Mock Runtime，绝不会调用付费模型。任何真实 Provider 调用都必须单独显式启用；项目自带脚本不会自动执行这种调用。

## 发布

先运行 `npm run validate`，检查每个 `npm pack --dry-run` 文件列表，再按依赖顺序发布：

```text
@expert-council/core
@expert-council/pi-runtime
@expert-council/cli
@expert-council/mcp-server
@expert-council/pi-package
```

Codex Integration 是独立插件制品，不是 Pi Package 的复制品。提交到公共插件目录前，应补充真实的仓库、支持、隐私和发布者信息，而不是在源代码中虚构这些字段。

## 已知限制

- Pi API 变化较快。V1 已在本机 0.84.4 SDK 上验证；运行时会检查 SDK、模型运行时、资源加载器和 Session 必需方法，并在不兼容时明确列出缺失合约。
- Pi 没有统一的真实计费类型 API。无法确认的计费保持 `unknown`，订阅、额度和促销访问需要用户配置。
- V1 不会根据模型名称推断主观编码质量，也不会自动下载基准预设。
- Detached worktree 从已提交的 `HEAD` 开始，不会复制主工作区未提交改动。这是刻意的隔离设计。
- Worktree 修改只返回给主代理审查，不会自动合并或应用；验收或拒绝后应调用 `expert_cleanup`，否则将在保留期结束后自动清理。
- 非 Git 工作区的写入需要显式原地修改授权。
- 正在进行的模型调用不会在 Server 重启后续跑；持久化状态会把它关闭为明确的中断失败，同时保留计划和已完成结果。
- Codex 自身的沙箱不会自动包含外部 Pi Runtime，因此 Expert Council 使用单独的允许根目录和 worktree 边界。
- V1 不包含任意第三方包自动安装、递归专家树、图形界面、远程控制平面或远程遥测。

## 许可证

MIT，详见 [`LICENSE`](LICENSE)。
