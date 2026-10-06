---
title: Node 行为验证报告（Node 24 · 第 3 轮）
description: 按现行规则表复跑 Node 24 HTTP 行为的判据表，含 v2 到 v3 的逐行比对结果与实现拆分后的防御分支对表
last_updated: 2026-10-06
---

# Node 行为验证报告

- 环境：Node v24.14.0 / vitest 3.2.6 / macOS 25.6.0 arm64 / 2026-10-06。Node 版本与第 2 轮相同，条款按 v24.14.0 tag 的 `doc/api/{http,errors,net,stream}.md` 与 RFC 原文再核一次，引文无变化
- 本轮性质：实现拆分后的确认轮。规则表与用例集都不改（X1 至 X8 共 37 行、常驻 38 用例、X9 组 6 行 9 用例）。自第 2 轮以来实现侧的变动只有文件与命名：`src/message.ts` 拆为 `src/core/incoming-message.ts` 与 `src/core/outgoing-message.ts`，`releaseUnfinishedRequest` 改名 `reclaimUnreusableConnection`，入站丢弃错误码改名 `HTTPLY_BODY_DROPPED`——没有一处改变取证点
- 结论：X1 至 X8 共 37 行，定案 27 项、假说 10 项、未验 0 项；X9 组 6 行，定案 4 项、豁免 2 项，单独运行，不计入承诺面统计
- 复现入口：常驻 `npx vitest run -c spec/vitest.config.ts`（38 用例 21.5s，本轮三次全量 38/38 全部通过）；X9 组 `npx vitest run -c spec/vitest.config.x9.ts`（9 用例 7.4s，全部通过）；单条 `-t <条目编号>`；门禁 `npm test`（47 用例 5.5s，语句 97.72%、分支 86.95%、函数 100%）；逐用例时间线见 `spec/node-24-v3.log`
- 上一轮基线：`report-node-24-v2.md`（已删除，结论全部迁入本报告）。本轮未改写规则行，两侧同行同序，逐行结论比对见「v2 到 v3 逐行比对」
- 本轮定性：无回归。三条时间线在轮内抖动（X5-2 的 socket 层组合、X6-2 的 `readableDidRead`、X8-4 的停滞字节量），都不触及判据，抖动值全部记入 log。另用交叉读既有时间线关闭了台账挂着的「响应已开始写出但尚未 `finish`」形态

判据列格式：结论：实测条目 + 文档出处。各档结论的含义见 `design-node-test.md`「报告：生成与解读」。

## 行为判据表

### X1 请求体完整接收的判定（P1）

| 编号 | 行为断言 | 规则判据 |
|---|---|---|
| X1-1 | `Content-Length` 界定下声明未发满即连接终止，`req` 层无任何终止事件，「未接收完整」只能由 socket 层感知 | 假说（仅实测）：spec X1-1（`res.finish@7` 之后仅剩 `socket.end@126`→`socket.error(HPE_INVALID_EOF_STATE)@126`→`socket.close(hadError=true)@126`，`req` 层零事件）；http.md 无「`req` 层何时停止派发终止事件」条款。本轮补出边界：零事件形态以 `res.finish` 为界，响应已写出但未 `finish` 时 `req` 层事件照旧派发（见 X5-1、X4-1） |
| X1-2 | chunked 界定方式不发终止块时 `end` 不触发，流永不自然接收完整 | 定案：spec X1-2（`req.data(16)@2` 之后 800ms 观察时间内没有事件）+ RFC 9112 §7.1（chunked 以 0 尺寸块终止） |
| X1-3 | 任意 method 的请求体 Node 都照常派发，不按方法拦截 | 定案：spec X1-3（GET 走定长、DELETE 与 OPTIONS 走 chunked，同一条用例逐形态构造，`req.end` 三次均到、字节数逐项对上）+ RFC 9110 §6.1.1 |
| X1-4 | `req.aborted` 在 Node 24 仍触发，可作即时 reject 信号，但官方标记 Stability 0 弃用，不充当正确性判据 | 定案：spec X2-2、X2-3、X3-3 + http.md「Event: `'aborted'`」（`Stability: 0 - Deprecated. Listen for the 'close' event instead.`）；正确性判据由 X3-3 的 socket close 承担 |

### X2 终止信号的到达组合（P2 P6）

