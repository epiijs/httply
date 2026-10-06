---
title: Node 行为验证方案
description: 从 API 承诺条款推导应验证的 Node 行为全集，给出规则取舍标准、脚本实现、运行时机，以及固定格式报告的生成和解读方法
last_updated: 2026-10-06
---

# Node 行为验证方案

## 背景：如何验证什么

`httply` 是 `@epiijs/server` 的 HTTP 消息抽象层，可以独立使用。其 API 承诺的语义是对 Node 内置 `http` 模块的多种使用方式的封装。
在实际网络中，HTTP 请求与响应的交互会产生许多意外情形，Node 的实际行为，在官方文档要么不够系统详细、要么和直觉相悖。
为了正确封装和简化 Node 的实际行为，有必要对指定的 Node 版本进行行为验证。

这份文档描述这个验证过程，包括以下机制说明：

- **脚本化验证**：这份文档会逐条列出要验证的行为，包括其实际场景和观察字段。根据这个清单会基于当前项目选择的测试框架，编写对应测试用例，托管仓库保持迭代。
- **结构化报告**：每轮验证运行后，会生成测试框架的通过情况，和需要的额外结构化细节输出，用于快速重新生成位于 `docs/report-node-x.md` 文档。
- **可重复调度**。当 Node 版本升级、行为承诺变化、或者对某个行为存疑了，可随时调度，独立发起一轮再验证。

## 约束：行为承诺清单

根据 `httply` 的 API 设计，可能在使用时遇到许多意外场景。
这里明确列出需要承诺的意外场景，和发生时 `httply` 的行为解释，即：使用方会如何从 API 的表现感知到什么。

| 编号 | 意外情形 | 承诺 |
|---|---|---|
| P1 | 请求数据读取不完整 | `body` 的 Promise 要么 resolve 完整数据、要么 reject 明确异常，不返回半份数据、不限定 method |
| P2 | 连接终止事件不正常 | 终止事件缺失或不按照文档或直觉工作，`body` 与 `applyToResponse` 的 Promise 都 settle 而不是缺漏事件挂起 |
| P3 | 响应被提前断开连接 | 写入响应操作因请求方异常中断，Promise 应当 resolve、`completed` 反映是否写完整；内部错误不上抛、不视为故障 |
| P4 | 响应过程中发生异常 | 写入响应操作因响应方异常中断，Promise 应当 reject 和透传错误 |
| P5 | 响应完成后连接残留 | 当响应完成后，连接会被及时回收，即便使用方不消费 body，也不需要自行 `Connection: close` 或自行销毁 |
| P6 | 使用方违背底层协议 | 两类错误用法：请求被响应后才读 body、重复触发写入响应，发生时应明确报错，不静默丢弃错误 |
| P7 | 连接传输被拖慢停滞 | 不额外实现超时控制；对端有推进就不主动断开慢速连接，完全停滞时也不由 httply 计时中断 |

`httply` 的其他一般行为设计不视为值得探讨的意外情形，详情见 `design-v1.md`。

### 待验证的 Node 行为

以下是解读这些行为承诺后，识别到的值得验证的 Node 行为。

1. Node 判定「请求体完整接收」的依据：`Content-Length` 定长与 `chunked` 分块两种界定方式各自的结束判据；在这两种界定方式下，截断与断连能否被察觉（P1）
2. 终止信号的到达组合：`finish`/`close`/`error`/`aborted` 事件与 `write`/`end` 回调在各意外情形下各自到哪些、按什么顺序到；`req` 层事件在什么状态下停止派发事件（P2 P6）
3. socket `close` 能否充当终止信号：它是否到达、是否只在终止时刻到达一次、未派发的 `req` 层事件由它补齐是否足以判定终止（P2 P3）
4. 断连后写入流的信号退化：`finish`、`end` 回调、状态位（`writableEnded`/`writableFinished`/`destroyed`）各自失效或失真到什么程度（P3 P4）
5. 失败的信号形态与原因归属：`pipeline` 的回调与同步抛各在什么状态下出现；`ERR_STREAM_UNABLE_TO_PIPE`、`ERR_STREAM_PREMATURE_CLOSE` 等错误码的定义与触发面，能否据信号区分原因落在请求方（断连）还是响应方（内容流出错，含显式 `destroy`）；`res.error` 何时触发、携带什么（P3 P4）
6. 误用的可检测性：响应 `finish` 时请求体是否被丢弃、丢弃前后的流状态能否取证；重复 `writeHead` 给出什么信号（P6）
7. 回收的时机与后果：`finish` 时刻请求流状态能否判定；未读完的请求被销毁时，响应送达是否受影响、socket 正常关闭还是异常复位（RST）（P5）
8. server 计时的分工：`timeout`/`requestTimeout`/`headersTimeout`/`keepAliveTimeout` 各参与哪种形态；`server.timeout` 是闲置计时还是总时限；入站停发与出站停滞是否同样由其覆盖（P7）
9. 另有若干行为不改变 httply 的实现与承诺，只作结论留档：头部解析失败（`HPE_*`）的时机与介入路径、`hadError` 的含义、空闲回收时刻的公式、各计时属性默认值、应答 `Connection` 的取值争议。它们集中在 X9，取舍见「规则的取舍」

