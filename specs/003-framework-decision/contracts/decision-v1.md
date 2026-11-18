# 漫漫长夜决策 API v1

## 基类范本（签名）

框架面向行为契约。Node.js 实现可继承 DecisionPolicy，C++ 程序可直接实现同一 JSON 协议。

```ts
abstract class DecisionPolicy {
  abstract decide(request: DecisionRequestV1):
    DecisionResponseV1 | Promise<DecisionResponseV1>;
}
```

一次请求复原一次策略输入。Node.js 策略可以缓存计算结果，但固定请求的正确性不能依赖进程存活。外部策略可以用任意语言或可执行形式实现同样的输入输出。

## 请求

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| apiVersion | integer | 固定为 1 |
| requestId | string | 此次调用的唯一标识 |
| gameId | string | 固定为 long-night |
| matchId | string | 框架生成的不透明对局标识 |
| observationVersion | integer | 局内单调递增的观察版本 |
| budgetMs | integer | 本次调用可使用的正整数毫秒预算 |
| player | object | 当前玩家席位、地图和阶段可确认时所需的玩家信息；至少包含从零开始的 seat |
| rules | object | 已核验的公开游戏规则 |
| observations | array | 当前局已排序的公开状态、本人私信和对应行动结果。每项至少有递增 seq、kind、visibility、text；结构化棋盘信息由游戏适配器定义 |
| allowedTargets | string[] | 可用逻辑目标，由框架给出，取值 referee-private 或 match-group |

观察的 visibility 为 public 或 self-private。输入禁止带 SnowLuma 端点、令牌、原始 QQ 路由标识、其他玩家私信或赛后裁判真图。私聊与公聊目标映射保留在框架。读取不到必要观察时暂停或返回等待。

## 返回

响应必须回显 apiVersion、requestId、observationVersion。status 为 wait 时无需动作；可带 reason 供运行日志。status 为 action 时 action 必须含 target、text，可附 reason。每次最多提出一条消息。下一条须在框架完成确认及重新求值后提出。建议无权指定群号、QQ 号或调用传输 API。

框架检查协议、请求对应关系、当前观察版本、执行时限、目标白名单、规则及已有待确认动作。发送前持久化意图；回执未知时进入待核对状态。决策器退出、超时、输出无效或响应过期时不发送。

## 外部子进程

框架以可信本地配置中的程序路径和 argv 启动进程，禁用 shell 拼接。每次在 stdin 写入一个 UTF-8 JSON 对象和换行后关闭；进程在 stdout 输出一行 JSON 并正常退出，诊断走 stderr。框架强制时限和输入输出大小上限。非零退出、超长、多行、无效 JSON 和不支持的协议版本均视为决策失败。框架应按平台终止超时进程及其派生进程。

Node.js 基类和进程驱动见 `framework/decision-policy.cjs`。可用 `g++ -std=c++17 examples/decision-wait.cpp -o decision-wait` 编译暂停示例。私有配置中的 `decision.program` 指定可执行路径，`decision.args` 为参数数组。当前迁移以旧策略先核验回合和建议资格，外部程序可在该边界返回单步、停止或等待，并沿用已确认的传输目标。内置策略继续支持经验证的批量动作。
