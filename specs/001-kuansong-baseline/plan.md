# 实施计划 · 登记既有实现

本批在 kuansong 建立规范与证据索引。现有业务代码由宿主和适配器仓库负责。后续变更在明确范围后落到对应仓库。

## 技术上下文

- 宿主本地副本在 旧工作区中的 lgtbot_player，Node.js 18+，通过 SnowLuma 接收 OneBot v11 WebSocket 事件。参考 README.md、game-steward/game.cjs、tests/kuansong-config.test.cjs。
- 适配器本地副本在 旧工作区中的 long_night_player。入口和契约参考 runtime/bot.cjs、runtime/supported-games.cjs、runtime/solo-games.cjs。多游戏登记与路由参考 runtime/games/catalog.cjs、router.cjs、identity.cjs 和 README.md。
- OCR 通过专用 Python 环境运行，依赖见 runtime/games/requirements-vision.txt。外部回归材料条目为 KUANSONG_GAME_FIXTURES。
- 既有部署证据、内部路径与环境标识迁入私有部署台账。历史检查确认宿主版本与部署记录一致，适配器有后续提交。

## 宪章检查

| 原则 | 本批做法 |
| --- | --- |
| 已有实现 | 以宿主、适配器和部署记录为依据登记基线 |
| 契约 | 需求引用现有入口和规则目录 |
| 可见信息 | 验收覆盖可信身份与歧义暂停 |
| 恢复 | 验收覆盖重放、回执未知与开局超时 |
| 验证 | 区分历史材料、本次文档核对和后续线上核验 |

## 核验顺序

先核对两端源码和部署记录的对应关系，再对照 FR-001 至 FR-005 验收。变更运行逻辑时，在适配器仓库运行 node scripts/test-regressions.cjs <外部材料清单>，并执行宿主受影响路径的测试。部署前记录两仓版本、配置与数据备份及回退点，部署后验证服务和受影响的入口。

## 本次验证

2026-11-18 在 旧工作区本地副本运行宽松配置、管理员控制和多游戏路由测试，共 24 项通过。独立运行证据与 QQ 开局超时测试时缺少外部夹具，完整回归及当前服务器版本的逐项验收仍待执行。