## 推导：Node 行为验证规则

把清单每行展开成能单独判定的验证规则：

1. **文献依据**：对每个待验证行为 X[i]，查询需要的 Node 文档或协议源（`http.md` 小节与 Stability、RFC 条号）。
2. **细化判据**：对每个待验证行为 X[i]，根据文档和协议的说明，拆分成 `复现-观察-判定` 的形式规则，按`操作`和`观察`的细分情况排列组合，设计验证用例。
3. **设计用例**：对每个验证用例有条目编号 X[i]-[j]。断言可以包含：事件序列、状态位、错误码或自定义观察数值。适当考虑基础设施复用。

有这些形式要求：
1. 每个待验证行为用独立子章节细化，用表格记录所有用例的语义描述（和必要文档引用）。
2. 每个待验证行为的用例表有这些列：编号、构造行为、观察断言。
3. 一条用例可以承担多行的取证，标题并列所有编号，`-t` 命中其中任一编号即复现该用例。同一结论的多个形态优先在同一条用例内逐一构造，不拆成多条。

### 规则的取舍

一行规则留在 X1 至 X8，要同时满足两条：

1. **结论有人用**。`readRawBody`、`applyToResponse` 的分支，或 `design-v1.md`、`README.md` 的承诺以它为据，或它否掉了实现考虑过的另一种写法。
2. **结论不能靠读文档得到**。Node 官方文档已成文的默认值、公式和通用语义，引用即可，不必每轮重测。

缺一条即移入 X9。X9 仍记结论、仍留用例，只是不进常驻全量，单独运行；编号不因取舍消失，相邻两轮的行为漂移比对不受影响。

防御代码分两类，只有前者需要 X 行支撑：针对 Node 实际行为的防御，依据实测与文档条款，在表里认领编号；针对使用方违背参数契约的防御，依据承诺 P6，不需要 Node 事实验证行。TS 类型不约束运行时传入的数据，此类防御不因类型已声明而失去意义。

### X1 请求体完整接收的判定（P1）

| 编号 | 构造行为 | 观察断言 |
|---|---|---|
| X1-1 | 响应已发出后，以 `Content-Length` 声明 N 字节、实发不足 N，随即终止连接 | `req` 层不派发任何终止事件，「未接收完整」只由 `socket` 层 `end`→`error`→`close` 事件流体现（事件机制见 X2） |
| X1-2 | chunked 界定方式发送请求体，省略终止零块 | `end` 不触发，流永不自然接收完整（RFC 9112 §7.1） |
| X1-3 | GET / DELETE / OPTIONS 携带请求体并正常发全，三形态在同一条用例内逐一构造 | Node 照常派发请求体，不按 method 拦截（TRACE 限制属使用方约定；RFC 9110 §6.1.1） |
| X1-4 | 触发一次请求断连或终止 | `req.aborted` 仍会到达，可作为即时 reject 信号；该事件官方标记 Stability 0 弃用，因此不充当正确性判据，终止的判定以 socket `close`（X3-2）为准（http.md「Event: aborted」） |

### X2 终止信号的到达组合（P2 P6）