| 编号 | 行为断言 | 规则判据 |
|---|---|---|
| X2-1 | 响应 `finish` 后，Node 不再向 `req` 派发 `aborted`/`error`/`close`，截断只剩 socket 层事件 | 假说（仅实测，取证与 X1-1 同一条用例）：spec X1-1、X6-2 的第三请求（`events=[]`）；`HPE_*` 属 llhttp 内部，errors.md 只收录三个码 |
| X2-2 | 未响应时客户端断连：`req` 的 `aborted` 与 `error` 先后都到，不互斥 | 定案：spec X2-2（`req.aborted@67` 先于 `req.error(ECONNRESET)@67`）+ http.md「Event: `'aborted'`」与 close 条款 |
| X2-3 | 服务端 `req.destroy()`：`aborted` 与 `close` 到，`error` 不到 | 定案：spec X2-3（`req.aborted@33`→`req.close@34`，全程无 `req.error`）+ http.md「`message.destroy()`」+ stream.md close 语义 |
| X2-4 | 连接终止后 `ServerResponse` 只派发 `close`，无 `finish`、无 `res.error`；显式 `res.destroy(error)` 亦不在 `res` 层派发错误 | 定案：spec X2-4（`res.close@63`，`finish` 与 `res.error` 全程未派发）、X5-5 + http.md ServerResponse「Event: `'close'`」（`or its underlying connection was terminated prematurely`） |
| X2-5 | 响应 `finish` 时 Node 把请求流置 flowing 并丢弃残余，晚访问读到空 Buffer：定长界定下 body 先于响应到齐与晚于响应到达两种时序都实测 `resolve(0)`；`readableDidRead` 单独不可靠，判据须并取 `readableFlowing` | 假说（仅实测）：spec X2-5、X2-5-late、X6-2、X7-4。本轮三次全量复现滞后：X6-2 的 `flowing` 恒为 true，`didRead` 两次 true 一次 false（同取于 `finish` 后约 80ms）。stream.md 只定义两属性语义，无「`finish` 自动 resume」条款 |
| X2-6 | 正常完成后的 `res.end()/write()` 静默无效（不抛、不冒 error） | 假说（与条款相悖）：spec X2-6；errors.md `ERR_STREAM_WRITE_AFTER_END` 通例是报错，http.md 对 `ServerResponse` 无豁免条款 |
| X2-7 | 短连接（`Connection: close`）下断连形态的终止信号与 keep-alive 同形 | 定案（带限定）：spec X2-7-abort（只派发 `close`、无 `finish`、无 `res.error`）+ http.md close 条款。响应后截断形态不同形，另见 X2-8 |
| X2-8 | 短连接下响应发出后截断请求体：Node 在 `finish` 时刻即关闭 socket，截断不进入观察时间 | 定案：spec X2-8-trunc（`res.finish@1 res.close@1 socket.close(hadError=false)@1`，既无 `socket.end` 也无 `socket.error`，与 X1-1 的 keep-alive 形态正面对照）+ RFC 9112 §9.6 与 http.md 对短连接在响应 `finish` 后关闭连接的成文表述。`req` 层不再派发终止事件，终止信号仍在 socket 层 |

### X3 socket `close` 作为终止信号的资格（P2 P3）

| 编号 | 行为断言 | 规则判据 |
|---|---|---|
| X3-1 | `close` 只在连接终止时刻派发一次；终止后再监听收不到 | 定案：spec X2-4（`res.close` 计数 1、迟挂监听无事件）+ stream.md close 条款（`The event indicates that no more events will be emitted`——条款承诺其后不再派发任何事件，「只派发一次」取证实测） |
| X3-2 | `request.socket` 始终存在且其 `close` 可达，是响应后断连唯一可见的本地终止信号 | 定案（带限定）：spec X1-1 + http.md「`message.socket`」，条款自带例外（`type other than {net.Socket} or internally nulled`，即 upgrade 与自定义 socket），该例外按 H5 豁免登记 |
| X3-3 | 响应发出前的各类终止形态（对端 FIN、对端 RST、服务端 `req.destroy()`）下 socket `close` 都到达 | 假说（仅实测）：spec X3-3（`/fin.socket.close(hadError=true)@88`、`/rst...@170`、`/destroy.socket.close(hadError=false)@203`，`req.aborted` 依次在同刻或更早到达）。无任何条款承诺「销毁请求必连带终止 socket」。实现含义见「防御分支与规则行的对应」：socket close 单独即可保证 `body` 必 settle，`aborted` 监听不提供独有覆盖 |
| X3-4 | keep-alive 下 `res` 的 `close` 是 per-response 语义，紧跟 `finish`，此刻 socket 仍可写 | 定案：spec X3-4（`res.finish@3`→`res.close(writable=true)@3`）+ http.md close 条款措辞 |
| X3-5 | socket `close` 相对写入的时刻不固定，可早于本次写入开始、也可晚于写入完成 | 假说（仅实测）：spec X2-4（`res.close@63` 早于 `apply@203`）与 X5-3a/3b、X5-4（回调与 `close` 同刻竞先后）；无文档条款 |
| X3-6 | 短连接下 `close` 信号同形：只派发一次、正常完成紧邻 `finish` | 定案（取证与 X2-7 同一条用例）：spec X2-7-normal（`close` 计数 1，`finish` 早于 `close`） |

