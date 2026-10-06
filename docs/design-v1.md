---
title: httply v1 机制设计
description: HTTP 消息抽象层的结构、惰性求值与读写语义设计
last_updated: 2026-10-06
---

# httply v1 机制设计

## 设计原则

httply 是 HTTP 消息抽象层，提供 `IncomingMessage` 和 `OutgoingMessage` 的结构化封装。

- **最少依赖**：仅依赖 Node.js 内置模块
- **最小职责**：只做 HTTP 消息的结构化读写，不越界到业务层

## IncomingMessage

### 类设计

```ts
class IncomingMessage implements IIncomingMessage {
  // raw.url，空值默认为 '/'
  readonly url: string;

  // raw.method 的大写化，空值默认为 'GET'
  readonly method: HttpMethod;

  // raw.headers 的原始引用
  readonly headers: IncomingHttpHeaders;

  private _raw: http.IncomingMessage;
  private _cachedQuery?: Record<string, string | string[]>;
  private _cachedBody?: Promise<Buffer>;

  constructor(raw: http.IncomingMessage);

  // 首次访问时解析并缓存
  get query(): Record<string, string | string[]>;

  // 首次访问时读取并缓存
  get body(): Promise<Buffer>;
}
```

`query` 和 `body` 通过 getter 实现惰性求值，在首次访问时计算（或消费 IO 数据）并缓存，把不确定规模的数据推迟到真正用到时才进内存。

### query 解析

首次访问 `query` 时用 `URLSearchParams` 解析得到朴素对象后缓存。
单值 key 为 `string`，重复 key 为 `string[]`。

某些服务可能会从 URL pathname 解析得到 `params`。这不受 HTTP 协议约束，所以不在 httply 提供。
使用方可采用 `interface IIncomingMessageWithParams extends IIncomingMessage` 的形式自行扩展。

### body 读取

首次访问 `body` 时消费请求流，得到 `Promise<Buffer>`。
Promise 的语义是：完整接收请求体则 resolve，发生异常导致数据不完整则 reject。

#### 不按 HTTP Method 跳过读取

RFC 9110 §9.3 只禁止 TRACE 携带 body，GET、HEAD 等其余方法的 body 均不受限制。
据此废弃了按 HTTP Method 跳过 body 读取的早期实现。

#### 请求流的安全封装

请求流是 Readable。为了实现上面的 `body` 语义，`readRawBody` 按以下实测结论读取。
实证参见 [report-node-24-v3.md](./report-node-24-v3.md) 的 X1–X3 组。

- chunked 缺终止块时 `end` 永不触发（spec X1-2）。
- 响应发出之前终止，`req` 的 `aborted`、`error`、`close` 随原因不同各有组合，socket 一定跟着关闭（spec X2-2、X2-3、X3-3）。
- 响应 `finish` 之后，Node 不再向 `req` 派发终止事件，截断只在 socket 层可见（spec X1-1、X2-1）。
- 同一时刻，Node 把请求流置 flowing 并丢弃残余数据，晚访问只读到空 Buffer（spec X2-5）。

读取失败时 reject 一个带 `code` 的错误，分两类。

**`HTTPLY_BODY_DROPPED`，请求流已被 Node 丢弃。** 通常发生在本次请求的响应 `finish` 之后访问 `body` 时。
识别方法：因为 `readableDidRead` 要等一次 data 事件才被置为 true，单看它会漏，所以首次访问时还要检查 `readableFlowing`，任一为 true 说明数据已不在流上，直接 reject。
`Content-Length` 定长与 chunked 两种请求体都适用，实证参见 spec X2-5。

**`HTTPLY_BODY_ABORTED`，请求流提前终止，数据不完整。** 通常发生在客户端中途断开、请求帧解析失败、服务端调用 `req.destroy()` 等。
识别方法：监听 `req` 的 `error` 与 `req.socket` 的 `close`，触发任一事件即 reject，不区分原因。
`error` 监听兼作进程保护：无监听器的 `error` 事件会抛出到进程外（events.md）。
`req.socket` 的 `close` 到达时若 `req.readableEnded` 为假即判为中止；该事件在所有终止形态下都会到达，实证参见 spec X3 组。

以下对策经实测否决：

| 对策 | 未采用的理由 | 依据 |
|---|---|---|
| 监听 `req` 的 `aborted` | Stability 0 的弃用事件，它覆盖的终止形态 socket `close` 都能到达 | spec X1-4、X3-3 |
| 按声明字节数与实读字节数对账 | 声明只覆盖定长；chunked 缺终止块时 `end` 不触发，那条路径已由 socket `close` 覆盖 | spec X1-2 |
| 用 `drain` 排空请求体 | 截断的 body 等不到完整数据，`drain` 续写反而长期占住连接 | spec X4-1 |
| 响应 `finish` 后调用 `res.destroy()` | 影响不到 keep-alive socket，连接继续被占用 | spec X7-1 |

#### 自动连接回收

