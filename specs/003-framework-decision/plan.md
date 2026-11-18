# 实施计划 · 框架与漫漫长夜决策器

## 当前服务器证据

只读检查时服务健康端点返回正常。宿主入口 game-steward/game.cjs 为游戏模块注入宿主接口；game-steward/onebot.cjs 使用 send_group_msg 与 send_private_msg。宿主还包含 inbox、private-sync、matches、history 和 decision-report 模块。游戏入口 index.cjs 暴露 configure、CLI、assets 与模块查找接口；runtime/archive.cjs 提供归档渲染，runtime/decision-report.cjs 构建并生成决策报告。当前宿主按内部 Node.js 模块集成策略，跨语言契约是本规格定义的新边界。服务器位置、检查到的版本及实际核验凭据保存在私有部署台账。

## 目标结构

- framework/ 负责 SnowLuma 通道、事件与权限、会话协调、执行校验、档案和报告调度。
- games/long-night/ 存放唯一游戏适配器、旧策略迁移后的参考实现及离线入口。适配器实现规则识别、阶段判断、观察解释、动作校验及游戏专属报告。
- contracts/ 的接口同时供进程内 Node.js 驱动和外部子进程驱动。外部程序由私有可信配置指定，默认逐次启动，以可重放请求恢复状态。
- private/data/ 存放原始事件、私信、图片、行动台账和报告。公开测试只用合成数据或经批准的脱敏固定输入。

## 宪章与切换

游戏帮助与入局共用单项注册表。只向决策器暴露当前玩家可见信息。框架保留发送幂等、时限及恢复校验。先以旧漫漫长夜源码通过固定用例，再引入协议边界、外部 C++ 样例、回归与切换验证。源代码归档与运行数据备份相互独立；部署前检查只有一个宿主控制账号。