| 编号 | 构造行为 | 观察断言 |
|---|---|---|
| X2-1 | 响应发出后截断请求体（`Content-Length` 未发满或 chunked 缺终止块） | `req` 层不再派发 `aborted`/`error`/`close`；截断只余 `socket` 层 `end`→`error(HPE_INVALID_EOF_STATE)`→`close`（与 X1-1 同一条用例取证） |
| X2-2 | 未发出响应时客户端断开连接 | `req` 的 `aborted` 与 `error` 先后都到、不互斥（http.md「Event: aborted」） |
| X2-3 | 服务端调用 `req.destroy()` | `aborted` 与 `close` 到，`error` 不到 |
| X2-4 | 连接在响应完成前终止 | `ServerResponse` 只派发 `close`，无 `finish`、无 `res.error`（http.md「Event: close」） |
| X2-5 | 响应 `finish` 后首次访问入站流 | Node 把请求流置 flowing 丢弃残余，`readableDidRead` 与 `readableFlowing` 同时变为 true；「body 晚于响应到达」时 `readableDidRead` 单独失效，须并判 `flowing` |
| X2-6 | 响应正常完成后再调 `res.end()`/`write()` | 静默无效——不抛异常、不派发 `error` 事件 |
| X2-7 | 短连接（`Connection: close`）下重复 X2-4 场景 | 断连形态的终止信号与 keep-alive 同形：只派发 `close`，无 `finish`、无 `res.error`。响应后截断形态不同形，另立 X2-8 |
| X2-8 | 短连接下响应已发出后截断请求体（`Content-Length` 未发满），与 X1-1 的 keep-alive 形态对照 | Node 在 `finish` 时刻即关闭 socket，截断不进入观察时间：既无 `socket.end` 也无 `socket.error`，`close` 以 `hadError=false` 终止；`req` 层不再派发终止事件，终止信号仍在 socket 层 |

### X3 socket `close` 作为终止信号（P2 P3）

| 编号 | 构造行为 | 观察断言 |
|---|---|---|
| X3-1 | 连接终止后，再对 socket 注册 `close` 监听 | `close` 只在终止时刻派发一次，事后注册的监听不再收到（stream「close 至多一次」） |
| X3-2 | 响应发出后客户端断连 | `request.socket` 始终存在、其 `close` 可达，是响应后断连唯一可见的本地终止信号（net.md「close」） |
| X3-3 | 响应发出前的各类终止形态逐一观察：对端优雅关闭、对端 RST、服务端 `req.destroy()` 而 keep-alive 连接保留 | socket `close` 在每种形态下是否都到达。若某形态不到达（请求流单独销毁而连接保留），该形态只能依赖 `req` 层事件，`readRawBody` 不得只依赖 socket close。本行决定 `aborted` 监听（X1-4）能否从实现里去掉 |
| X3-4 | keep-alive 连接上正常写完一次响应 | `res` 的 `close` 是 per-response 语义、紧跟 `finish`，此刻 `socket.writable` 仍为真 |
| X3-5 | handler 等待期间客户端已断开，或写入流中途断连 | socket `close` 相对 `apply` 的时刻不固定——可早于本次写入开始、也可晚于写入完成 |
| X3-6 | 短连接（`Connection: close`）下正常完成与断连两形态 | `close` 信号同形：只派发一次、per-response 紧邻 `finish`（与 X2-7 同一条用例取证） |

### X4 断连后写入流的信号退化（P3 P4）

| 编号 | 构造行为 | 观察断言 |
|---|---|---|
| X4-1 | 响应写入中途连接断开，继续调 `write()`/`end()` | 断连后 `write()` 返回 false、`end()` 回调永不触发（stream `write()` 返回值） |
| X4-2 | 连接终止后读取响应状态位 | `writableFinished` 失真——`finish` 未触发仍为 true；`writableEnded` 为 true 与条款一致，不算失真（http.md writableEnded/writableFinished） |
| X4-3 | 响应正常完成（对照组）后读取 `response.destroyed` | `destroyed` 亦为 true，判据须配 `!writableEnded`、不能单看 `destroyed`（stream `destroyed`） |

### X5 失败的信号形态与原因归属（P3 P4）