响应 `finish` 之后，未读完的请求体再无机会读取，`applyToResponse` 回收该连接。
做法是延后一个 tick 检查 `response.req`，其 `readableEnded` 为假即调用 `req.destroy()`。
延后一个 tick 是必需的：`finish` 当场取到的 `readableEnded` 与 `req.complete` 都还是 false，当场判定会误销毁可复用的连接（spec X7-2）。
到下一个 tick，body 已读完的请求 `readableEnded` 已为真，回收自动跳过，连接继续复用（spec X7-4）。
回收只能销毁请求：销毁响应接触不到 keep-alive socket，连接会一直被占用，直到 `server.keepAliveTimeout` 到期（spec X7-1）。
到期之前，客户端继续发送的字节还会被当作 body 读进去，让解析器报错。
回收不影响送达：响应已交入内核，客户端仍完整收到，socket 干净关闭而非 RST（spec X7-3）。
销毁请求连带终止 socket，等待中的 `body` 由 socket 的 `close` 监听 reject（spec X3-3）。
门禁用例见 `test/index.test.js`「the connection is reclaimed after the response」组。

#### 使用方的正确用法

全量惰性读取有两处代价：

- **内存占用**：`body` 只返回最终的全量 `Promise<Buffer>` 且不提供流式读取。
  由于一次读取占用的内存与请求体字节数相当，httply 适合接收短小的请求体，接收大文件上传应交由对象存储服务承载。
  由于 Promise 语义不适合高频代理转发，httply 适合使用方读取请求体后直接处理。
- **不设超时**：客户端停止发送 body 而连接又不关闭时，`body` 可能一直不 settle。
  上限由 `server.timeout` 决定，httply 不内置计时器：计时器销毁连接后 socket 关闭，`body` 随之 reject `HTTPLY_BODY_ABORTED`（spec X8-1、X3-3）。不在 handler 里为单次读取另设超时，计时器的分工与各属性默认值实证参见 spec X8 组与 X9-4。

需要请求体时，在发出响应之前 `await incoming.body`，并捕获 reject 区分 `code` 按需处置。
不消费请求体的分支无需额外动作，连接由 httply 回收。

## OutgoingMessage

### 类设计

```ts
class OutgoingMessage implements IOutgoingMessage {
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  readonly content: OutgoingMessageContent;

  // 三者的默认值依次为 200、{}、''
  constructor(init?: { status?: number; headers?: OutgoingHttpHeaders; content?: OutgoingMessageContent; });

  // 按入参类型补齐 status 与 content-type：空值给 204，string 给 text/plain，Buffer 与 Readable 给 octet-stream
  static from(message: AnyForOutgoingMessage): OutgoingMessage;

  // 把内容写入响应，等待本次写入流程终止
  applyToResponse(response: http.ServerResponse): Promise<{ completed: boolean; }>;
}
```

构造函数只接受结构化对象，多态便利交给 `static from()`。
`IOutgoingMessage` 保留为外部数据结构定义，class 承载写入行为。

### 响应写入

响应写入通过 `message.applyToResponse(response)` 完成：

```ts
const { completed } = await message.applyToResponse(response);
```

内容写入响应流用 `stream.pipeline`，不用 `pipe`：`pipe` 只转发数据，不传播源流的 `error`，源流（如 `fs.createReadStream`）出错时 Promise 永远 pending，响应停在部分写入状态。

Promise 承诺的是**本次写入流程已经终止**：

| 终止原因 | 结果 | `completed` |
|---|---|---|
| 响应已交入内核（`finish` 发生） | resolve | `true` |
| 连接提前终止，写入未完成 | resolve | `false` |
| 源流自身出错 | reject | 无 |

`completed` 严格等于「`finish` 是否发生」，与客户端是否收到无关：响应已交入内核而客户端只接收部分字节就断开，仍为 `true`。Node 不提供「客户端已完整接收」的信号，需要送达保证的使用方只能自带应用层确认。

#### 终止判定

`applyToResponse` 在 `finish` 与 `close` 中取先到者 settle。
`ServerResponse` 正常完成时 `finish` 与 `close` 成对出现且 `finish` 在前，而断连时只派发 `close`（spec X2-4、X3-4），所以 `close` 是唯一通用的终止信号。
`completed` 只认 `finish` 事件，不读状态位：断连时 `finish` 未触发，`writableFinished` 仍为 true（spec X4-2）。

连接在写入开始前已经终止时，`close` 不再派发第二次，只靠监听会一直等待，所以入口处先判一次连接状态：`response.destroyed` 为真且 `writableEnded` 为假，即按 `{ completed: false }` 返回。这样可以销毁未消费的内容流，避免 IO 资源占用（spec X3-1、X4-3）。

响应 `finish` 之后尝试回收连接，见「自动连接回收」一节。

#### 错误分流

只有源流自身出错才 reject，即承诺 P4 的响应方故障；请求方断连按终止 resolve、内部错误不上抛，即承诺 P3。
归因看错误来源，不看事件先后。

