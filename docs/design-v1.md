# httply v1 机制设计

## 定位

httply 是 HTTP 消息抽象层，提供 `IncomingMessage` 和 `OutgoingMessage` 的结构化封装，职责边界到 HTTP 协议为止。上层框架（如 @epiijs/server）负责路由、鉴权、业务逻辑等更高层的关注点。

设计原则：
- **零运行时依赖** — 仅依赖 Node.js 内置模块
- **最小职责** — 只做 HTTP 消息的结构化读写，不越界到业务层
- **惰性求值** — query、body 等开销操作延迟到首次访问

---

## IncomingMessage

### 类设计

`IncomingMessage` 是 class，接收结构化对象构造，getter 定义在 prototype 上实现惰性求值。`IIncomingMessage` 保留为外部数据结构定义。

### body 读取

`body: Promise<Buffer>` 始终挂载为惰性 getter，首次访问时触发读取并缓存结果。

**设计依据（RFC 9110 §9.3）：** 协议层面不限制哪些方法可以带 body，只有 TRACE 明确禁止。GET、DELETE、HEAD 等方法的 body 虽无定义语义，但服务器不应拒绝。按方法名过滤"哪些请求有 body"在协议层面不正确。

| 方法 | body 语义 |
|------|----------|
| POST / PUT / PATCH | 有明确语义 |
| GET / DELETE / HEAD / OPTIONS | 无定义语义，但允许携带 |
| TRACE | 明确禁止 |

**流事件安全封装：** 入站流（Readable）的关键事件序列：

```
正常完成:     data... → end → close
客户端断连:   data... → aborted → error → close
服务端 destroy: data... → aborted → close
读取出错:     error → close
```

`end`、`error`、`aborted` 三者互斥，Promise 的 `reject` 多次调用只有首次生效，无需额外标志位：

```ts
request.on('error', reject);
request.on('aborted', () => reject(new Error('request aborted')));
request.on('data', (chunk: Buffer) => chunks.push(chunk));
request.on('end', () => resolve(Buffer.concat(chunks)));
```

`aborted` 必须监听 — 服务端调用 `req.destroy()` 时只有 `aborted` 触发，`error` 不会触发。`close` 无需监听 — 它总是最后触发，作为兜底收益低且需要防重复标志位。

### query 解析

`query: Record<string, string | string[]>` 通过 class getter 惰性解析，首次访问时用 `URLSearchParams` 解析并缓存为朴素对象。单值 key 为 `string`，重复 key 为 `string[]`。

字段名保持 `query`（框架惯例），返回朴素对象而非 `URLSearchParams` 实例，无运行时依赖。

### params 不在职责范围

`params` 是路由匹配的产物，不属于 HTTP 协议层。httply 的 `IncomingMessage` 不包含 `params`，上层框架按需扩展接口：

```ts
interface IRequest extends IncomingMessage {
  params: Record<string, string>;
}
```

---

## OutgoingMessage

### 类设计

`OutgoingMessage` 是 class，多态构造由 `static from()` 静态工厂承接，接受 `string | Buffer | Readable` 等内容类型。`IOutgoingMessage` 保留为外部数据结构定义。

### 响应写入

响应写入通过 `message.applyToResponse(response)` 方法完成，使用 `stream.pipeline` 替代 `pipe` 将内容写入响应流，自动处理双向错误传播和流清理：

```ts
await message.applyToResponse(response);
```

**设计依据：** `pipe` 只做数据转发，不传播源流的 `error`。若源流（如 `fs.createReadStream`）出错，Promise 永远 pending，response 可能处于半写状态。

出站流（Writable）事件模型：

```
正常完成:  finish → close
写入出错:  error → close
连接断开:  error/close（finish 不触发）
```

### content-length

- `string`：用 `Buffer.byteLength(content, 'utf-8')` 计算字节数（`String.length` 返回的是 UTF-16 code unit 数量，多字节字符会导致偏小）
- `Buffer`：直接用 `buffer.length`
- `Stream`：不设 content-length，由流式传输处理

---

## 类型设计

- `IIncomingMessage` / `IOutgoingMessage` — 外部数据结构定义，描述原始 HTTP 消息形态
- `IncomingMessage` / `OutgoingMessage` — class 实现，承载惰性解析等运行时行为
- 构造函数严格，只接受结构化对象；多态便利由 `static from()` 承接

---

## 附注

### 跨 vm 的 instanceof

`instanceof` 基于原型链比较，不同 vm context 拥有独立的内置对象原型，跨 context 的实例检测会失败。httply 几乎不会遇到跨 vm 场景（vm 沙箱、npm 依赖树多版本），保持 `instanceof Readable` 即可。如需跨 context 检测，可用鸭子类型替代：

```ts
o != null && typeof o.pipe === 'function' && typeof o.on === 'function'
```

### 不在职责范围的功能

- **JSON body** — 属于业务工作，由上层框架处理，不属于 HTTP 消息抽象层
- **并发去重（cruorin）** — in-flight promise 复用机制足够简单，上层框架按需实现即可，不下沉到 httply（详见 [frozen-cruorin.md](./frozen-cruorin.md)）

---

## 待查证

- `stream.pipeline` pipe 到 `ServerResponse` 时是否有边界情况
- 惰性 body 未消费时对 keep-alive 连接的实际影响（需基准测试）
