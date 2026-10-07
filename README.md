# @epiijs/httply

[English](https://github.com/epiijs/httply/blob/main/README.en.md)

处理服务端 HTTP 请求与响应的工具包。

它把 Node 的一对收发对象整形成结构化消息，提供更简单易用的 API 。

## 安装

```bash
npm i --save @epiijs/httply
```

## 用法

```js
import http from 'node:http';
import { IncomingMessage, OutgoingMessage } from '@epiijs/httply';

http.createServer(async (request, response) => {
  // 从原始请求构造结构化入站消息
  const incoming = new IncomingMessage(request);

  // 读取请求体（惰性、缓存、任意 method 都可读）
  const body = await incoming.body;

  // 从任意内容类型构造结构化出站消息
  const outgoing = OutgoingMessage.from('Hello, world!');
  // 或：OutgoingMessage.from(Buffer.from('...'))
  // 或：new OutgoingMessage({ status: 201, headers: {...}, content: '...' })

  // 写入响应
  const { completed } = await outgoing.applyToResponse(response);
  // completed 是是否完整提交内核的标志
  // completed = false 表示响应尚未完整提交内核（通常是因为客户端提前断开），这不是错误
}).listen(8080);
```

### IncomingMessage

`new IncomingMessage(req)` 把 Node 的 `IncomingMessage` 包装成：

| 字段 | 类型 | 说明 |
|-----------|-----------------------------|--------------------------|
| url       | string                      | 请求 URL |
| method    | HttpMethod                  | GET、POST、PUT 等 |
| headers   | IncomingHttpHeaders         | 原始请求头 |
| query     | Record\<string, string \| string[]\> | 惰性解析的查询参数 |
| body      | Promise\<Buffer\>           | 惰性读取的请求体（缓存） |

`incoming.body` 读不到完整数据会 reject，不返回截断数据或空数据。reject 的错误的 `code` 有这些情况：

- `HTTPLY_BODY_ABORTED`：请求流被截断。客户端发到一半断开、请求帧解析失败，或服务端调用了 `req.destroy()`。
- `HTTPLY_BODY_DROPPED`：首次读取发生在响应 `finish` 之后（这是一种常见的使用错误），此时 Node 已丢弃残余请求体。

`IncomingMessage.body` 是全量 `Promise<Buffer>`，不暴露流式读取，不提供读取请求体的超时控制。
因此，httply 更适合收到请求体后立刻消费，不适合代理转发，也不适合读取超大请求体。

如果需要更细致地请求控制，应直接使用 Node API 。

### OutgoingMessage

`OutgoingMessage.from(message)` 接受以下任一种输入：

- `string`：按 `text/plain` 响应
- `Buffer` / `Readable`：按 `application/octet-stream` 响应
- `{ status?, headers?, content? }`：逐项指定
- `null` / `undefined`：按 204 No Content 响应

结构化构造用 `new OutgoingMessage({ status?, headers?, content? })`。

`message.applyToResponse(response)` 把消息写入 `ServerResponse`，本次写入操作终止时 resolve `{ completed: boolean }`：

- `completed: true`：响应已提交内核（`finish` 已触发），不代表客户端已收到。
- `completed: false`：写入在 `finish` 之前终止，通常是连接已经断了。这不是错误，Promise 照样 resolve。
- 仅当写入的内容流自身出错才 reject。

触发 `finish` 之后，如果成对的入站请求的请求体还未读完，其连接会由 httply 回收，不读 body 的分支不需要自己 `Connection: close`。
