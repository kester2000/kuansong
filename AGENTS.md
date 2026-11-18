# 宽松项目协作约定

项目规范以 .specify/memory/constitution.md 为准。现有功能从 specs/001-kuansong-baseline/spec.md 进入，源码职责与证据路径见同目录 plan.md，未核验项见 tasks.md。

调整现有行为前先核对宿主与适配器的源码版本和测试，再更新规范、计划和任务。把实现变更落在对应源码仓库。

以 .specify/feature.json 定位当前变更。迁移期以 001 规范作行为基线，在本项目实现新代码。生产配置与凭据集中放在 private/，上游缓存放在 cache/lgtbot/。
