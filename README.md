# 宽松

宽松是玩家侧程序。游戏裁判由 LGTBot 提供。上游以 [LGTBot 官方 GitHub 仓库](https://github.com/Slontia/lgtbot) 为准。

## 本地运行

安装 Node.js 18 或以上。在项目根目录运行 `node games/dvalue-tender/index.cjs < examples/dvalue-tender.json`。PowerShell 使用 `Get-Content -Raw examples/dvalue-tender.json | node games/dvalue-tender/index.cjs`。命令以 JSON 返回建议动作，不连接 QQ。由调用者提供玩家可见的公开信息及本人的私信。

目前 22 个多游戏适配器可通过 games/<游戏 ID 的连字符形式>/index.cjs 独立调用。漫漫长夜、QQ 宿主、完整规则回归和正式部署仍处于迁移阶段。运行方式、配置边界及切换条件见 [运行手册](docs/operations.md)。

## 迭代

阅读 [项目宪章](.specify/memory/constitution.md) 和当前功能规格，再用 Codex 中的 `$speckit-specify`、`$speckit-plan`、`$speckit-tasks`、`$speckit-analyze` 和 `$speckit-implement` 依次建立需求、设计、任务、检查与实现。每个功能在 specs 下保留验收证据和未完成项。

- [既有行为基线](specs/001-kuansong-baseline/spec.md)
- [迁移与公开发布规格](specs/002-public-kuansong/spec.md)
- [子游戏接口](specs/002-public-kuansong/contracts/game-adapter.md)
- [迁移任务](specs/002-public-kuansong/tasks.md)