| 编号 | 构造行为 | 观察断言 |
|---|---|---|
| X5-1 | 分两种时序建 pipeline 写入：目标（response）已终止后建、pipeline 在途时目标被毁 | 前者一律同步抛 `ERR_STREAM_UNABLE_TO_PIPE`、不派发回调，与是否先 `writeHead` 无关；后者由回调报 `ERR_STREAM_PREMATURE_CLOSE`（errors.md「pipeline to a closed or destroyed target」） |
| X5-2 | pipeline 写入中途连接断开 | 回调报 `ERR_STREAM_PREMATURE_CLOSE`，源流（内容流）被连带 destroy |
| X5-3 | 在真实 `ServerResponse` 上分别构造「源侧在途提前终止」与「目标侧断连」 | 两者回调都报 `PREMATURE_CLOSE` 且 `response.destroyed` 恒真（pipeline 失败连带销毁目标），凭 `destroyed` 判不出原因；原因归属只依据先捕获的源流 `error` |
| X5-4 | 源流抛真错误、连接随后关闭 | 源流错误如实经回调上抛（非 `PREMATURE_CLOSE`）；`res.close` 可早于回调到达，默认出口不得覆盖源流错误 |
| X5-5 | 分别用请求方断连、显式 `res.destroy(error)` 终止响应 | 两者都不触发 `res.error`；`destroy(error)` 所附错误由 `socket.error` 承接、不在 `res` 层派发。前半（对端断连）与 X2-4 同一条用例取证，显式 `destroy(error)` 形态构造不同、单列一条 |

### X6 误用的可检测性（P6）

| 编号 | 构造行为 | 观察断言 |
|---|---|---|
| X6-1 | 对同一响应第二次调 `writeHead` | 同步抛 `ERR_HTTP_HEADERS_SENT`（errors.md「headers already sent」；与 X2-6 同一条用例取证） |
| X6-2 | keep-alive 连接上对第二个请求做「响应后才读 body」的访问，并在 `finish` 时刻与延后一个 tick 读该请求的流状态 | 对响应后读取的判定与首请求同形（X2-5 适用面），第二请求仍判为已丢弃；第二请求的回收判定照常触发，不误销毁可复用的连接（吸收 X7-5） |

### X7 回收的时机与后果（P5）

| 编号 | 构造行为 | 观察断言 |
|---|---|---|
| X7-1 | keep-alive 连接上，请求体截断且不消费（对照：发全也不消费） | 截断未消费的 body 占用连接、后续请求不被处理；发全不消费则仍复用（`requestCount`） |
| X7-2 | body 已到齐未交付时，在 `res.finish` 时刻与延后一个 tick 各读一次流状态 | `finish` 时刻 `req.readableEnded`、`req.complete` 可为 false，延后一个 tick 才 true |
| X7-3 | 响应交入内核后销毁未读完的请求 | 客户端完整收到响应，`socket.close` 以 `hadError=false` 干净关闭（非 RST）（net.md close hadError） |
| X7-4 | GET / HEAD / `Content-Length: 0` / body 发全四种形态，在同一条用例内逐一构造 | 都不触发回收销毁，连接保持复用（`req.aborted` 未派发、`requestCount` 递增） |
| X7-5 | 见 X6-2，本轮并入该用例 | 第二请求的回收判定照常触发，不误销毁可复用的连接 |

### X8 server 计时的分工（P7）

| 编号 | 构造行为 | 观察断言 |
|---|---|---|
| X8-1 | 配 `server.timeout`，构造「未响应 + body 停发」；变体：入站逐字节低速续发、以及慢速持续写入响应 | 停发后计时到期销毁 socket、`req.aborted` 随之到达；入站每字节重置计时；持续写入的慢响应不被打断（http.md `setTimeout`） |
| X8-2 | 「未响应 + body 停发」形态，取 `connectionsCheckingInterval` 调小（100ms）与默认（30000ms）两组对照 | `requestTimeout` 与 `headersTimeout` 由该低频检查驱动，过期时刻取 `max(requestTimeout, headersTimeout)`（0 视为不参与），动作是 `ERR_HTTP_REQUEST_TIMEOUT`、回 408 并关闭连接；默认检查间隔下，秒级观察时间内没有事件，是不参与而非未触发。`keepAliveTimeout` 属另一条空闲路径，不参与本形态 |
| X8-3 | 同一形态下入站逐字节低速续发，`connectionsCheckingInterval` 调小 | 续发不重置该过期时刻，即 `requestTimeout` 是总时限而非闲置计时，与 X8-1 的 `server.timeout` 语义构成对照 |
| X8-4 | 出站停滞：对端零读取、服务端尊重背压使写入挂起（写入量取刚过内核缓冲即可），配 `server.timeout` 与 `timeout=0` 两组 | `server.timeout` 到期照常中断连接、`res.finish` 不到；`timeout=0` 时既无 `sock.timeout` 也无 `close`，`applyToResponse` 的 Promise 无人终止。本行与 X4-1 的 `drain` 不派发共同划出承诺 P2 的边界 |