### X4 断连后写入流的信号退化（P3 P4）

| 编号 | 行为断言 | 规则判据 |
|---|---|---|
| X4-1 | 断连后 `write()` 返回 false、`end()` 回调永不触发，且 `drain` 亦永不到来 | 定案：spec X4-1（2.5s 观察时间内 `res.drain` 未派发）+ stream.md `write()` 返回值条款。实现含义：断连后等待 drain 续写会一直不返回，只能依据终止事件 |
| X4-2 | `writableFinished` 失真：`finish` 未触发仍为 true | 假说（条款与实测相背，沿用第 1 轮改判）：spec X4-1；http.md 把该属性定义为「`all data has been flushed to the underlying system, immediately before the 'finish' event is emitted」。`writableEnded` 为 true 与条款一致，不算失真。判据只认 `finish`/`close` 事件 |
| X4-3 | `response.destroyed` 在响应正常完成后同为 true，判定必须配 `!writableEnded` | 定案：spec X4-3 + stream.md `destroyed` 条款 |

### X5 失败的信号形态与原因归属（P3 P4）

| 编号 | 行为断言 | 规则判据 |
|---|---|---|
| X5-1 | pipeline 建立在目标已终止之后：一律同步抛 `ERR_STREAM_UNABLE_TO_PIPE` 且不给回调，与是否先 `writeHead` 无关；在途被毁则走回调报 `ERR_STREAM_PREMATURE_CLOSE` | 假说（仅实测，上游正在改）：spec X5-1a/1b/1c 三形态本轮均 PASS（`pipeline.throw(ERR_STREAM_UNABLE_TO_PIPE)@207`、`@202`；在途销毁走回调 `PREMATURE_CLOSE@109`）。errors.md 只有码义（`An attempt was made to pipe to a closed or destroyed stream in a pipeline.`），对同步性与是否给回调完全沉默；nodejs/node #65063（同步抛泄漏 fd）、#65127（同步抛与回调成功并存）本轮复核仍为 open。实现不得把入口处的连接状态判定与 `close` 监听收敛成单一依赖；Node 次版本升级时本行优先复跑。本组时间线另证：目标未 `finish` 而断连时 `req` 层事件照常派发（`req.aborted`/`req.error`/`req.close` 都在），边界是 `finish` |
| X5-2 | pipeline 中途断连：回调报 `ERR_STREAM_PREMATURE_CLOSE`，源流被连带 destroy | 定案：spec X5-2 + errors.md `ERR_STREAM_PREMATURE_CLOSE` + stream.md pipeline 条款。本轮 socket 层出现两形态：run1/run2 是 `socket.end@122`→`socket.close(hadError=false)@123`，run3 是 `socket.error(ECONNRESET)@122`→`socket.close(hadError=true)@122`。客户端 `destroy()` 时接收缓冲尚有未读响应字节即以 RST 而非 FIN 终止，与 X9-3 的结论一致（两形态同派发 `socket.close`、`hadError` 不区分原因），回调码与两侧 destroy 三个断言不受影响 |
| X5-3 | 源侧提前终止与目标侧断连在真实 `ServerResponse` 上都报 `PREMATURE_CLOSE` 且 `response.destroyed` 恒真，凭它判不出原因；原因归属只依据先捕获的源流 `error` | 定案：spec X5-3a/3b（`resDestroyed=true@3`）+ stream.md「`pipeline()` will call `stream.destroy(err)` on all streams except …」。本行同时否证了「用目标流状态判原因」的写法，实现里那个恒真的 `&& response.destroyed` 条件据此删除 |
| X5-4 | 源流真错误如实经回调上抛（非 `PREMATURE_CLOSE`）；`res.close` 可早于回调到达，默认出口不得覆盖源流错误 | 定案：spec X5-4（`socket.error(source boom)@4`→`res.close@5`→回调 `@5`，同刻竞先后）+ stream.md pipeline 转发错误条款 |
| X5-5 | 请求方断连与显式 `res.destroy(error)` 都不触发 `res.error`，后者所附错误由 `socket.error` 承接 | 假说（仅实测）：spec X5-5（`socket.error(boom)@55`，全程无 `res.error`）+ X2-4；http.md 只对 `IncomingMessage.destroy()` 写成「error 派发到 socket」，`ServerResponse` 方向无条款 |

### X6 误用的可检测性（P6）

| 编号 | 行为断言 | 规则判据 |
|---|---|---|
| X6-1 | 同一响应重复 `writeHead` 同步抛 `ERR_HTTP_HEADERS_SENT` | 定案（取证与 X2-6 同一条用例）：spec X2-6（`writeHead.throws(ERR_HTTP_HEADERS_SENT)@63`）+ errors.md |
| X6-2 | keep-alive 后续请求的响应后读取判定与首请求同形；回收判定照常 | 定案（带限定）：spec X6-2（同一条连接依次三请求，`count=3`）。`flowing` 在 `finish` 时刻即为 true，`didRead` 要到其后数十毫秒才跟上，故 httply 的判据以 `flowing` 为可靠的一半，`didRead` 只作补充。判据本身依赖 X2-5 的假说定性 |

### X7 回收的时机与后果（P5）

| 编号 | 行为断言 | 规则判据 |
|---|---|---|
| X7-1 | 截断且未消费的 body 占用 keep-alive 连接，后续请求不被处理；发全不消费则仍复用 | 定案：spec X7-1a（连接复用计数 1，时间线为空属快照取证）、X7-1b（计数 2、两响应均到）+ http.md `keepAliveTimeout` 条款 |
| X7-2 | `res.finish` 时刻 `req.readableEnded` 与 `req.complete` 可为 false，延后一个 tick 才为 true | 假说（仅实测）：spec X7-2（本轮 `res.finish@2` 与 `req.end@2` 同刻，false 窗口存在但窄，延后一个 tick 仍为必需）；无文档条款 |
| X7-3 | 响应交入内核后销毁请求：客户端完整收到，`socket.close(hadError=false)` 干净关闭非 RST | 定案：spec X7-3（`server.req.destroy@2`→`req.aborted@2`→`socket.close(hadError=false)@3`，客户端收到完整 200 与全部字节）+ net.md close(hadError) 条款 |
| X7-4 | GET / HEAD / `Content-Length: 0` / body 发全四种形态都不触发回收销毁，连接复用 | 定案：spec X7-4-GET/HEAD/CL0/full（同一条用例逐形态构造，四形态的第二请求均被处理、`req.aborted` 全程未派发）；同条另证无 body 形态下 `didRead=false` 而 `flowing=true` |
| X7-5 | keep-alive 后续请求的回收判定照常：`finish` 后一个 tick `readableEnded` 仍 false（截断不交付），`req` 层零事件 | 定案（取证并入 X6-2）：spec X6-2 的第三请求（`atFinish.ended=false`、`atNextTick.ended=false`、`events=[]`） |

### X8 server 计时的分工（P7）

| 编号 | 行为断言 | 规则判据 |
|---|---|---|
| X8-1 | `server.timeout` 是闲置计时：对「未响应 + body 停发」的连接到期即销毁 socket、`req.aborted` 随之到达；入站逐字节与出站持续写入都重置它 | 定案：spec X8-1a（`sock.timeout@408`→`socket.close(hadError=false)@411`）、X8-1b（每 300ms 发送 1 字节，400ms 计时不触发）、X8-1c（`res.finish@1354` 的慢响应正常完成，全程无 `sock.timeout`）+ http.md `server.timeout`（`The number of milliseconds of inactivity before a socket is presumed to have timed out`） |
| X8-2 | `requestTimeout` 与 `headersTimeout` 由 `connectionsCheckingInterval` 的低频定期检查执行，过期时刻取 `max(requestTimeout, headersTimeout)`，动作是 `ERR_HTTP_REQUEST_TIMEOUT`、回 408 并关闭连接；默认检查间隔 30000ms 下，秒级观察时间内没有事件 | 定案：spec X8-2（对照组，默认检查间隔下观察时间内只有 `req.data(40)@2`）与 X8-2-ctl（`cci=100`、rt=ht=300，`socket.error(ERR_HTTP_REQUEST_TIMEOUT)@305`→408）+ http.md 的 408 条款（`responds with status 408 without forwarding the request to the request listener`）与 errors.md `ERR_HTTP_REQUEST_TIMEOUT` |
| X8-3 | 该过期时刻是总时限：入站低速持续发送不重置它 | 定案：spec X8-3（每约 60ms 发送 1 字节，仍在 `ERR_HTTP_REQUEST_TIMEOUT@305` 过期，`drip@306 drip@370` 在过期后继续）+ http.md `requestTimeout` 措辞（`the entire request from the client`），与 X8-1 的闲置语义构成对照 |
| X8-4 | 出站停滞：对端零读取、服务端尊重背压使写入挂起，配 `server.timeout` 时到期照常中断、`res.finish` 不到；`timeout=0` 时既无 `sock.timeout` 也无 `close`，`applyToResponse` 的 Promise 无人终止 | 定案：spec X8-4（`sock.timeout@802`→`res.close@802`，`stalled(917504,closed)@803`，`res.finish` 全程未派发）与 X8-4-off（同一构造 `stalled(851968,patience)@1503`，零终止事件）+ http.md `server.timeout` 条款。挂起字节量三轮取到 851968、917504、983040 三档（内核接收窗与写入节奏竞先后），停滞这一事实恒成立。本行与 X4-1 的 drain 未派发共同划出承诺 P2 的边界 |

### X9 行为留档（不改变 httply 的行为定义）

| 编号 | 行为断言 | 规则判据 |
|---|---|---|
| X9-1 | 请求行与头解析失败在 handler 被调用之前由 Node 直接以 400（头超限 431）应答，消息层无介入路径；handler 之前的唯一介入点是 server 级 `clientError`，注册即接管默认处置 | 定案：spec X9-1a/1b/hook/overflow 本轮复跑（四形态 `handler` 计数均为 0，`clientError(HPE_INVALID_METHOD,bytesParsed=1,rawPacket=37)@2`）+ http.md `clientError` 条款 |
| X9-2 | 不干预时回收时刻 = 最后入站字节 + `keepAliveTimeout` + `keepAliveTimeoutBuffer`；`keepAliveTimeout=0` 则永不回收 | 定案：spec X9-2a（`keepAliveTimeout=200`，`socket.close(hadError=false)@1208`，即 200 + 缓冲 1000）、X9-2b（`keepAliveTimeout=0`，2500ms 内无 `socket.close`）+ http.md 公式条款（`socketTimeout = keepAliveTimeout + keepAliveTimeoutBuffer`，buffer 自 v24.6.0 成文，默认 1000） |
| X9-3 | RST 与 FIN 都派发 `socket.close`，信号同形；`hadError` 只反映终止时是否伴随解析错误，不区分原因 | 定案：spec X9-3-fin（`socket.end`→`socket.error(HPE_INVALID_EOF_STATE)`→`close(hadError=true)`）、X9-3-rst（`socket.error(ECONNRESET)`→`close(hadError=true)`），两条 `hadError` 同值。两条路径都不读该标志位，结论是否定式的：不能据以判定原因。本轮 X5-2 的抖动复现了同一含义的另一侧 |
| X9-4 | 各 server 计时属性的默认值 | 定案：spec X9-4 + http.md 各默认值条款：`keepAliveTimeout=5000`、`keepAliveTimeoutBuffer=1000`、`requestTimeout=300000`、`headersTimeout=60000`、`connectionsCheckingInterval=30000`、`timeout=0` |
| X9-5 | DELETE / OPTIONS 带 chunked body 发全时，应答 `Connection` 均为 keep-alive | 豁免（第 1 轮销账）：旧报告记的 `Connection: close` 加 `HPE_CLOSED_CONNECTION` 对应 Node v10/v11 客户端缺陷（#19179、#27880）。观察顺带在 X1-3 的用例里取证，不单独设用例 |
| X9-6 | `Expect: 100-continue`、trailer 头、请求 pipelining、HTTP/1.0 界定方式不改变 httply 行为 | 豁免：这些形态下 Node 行为变化不构成承诺失效，登记理由即可，不设用例 |

## v2 到 v3 逐行比对

规则行未增删、未移位、未改写措辞，因此不需要编号处置对照。37 行逐行比对的结论是：**全部与第 2 轮同判，无改判、无回归**——定案 27 行本轮全部 PASS，假说 10 行的定性依据未变（同一 Node 版本、同一批条款、上游两条 issue 仍 open）。

比对时需要注意的一处对应关系：第 2 轮的 `spec/node-24-v2.log` 里若干时间线标签沿用改写前的编号（`[X3-2b]`、`[X3-3]`、`[X8-2-drip]`、`[X8-3]`、`[X8-3-off]`），与规则行对不上，取那一轮的证据时要按下面的映射。本轮起用例标签与规则编号一致，不需要映射：

| v2 log 标签 | 规则行 | v3 log 标签 |
|---|---|---|
| `[X3-2b]` | X3-3 | `[X3-3]` |
| `[X3-3]` | X3-4 | `[X3-4]` |
| `[X8-2-drip]` | X8-3 | `[X8-3]` |
| `[X8-3]` | X8-4 | `[X8-4]` |
| `[X8-3-off]` | X8-4 对照 | `[X8-4-off]` |

轮内抖动的三行（判据不变，实测值记入 `spec/node-24-v3.log` 末节）：

| 行 | 三轮取值 | 是否影响判据 |
|---|---|---|
| X5-2 | run1/run2 客户端以 FIN 终止（`hadError=false`），run3 以 RST 终止（`hadError=true`） | 否。断言只锁回调码与两侧 destroy；两形态都派发 `socket.close`，正是 X9-3 的结论 |
| X6-2 | `didRead` 在 `finish` 后约 80ms 取样：true / false / true | 否。断言只锁 `flowing`，实测值入时间线。这正是 X2-5 记的滞后 |
| X8-4 | 停滞字节量 917504 / 851968 / 917504，`timeout=0` 组 851968 / 851968 / 983040 | 否。判据是「写入挂在 drain 上、`finish` 不到」，量值只是内核窗口的读数 |

## 结论更新记录

本轮没有条目改判。以下三条是新增的取证与文字校正，都不改变任何一行的结论档次。

1. **台账挂着的「响应已开始写出但尚未 `finish`」形态，由既有用例交叉读证关闭，不改措辞。** 第 2 轮投递的这条待办问：`design-v1.md` 写「响应 `finish` 之后，Node 不再向 `req` 派发终止事件」，而 X1-1、X2-1 的用例都在 `res.end` 之后构造断连，写一半再断开的形态没有取证行。本轮读 X5-1a/1b 与 X4-1 的时间线即得答案：这三条都是响应已 `writeHead`、数据已在途、从未 `finish` 而连接终止的形态，`req.aborted`、`req.error(ECONNRESET)`、`req.close` 全部照常派发（X5-1b：`socket.end@61 req.aborted@61 … req.error(ECONNRESET)@61 req.close@61`）。所以零事件形态的边界确实是 `finish`，不是「响应开始写出」，现有措辞准确，不能放宽为「响应发出之后」。`readRawBody` 的两个信号在该形态下也都覆盖：`error` 监听当场即 reject，socket `close` 兜在其后。台账该条销账。
2. **X3-1 的引文校正。** 第 2 轮写作「stream.md『close 至多一次』」，按 v24.14.0 原文核对，stream.md 的 close 条款说的是「`'close'` 事件之后不再派发任何事件（`no more events will be emitted`）」，并未逐字承诺「只派发一次」。「只派发一次」靠 X2-4 的迟挂监听实测取证。档次不变（定案），措辞按本轮判据表。
3. **X5-1 的上游状态复核：两条 issue 仍 open。** nodejs/node #65063（同步抛时泄漏 fd）与 #65127（同步抛与回调成功并存）本轮按 API 复核均未关闭，且当前 Node 版本与第 2 轮相同，故本行仍为假说、仍要求「入口判定与 `close` 监听两者不得收敛成单一依赖」。挂账的外部协同项不变。

## 防御分支与规则行的对应

本轮实现侧的文件拆分使第 2 轮报告里的 `src/message.ts:行号` 全部失效，按下表重新对位。**行号变化不伴随任何判定改动**：条件表达式、监听对象、settle 路径逐项与第 2 轮一致，唯一实质改动是把「`finish` 时刻那次冗余的 `readableEnded` 检查删掉后剩下的 `if (!request) return;`」改写为 `if (request) { … }`，判定不变。

审视范围仍是 `readRawBody`（含 `body` getter 的读取时机判据）与 `applyToResponse` 两条路径。入站构造器的空值默认（`raw.url || '/'`、`raw.method || 'GET'`）与 `from()` 的默认补全不在本轮之内：它们防的是使用方违背参数契约，依据是承诺 P6，类型声明不约束运行时实际传入的数据。

| 实现分支 | 防什么 | 认领的规则编号 | 本轮裁定 |
|---|---|---|---|
| `isDestinationGone`（`src/core/outgoing-message.ts:20`） | `ERR_STREAM_UNABLE_TO_PIPE` 只可能来自目标侧 | X5-1 | 保留。门禁的 mid-pipe 断连与写入途中 `res.destroy()` 两条用例都会调用它（`||` 的左侧）；返回 true 的那一支只在「入口判定通过后、pipeline 建立前目标才终止」的窗口内可达，本轮与第 2 轮都没有实测样本 |
| `isPrematureClose`（`src/core/outgoing-message.ts:25`） | `PREMATURE_CLOSE` 两侧都可能产生 | X5-2、X5-3 | 保留。两处用法：调用处不带 `&& response.destroyed`；源流 `error` 捕获处过滤连带销毁 |
| `reclaimUnreusableConnection`（`src/core/outgoing-message.ts:31-42`） | 响应后未读完的请求体占用 keep-alive 连接 | X7-1、X7-2、X7-3、X7-4 | 保留。函数名自第 2 轮的 `releaseUnfinishedRequest` 改来，`setImmediate` 延后一个 tick 仍是 X7-2 这条假说在实现里唯一用得上的地方 |
| `if (request)`（`src/core/outgoing-message.ts:34`） | 使用方传入非标准响应对象时取不到 `req` | 无（参数契约，P6） | 保留，对外契约口径 |
| 响应后读取判据（`src/core/incoming-message.ts:19-22`） | 响应后首次读取只会读到空 Buffer 且不报错 | X2-5、X6-2、X7-4 | 保留。可靠性来自 `flowing` 这一半，`didRead` 可滞后数十毫秒（本轮复现） |
| `request.on('error', abort)`（`src/core/incoming-message.ts:27`） | 终止信号之一；同时使无监听器的 `error` 事件不会抛出到进程外 | X2-2、X2-3（派发面）；通则见 events.md | 保留，统一以 `HTTPLY_BODY_ABORTED` 给出 `request aborted` |
| ~~`request.on('aborted', ...)`~~ | 响应前断连的即时 reject | X1-4、X3-3 | 维持第 2 轮的删除裁定。本轮三种终止形态下 socket `close` 仍全部到达，弃用事件不进实现判据 |
| socket `close` 监听（`src/core/incoming-message.ts:36-40`） | 响应 `finish` 后 `req` 层无终止事件，截断的 body 会永久 pending | X1-1、X2-1、X3-2、X3-3 | 保留，是终止判定的唯一通用信号 |
| 入口处的连接状态判定（`src/core/outgoing-message.ts:113-119`） | `close` 不再派发第二次，只监听会永久挂起；并释放未消费的内容流 | X3-1、X3-5、X4-3 | 保留。内容流 `destroy()` 有门禁断言 |
| Promise 先到先得（`src/core/outgoing-message.ts:123-142`） | `finish`/`close`/回调多路竞争只 settle 一次 | X2-4、X5-4 | 保留。第 2 轮的显式 `settled` 标志已由 Promise 自身的重复 settle 无效承担，不再有独立标志位 |
| `completed` 只认 `finish`（`src/core/outgoing-message.ts:128-131`） | 断连路径下 `writableEnded`/`writableFinished` 失真 | X4-1、X4-2 | 保留 |
| `response.on('error', settleReject)`（`src/core/outgoing-message.ts:134`） | 非流式内容的 `write()` 出错；无监听时抛出到进程外 | 无（X2-4、X5-5 恰证真实响应不派发） | 保留，依据是进程保护 |
| `close` 不覆盖源流错误（`src/core/outgoing-message.ts:136-142`） | `close` 可早于回调到达，一到就 resolve 会把源流真错误误判为断连 | X5-3、X5-4 | 保留，源流错误的定义是「非连带销毁的错误」 |
| pipeline 回调三分流（`src/core/outgoing-message.ts:152-165`） | 原因归属：源侧错误 reject、目标侧终止 resolve、其余错误原样 reject | X5-1、X5-2、X5-3、X5-4 | 保留。默认出口 `settleReject(error)`（161-163）在真实响应上无可达路径，作为承诺 P4 的默认出口留着 |

本轮无「有证据行、无实现消费」的缺失项需要补防御：X8 组的结论仍只支撑措辞（`design-v1.md`「使用方的正确用法」的不设超时条），不进入分支。

## 用例集审计：覆盖度、冗余与缺失

**覆盖度。** 38 条常驻用例覆盖 X1 至 X8 全部 37 行，无遗漏行；判据取标志位或复用计数而非事件序列的用例（X6-2、X7-1a/1b、X7-2、X7-4）时间线为空或稀疏属预期。本轮把用例的时间线标签统一到规则编号，读报告不再需要映射表。

**冗余。** 本轮未新增或合并取证点。第 2 轮的合并（X1-3 三 method 为一、X7-4 四形态为一、X7-5 并入 X6-2、X5-5 前半并入 X2-4、X6-1 归宿主 X2-6、X2-1 归 X1-1）继续成立，未见新的重复。

**缺失。** 本轮无新增缺失行。台账在「代码质量」挂的有界等待两写法并存仍未处理：`x2-termination`、`x4-write-degradation`、`x5-pipeline-errors` 三个文件各自用 `doneRef` 加 `setTimeout`（共 11 处），`helpers.boundedWait` 已被 `x6`、`x7`、`x8` 采用。机械替换、不改判据，本轮未动。

**方法论一致性。** 观测流状态的用例都显式对 `recordReq` 传 `{ data: false }`，符合方案「用例要求」第 4 条。本轮新增一条方法论：交叉读既有用例的时间线可以回答形态问题（见更新记录 1），立条目以前先查现有取证是否已经覆盖该形态，避免为同一 Node 事实重复建用例。

**运行成本。** 常驻集 21.5s（38 用例），X9 组 7.4s（9 用例）。大头仍是 X8 组 10.1s（闲置计时与出站停滞必须等满被测试的计时），其次是 X7 组的 X7-1a。门禁 47 用例 5.5s，与第 2 轮同数。

**覆盖率对账。** 门禁语句 97.72%、分支 86.95%、函数 100%（第 2 轮 96.75%/85.91%/100%）。数字变化来自文件拆分后的重新统计与那处 `if` 结构改写，不是新增断言。未覆盖点按新结构逐处认领：入站构造器的两个空值默认（`src/core/incoming-message.ts:55-56`，真实请求 `url`/`method` 恒有值）、`OutgoingMessage` 构造器与 `from()` 对象形态的默认补全未走侧（`src/core/outgoing-message.ts:50-52`、`96-102`，含 content-type 三元的 `application/octet-stream` 分支，要对象形态配 Buffer 内容才走到）、pipeline 回调的默认出口（`src/core/outgoing-message.ts:161-163`，X2-6、X5-5 证真实响应上无可达形态）。三处都有出处，不需补用例。

## 假说与空洞清单

**假说 10 行**，与第 2 轮同一批：X1-1、X2-1（依赖 llhttp 内部、永不成文）；X2-5、X2-6、X5-5（http 层未文档化的行为例外）；X3-3、X3-5（时刻竞态，文档不承诺）；X4-2、X5-1（条款与实测相背，其中 X5-1 上游正在改、次版本即可能变）；X7-2（交付窗口竞态）。本轮全部复跑通过，定性不变。Node 主版本升级时按上述优先级复核；X5-1 行另按次版本复跑 `-t X5-1`。

**空洞候选**（都不占规则表编号）：

- H1 `server.maxRequestsPerSocket`（默认 0）达上限：置 `Connection: close` 并对后续请求回 503，配套 `dropRequest` 事件。httply 不配置该选项，回收判定只看 `readableEnded`，默认值下无影响。Node 大版本升级时随 X9-4 一起看默认值是否变。
- H2 `server.strictContentLength`（默认 false）：开启后 `content-length` 与实写不符抛 `ERR_HTTP_CONTENT_LENGTH_MISMATCH`。属 P6 误用面的新增报错源，与 X5 组的归因分流同族。若使用方在 server 上启用该选项，再升为常驻行。
- H3 `closeIdleConnections` 与 `closeAllConnections` 的语义差：后者含活动连接、不销毁 upgraded socket。spec teardown 统一用后者（`helpers.closeAll`），属测试设施选择，不触及承诺面。已关闭登记。
- H4 `res` 的 `prefinish` 在断连形态是否派发：httply 不看该事件，X2 组的事件全集不必为其扩面。已关闭登记。
- H5 X3-2 的文档例外（socket 被 internally nulled、非 `net.Socket` 类型）：按豁免登记，upgrade 与自定义 socket 不属 httply 承诺面。
- H6 客户端侧的 method×body 限制：`http.request` 只为 POST / PUT / PATCH 写出请求体，其余 method 的 body 字节被客户端丢弃。属客户端行为，已在 `design-v1.md`「测试要求」成文，服务端不受影响（X1-3）。维持现状。
- H7 「响应已开始写出但尚未 `finish`」形态：本轮由 X5-1a/1b、X4-1 的既有时间线交叉读证关闭，结论与处置见更新记录 1。留此一行是为了让下一轮直接看到该形态的取证位置，不必重新推导。

**需外部协同（投递 `docs/todo-list.md`）**：

- 销账「补验响应写出但未 `finish` 的终止形态」条：本轮已按既有取证关闭，`design-v1.md` 措辞不变。
- 跟踪上游 `stream.pipeline` 同步抛语义修订（#65063、#65127）继续挂账，本轮复核两条 issue 均仍 open，X5-1 行的约束不变。
- `spec/` 有界等待两写法并存，属代码质量条，不动判据，继续挂账。
