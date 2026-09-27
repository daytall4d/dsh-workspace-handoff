# DSH Workspace Handoff（工作区交接）

[English](./README.md)

这是一个真正面向 **DeepSeek Harness 日常项目连续工作** 的轻量开源 Profile Bundle。

它解决的问题很具体：一个项目在多个 Harness 会话、多个 Agent 之间反复切换时，新会话不应该重新翻几十轮历史才能知道“做到哪了”。

插件增加 3 个模型工具：

- `project_digest`：快速读取当前工作区摘要，包括 Git 分支、改动数量、最近提交、根目录关键文件以及最近一次交接。
- `project_handoff_save`：把当前阶段的结论、下一步、阻塞项、验证证据写入项目根目录的 `.dsh-handoff.json`。
- `project_handoff_load`：新会话中加载并校验上一次交接。

**不需要 API Key，不上传项目数据，不自动抓取聊天记录，也不运行额外服务器。**

## 为什么不是再做一个 Memory

通用 Memory 更适合长期知识；项目交接需要的是另一类信息：

- 当前目标是什么；
- 这次到底做完了什么；
- 哪些测试已经验证；
- 下一位 Agent 应先做什么；
- 卡在哪里；
- 保存交接时对应哪一个 Git 版本。

这些内容适合成为一个**显式、可审计、可选进 Git 的项目文件**，而不是继续藏在某段聊天或远端记忆库里。

它和现有能力的边界也比较明确：

- **不是 MCP Memory**：不维护用户级知识库，只服务当前工作区；
- **不是 Ralph 内部 handoff**：普通交互会话、不同 Agent 也可以使用；
- **不是聊天摘要器**：不会自动复制整段对话，更不会把聊天内容偷偷持久化。

## 安装

### DeepSeek Harness Desktop

进入 **Plugins / 插件** 页面，通过 Git 规格安装：

```text
github:daytall4d/dsh-workspace-handoff
```

也可以使用仓库地址：

```text
https://github.com/daytall4d/dsh-workspace-handoff.git
```

它是标准 DSH Profile Bundle，`package.json` 中的 `dsh.bundle.patch` 会通过 Cordis 挂载插件。

### DSH CLI

```sh
dsh plugin --profile web add github:daytall4d/dsh-workspace-handoff
```

## 怎么用

新会话一开始可以直接说：

```text
调用 project_digest，看一下这个项目现在做到哪了。
```

准备切换会话前：

```text
把我们刚完成的工作保存成项目交接，写清下一步和验证结果。
```

换到另一个会话后：

```text
调用 project_handoff_load，按上次交接继续做。
```

保存后的 `.dsh-handoff.json` 大致如下：

```json
{
  "version": 1,
  "objective": "发布第一个公开版 DSH 插件",
  "status": "active",
  "summary": "三个工具已经实现并完成测试。",
  "nextSteps": [
    "发布 GitHub 仓库",
    "使用 GitHub 地址在 Desktop 中再次安装验证"
  ],
  "blockers": [],
  "evidence": [
    "node --test：5/5 通过",
    "真实 DSH Web Profile 已成功加载插件"
  ],
  "updatedAt": "2026-09-27T00:00:00.000Z",
  "git": {
    "available": true,
    "branch": "main",
    "head": "0123456789ab",
    "clean": false
  }
}
```

## 安全设计

### 1. 写入范围跟随 DSH Sandbox

`project_handoff_save` 不直接绕过 Harness 权限写文件，而是：

1. 从 `ctx.sandboxPolicy` 解析当前 Session 的实际权限；
2. 通过 `ctx.fs` 解析工作区路径；
3. 使用 `ctx.fs.writeText` 写入。

因此：

- `read-only` 下会拒绝写入；
- `workspace-write` 下只能写工作区；
- 文件更新使用版本守卫，遇到并发修改会失败，而不是直接覆盖。

### 2. 没有第三方运行时依赖

插件没有 npm 运行时依赖，也没有任何网络请求。

唯一会调用的外部程序是本机 `git`，并且使用 argv 形式的 `execFile`，不经过 shell，仅获取有限的只读元数据：

- Git 根目录；
- 当前分支与 HEAD；
- staged / unstaged / untracked / conflict 数量；
- 最近 3 条 commit 标题。

没有安装 Git 时，插件其他功能仍然正常。

### 3. 不自动收集敏感内容

交接文件只保存模型明确传给 `project_handoff_save` 的字段，以及上述 Git 摘要。

不会自动读取项目源码塞进交接，也不会复制聊天历史、Token、API Key 或凭证。

## 真实验证

首个版本不是只写完代码就算完成，而是直接在 Windows 上使用本机打包版 **DeepSeek Harness 0.1.7-rc.2** 做过验证：

1. `node --check src/index.js` 语法检查；
2. `node --test`，覆盖保存、加载、Digest、Git 状态、异常文件以及只读 Sandbox；
3. 用真实 DSH Plugin Manager 把本地项目安装到独立测试 Profile；
4. 使用 `--dump-config` 确认 Bundle 被正确组合；
5. 真正启动 DSH Web Profile，插件成功激活且没有 inactive-plugin 警告。

开发检查：

```sh
npm test
npm run check
```

## 项目特点

- **项目级而不是账号级**：状态跟着工作区走；
- **可读**：就是普通 JSON，不锁在数据库；
- **可审计**：你可以直接查看 Agent 保存了什么；
- **可进 Git**：团队需要时可以提交，不需要时也可以忽略；
- **没有额外服务**：不需要数据库、向量库或云端账号；
- **跨平台实现**：核心为 Node + DSH 服务，Git 调用不依赖 PowerShell/Bash；
- **源码即运行代码**：没有构建产物黑盒。

## 目录

```text
.
├─ cordis.patch.yml
├─ icon.svg
├─ locale/
│  ├─ en.json
│  └─ zh.json
├─ src/
│  └─ index.js
└─ test/
   └─ plugin.test.js
```

## 后续方向

在不把它做成“大而全 Memory”的前提下，后续可以继续加：

- 有上限的历史交接；
- 保存时 HEAD 与当前 HEAD 的差异摘要；
- Desktop 侧只读交接卡片；
- 针对更多 DSH 版本的兼容性 CI。

## License

MIT

[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