- `ERR_STREAM_UNABLE_TO_PIPE` 指 pipe 到已关闭或已销毁的目标，只可能来自目标侧，按 `{ completed: false }` resolve。
- `ERR_STREAM_PREMATURE_CLOSE` 两侧都可能产生：`pipeline` 失败会连带销毁目标，源流随之收到同一个码（spec X5-2、X5-3）。
  所以源流的 `error` 要提前单独捕获，连带销毁的那一类不算源侧原因；`close` 到达时若已有源流错误，就以该错误 reject（spec X5-4）。
- 其余错误原样 reject，作为承诺 P4 的默认出口。真实响应走不到这一步（spec X2-6、X5-5）。

`pipeline` 的失败可能在建立时同步抛出，也可能在回调里报出，所以入口判定与 `close` 监听两者都保留（spec X5-1）。
这一行为尚无文档条款，上游正按缺陷处理。

`response.on('error')` 几乎不会被触发：真实响应上断连只派发 `close`，显式 `res.destroy(error)` 的错误由 `socket.error` 承接（spec X2-4、X5-5）。
留着它是进程保护：没有监听器的 `error` 事件会抛出到进程外，非流式内容的 `response.write()` 出错正是经由这条路径。
http.md 里「连接提前关闭会派发 `res` 的 `aborted` 与 `error`（`ECONNRESET`）」那段说的是客户端 `ClientRequest` 的 `res`，不是服务端的 `ServerResponse`。

出站错误带着 Node 或使用方自己的 `code`，httply 不再包装。
入站的 `HTTPLY_BODY_*` 只用于 httply 自己的判定，见「请求流的安全封装」。

#### 时限与误用

对端零读取使写入挂起时，Promise 直到 `server.timeout` 到期、`close` 到达才终止；该计时器为 0 时不做任何终止（spec X8-4）。
时限与入站同理，见「使用方的正确用法」的不设超时条。

同一响应重复写入属编程错误，照常由 `writeHead` 同步抛 `ERR_HTTP_HEADERS_SENT`，不静默兜底（spec X6-1）。

### content-length

`from()` 按内容类型给出 `content-length`：`string` 用 `Buffer.byteLength(content, 'utf-8')` 计算字节数。
`String.length` 数的是 UTF-16 code unit 数量，多字节字符会让结果偏小。
`Buffer` 直接取 `buffer.length`；`Readable` 不设置该头，长度交由 chunked 界定。

## 测试要求

日常门禁（`test/`）断言的是 httply 对外的行为承诺，写法上守以下约定：

- **入站用例走真实 `http.createServer` 回环，不自造 `IncomingMessage` 替身。** 真实请求必带 `socket`，替身缺少该属性会掩盖实现对 `request.socket` 的依赖；出站用例同理。
- **需要回看请求内部状态时，观测结果写入响应头而非响应体。** 具体做法是 base64 编码进 `x-httply-inspect`；只有这样才能让 HEAD 这类无响应体的方法与其余方法共用一套断言。
- **入站的 method 覆盖只能用 `http.request` 发 POST、PUT、PATCH 的 body，其余方法不构造 body。** 限制来自 Node 客户端而非服务端，原因见报告 H6；要证明服务端不按 method 拦截请求体，必须直接用 `net.Socket` 构造请求，这条由 spec X1-3 承担。
- **观测入站流状态的用例不得先于被测方消费 `req`。** 给 `req` 注册 `data` 监听会把流推进到 flowing 状态，而那正是「请求体已被取走」的信号，因此探针注册监听要排在 httply 首次访问 `body` 之后。同一约束在 Node 行为套件里的表述见 `design-node-test.md`「验证用例的要求」第 4 条。
- **未处理的 rejection 不设用例。** 取得 `body` 的 Promise 后既不 `await` 也不注册 catch，责任在使用方：Node 对未处理 rejection 的默认策略是终止进程，httply 代管等于掩盖编程错误。这种写法要断言的是子进程崩溃，成本高于收益，因此不纳入门禁。

## 决策不支持的能力

- **JSON body**：属于业务工作，由使用方处理，不属于 HTTP 消息抽象层
- **流式请求体**：`body` 不提供流式出口。理由、代价与适用面见「使用方的正确用法」的内存占用条
- **带时限的 `body` 读取**：不提供 deadline 入口与 per-request 开关，理由见「使用方的正确用法」的不设超时条。可用的时机只有 `applyToResponse` 的 `finish`，而「请求已开始、响应未发出、body 停发且连接保持打开」要等 server 侧计时先到期才可见，秒级内没有可用时机，待出现真实需求后再议
- **并发去重（cruorin）**：in-flight promise 复用机制足够简单，使用方按需实现即可，不下沉到 httply（详见 [frozen-cruorin.md](./frozen-cruorin.md)）
- **错误的子类划分**：入站失败原因只按错误实例上的 `code` 分类，不设 Error 子类，因为子类要靠 `instanceof` 判定
- **跨 vm 的实例检测**：不同 vm context 各自持有内置对象原型，跨 context 的 `instanceof` 会失败；这类场景在 httply 极少出现，保持 `instanceof Readable` 即可
