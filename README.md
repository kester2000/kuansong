# 宽松

宽松是 QQ 游戏玩家框架。本阶段只支持漫漫长夜，游戏裁判由 [LGTBot](https://github.com/Slontia/lgtbot) 提供。

## 当前开发规格

- [框架与漫漫长夜规格](specs/003-framework-decision/spec.md)
- [现网能力与迁移计划](specs/003-framework-decision/plan.md)
- [决策器 API v1 与基类范本](specs/003-framework-decision/contracts/decision-v1.md)
- [实施任务](specs/003-framework-decision/tasks.md)
- [运行与切换手册](docs/operations.md)

候选实现包含 QQ 框架、漫漫长夜适配器和离线入口。运行环境需 Node.js 18 或以上。QQ 入口为 `node framework/index.cjs`，默认读取 `private/config/bot.json`。用 `node games/long-night/night-strategist/cli.cjs --help` 查看离线命令。生产切换与验收状态见运行手册。

## 迭代

按 [项目宪章](.specify/memory/constitution.md) 和当前规格工作。使用 Codex 的 `$speckit-specify`、`$speckit-plan`、`$speckit-tasks`、`$speckit-analyze`、`$speckit-implement` 依次建立需求、设计、任务、检查和实现，保留独立验收证据。