### X9 行为留档（不改变 httply 的行为定义）

X9 收留三类行为：文档已经写明、读一次就够的事实；历史上出过争议或被误用过的判断；承诺面之外的边界。它们不支撑任何实现分支，也不进入承诺措辞，因此不参与每轮全量，由 `spec/vitest.config.x9.ts` 单独运行，在 Node 大版本升级或该行结论被质疑时重跑。编号不因取舍消失，相邻两轮的比对对全部编号一视同仁。

| 编号 | 构造行为 | 观察断言 |
|---|---|---|
| X9-1 | 发送畸形请求行、坏 `Content-Length` 头、超限头部，并注册 server 级 `clientError` | 解析失败发生在 handler 被调用之前，Node 直接以 400（头超限 431）应答，此时 `req`/`res` 尚不存在，消息层无介入路径；handler 之前的唯一介入点是 server 级 `clientError`，注册即接管默认处置（http.md 已成文） |
| X9-2 | 未做任何配置的 server 上请求体截断且未消费、占用 keep-alive 连接，配较短 `keepAliveTimeout` | 空闲计时到期后 Node 自行回收该连接；`keepAliveTimeout=0` 则永不回收。时刻由 http.md 成文的公式 `keepAliveTimeout + keepAliveTimeoutBuffer` 决定（buffer 自 v24.6.0 起列出，默认 1000） |
| X9-3 | 分别以带 unread 数据时 destroy（RST）与正常关闭（FIN）终止连接 | 两种都派发 `socket.close`、信号同形；`hadError` 只反映终止时是否伴随解析错误，不区分对端是否违约，不能据以判定原因 |
| X9-4 | 读取新建 server 的各计时属性默认值 | `keepAliveTimeout=5000`、`keepAliveTimeoutBuffer=1000`、`requestTimeout=300000`、`headersTimeout=60000`、`connectionsCheckingInterval=30000`、`timeout=0`（http.md 各默认值条款） |
| X9-5 | DELETE / OPTIONS 携带 chunked body 发全并读取，读应答的 `Connection` 取值 | 两者均回 `Connection: keep-alive`。旧报告记的 `Connection: close` 加 `HPE_CLOSED_CONNECTION` 对应 Node v10/v11 客户端的 body 处理缺陷（#19179、#27880），新版本不复现。观察顺带在 X1-3 的用例里取证 |
| X9-6 | 不设用例的登记：`Expect: 100-continue`、trailer 头、请求 pipelining、HTTP/1.0 界定方式 | 这些形态下 Node 行为的变化不触及 P1 至 P7 任何一条，登记理由即可 |

## 用例集：实现与运行

### 验证用例的组织

验证用例独立于 httply 的门禁测试，二者分开存放、分开运行：

- **位置**：放在项目根目录下的 `spec/`，只使用 `node:` 内置模块，不引用 `build/` 产物，不纳入 `npm test` 与覆盖率。
- **分工**：`spec/` 验证 Node 自身的 HTTP 行为；`test/` 验证 httply 对外的行为承诺。
- **组织**：一个行为组一个文件，文件名 `x<组号>-<主题>.test.js`，X9 组是 `x9-behavior-archive.test.js`；用例标题写条目编号，`-t <编号>` 单独复现该用例及其时间线。

### 验证用例的要求

新增或修改用例应遵守：

1. 判定前观察要充分、确认不再有新事件：正向等预期终止事件全部到齐；负向断言「某事件不发生」没有到达信号，等一段有限时间（取被测配置值的五倍）未见即判为未发生。有限时间只是上限，事件到齐就提前返回，不让用例常态跑满。
2. 记录事件时序细节：req 层与 socket 层分开记录，输出为带时间戳的有序事件序列（每行 `事件@毫秒`）。以状态位或连接复用计数为判据的用例输出这些值本身，不产生事件序列，其时间线为空属预期。
3. 每个用例需要临时服务，`listen(0)` 监听端口，客户端用 `net.Socket`、请求侧 `agent: false`。
4. 观测入站流的用例，自身不得先于被测方读取或消费 `req`（注册 `data` 监听会使流进入 flowing 状态导致观测状态污染）。`helpers.js` 的 `recordReq` 默认挂 `data`，凡取证 `readableDidRead`、`readableFlowing` 的用例必须显式传 `{ data: false }`。

