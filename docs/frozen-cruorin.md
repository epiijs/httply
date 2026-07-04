# Cruorin 整合设计（搁置）

> **状态：长期搁置，不在 httply 中实现。**

## 决策结论

Cruorin 的核心机制是 in-flight promise 复用 — 将多个相同 key 的并发请求合并到同一个 Promise，settle 后自动移除。这个机制本身足够简单，上层框架（如 @epiijs/server）可以低成本地自行实现，无需下沉到 httply 层。

## 搁置原因

1. **上层实现更合适** — in-flight promise 复用的逻辑简单，上层框架按需实现并不复杂，没有必要作为底层设施提供。
2. **适用面窄** — 要求无鉴权、无副作用、请求可等价，大多数通用响应器不具备这些条件。
3. **职责边界** — httply 定位为 HTTP 消息抽象层，并发去重属于上层策略，不在本层职责范围内。

## 原始构想（备查）

- **请求识别**：为等效请求生成一致的 cache key，上层决定参与维度。
- **并发去重**：多个相同 key 的 in-flight 请求共享同一个 Promise，settle 后自动移除。
- **缓存管理（可选）**：响应缓存的存取与淘汰策略。

## 参考

- [Cruorin](https://github.com/epiijs/cruorin) — HTTP GET 反向代理缓存服务器，核心思路是并发等效请求合并