### 运行时机与命令

| 级别 | 命令 | 什么时候运行 |
|---|---|---|
| httply 日常测试 | `npm test`（含 build，承诺用例） | 每次提交前 |
| node 行为用例全量 | `npx vitest run -c spec/vitest.config.ts` | 升级 Node 版本、手动生成报告 |
| node 行为 X9 组 | `npx vitest run -c spec/vitest.config.x9.ts` | 升级 Node 大版本，或该行结论被质疑时 |
| node 行为用例单条 | `npx vitest run -c spec/vitest.config.ts -t X3-2` | 解读报告的异常项 |

用例集自带两份配置：`spec/vitest.config.ts` 收集 `x[1-8]-*.test.js`，`spec/vitest.config.x9.ts` 只收集 `x9-*.test.js`。分组只靠文件名，不设子目录。
项目根目录 `vitest.config.ts` 负责日常测试 `test/`，各份配置互不引用。

## 报告：生成与解读

### 模板

一次运行产出一份报告，整份写入 `docs/report-node-[x]-v[v].md`（x 指 Node major 版本，v 是运行轮次）。
报告按轮次自增版本，重新生成，不在旧文件上逐轮手工维护。不需要留档时清理所有旧版本报告。

逐用例时间线属运行产物，存于 `spec/` 下的 `*.log`，不入版本库。报告以条目编号引用证据，只有改判条目所需的关键序列写进「结论更新记录」。

```markdown
# Node 行为验证报告
- 环境：Node v<A.B.C> / vitest <x.y.z> / 日期
- 结论：定案 n 项，假说 n 项，未验 n 项，豁免 n 项，存档 n 项
- 行为判据表：逐条列出 X1-X9 的实测判定，每行给出结论（定案/假说/未验/豁免/存档）与证据出处（spec 条目、文档条款）
- 结论更新记录：本轮与上一轮结论相悖的条目，各附事件时间线
- 假说与空洞清单：未验与假说行汇总；新发现的空洞直接立条目，需外部协同的投递 todo-list.md
- 规则表处置对照：改写过规则行（增删、移位、改写措辞）的轮次，附一张上一轮到本轮的编号对照表
```

### 生成步骤

1. **回归运行**：常驻用例集全量跑一遍，门禁 `npm test` 跑一遍；X9 组另跑一次，其结论记入报告但不计入承诺面的统计。按用例标题的 X 编号把用例集 PASS/FAIL 归到行为行，承诺项不归行。
2. **补充验证**：报告里结论为未验或假说的条目，按其补用例参数写成用例；扫描推导新暴露的空洞，直接在对应组立为未验条目。用例固化进用例集，并按「规则的取舍」两条判据复核每一行的归属，不改变实现也不受文档条款担保的行移入 X9。
3. **对照文档**：每个行为需要引文（`curl` 抓取 `raw.githubusercontent.com/nodejs/node/<tag>/doc/api/http.md` 与 `errors.md`，tag 取实际版本号），引文变化即复核对应条目。
4. **同步结论**：本轮推翻的结论、以及影响到 `design-v1.md` 或 README 的条款失效，改写对应文档并在报告记「结论更新记录」；台账销账。

### 解读方法

报告里每条行为行给出一个结论，各档次的含义如下：

- **定案**：实测与文档条款互证一致，且有常驻用例守着；本轮 PASS 即视为在新版本下复核通过。
- **假说**：只有实测、缺文档条款，或有条款但缺实测；承诺若仅依赖它支撑，需在 `design-v1.md` 为其加限定语。
- **未验**：既无实测也无从判定，是扫描推导组合时暴露的空洞；附补用例参数。
- **豁免**：该形态下 Node 的行为不触及任何承诺，登记可复核的理由即可，Node 变化不影响承诺成立。
- **存档**：有结论但无复现入口的纯数值（如默认超时值），只在与活跃结论矛盾时重测。

假说行是 httply 的风险敞口：读报告时先看有哪些承诺只靠假说支撑，据此决定 `design-v1.md` 里哪几句要加限定语。

行为漂移由相邻两轮报告的同行结论比对得出：某行从定案退回假说或未验，即 `design-v1.md` 需要重审的条目，处置见生成步骤的「同步结论」。

## 讨论项

暂无讨论项。
