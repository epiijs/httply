# @epiijs/httply

[中文](README.md)

A toolkit for handling HTTP requests and responses.

It structures a Node.js request/response pair into typed messages for the handler
that consumes them.

## Install

```bash
npm i --save @epiijs/httply
```

## Usage

```js
import http from 'node:http';
import { IncomingMessage, OutgoingMessage } from '@epiijs/httply';

http.createServer(async (request, response) => {
  // build a structured incoming message from the raw request
  const incoming = new IncomingMessage(request);

  // read the body (lazy, cached, available for any method)
  // read it before responding: once the response has finished, Node drops the rest of the body
  const body = await incoming.body;

  // build a structured outgoing message from various content types
  const outgoing = OutgoingMessage.from('Hello, world!');
  // or: OutgoingMessage.from(Buffer.from('...'))
  // or: new OutgoingMessage({ status: 201, headers: {...}, content: '...' })

  // send the response
  const { completed } = await outgoing.applyToResponse(response);
  // completed: false means the response was not fully handed to the OS (typically the
  // client disconnected early); it is not an error
}).listen(8080);
```

### IncomingMessage

`new IncomingMessage(req)` wraps a Node.js `IncomingMessage` into:

| Field     | Type                        | Description              |
|-----------|-----------------------------|--------------------------|
| url       | string                      | request URL              |
| method    | HttpMethod                  | GET, POST, PUT, etc.     |
| headers   | IncomingHttpHeaders         | raw request headers      |
| query     | Record\<string, string \| string[]\> | lazily parsed query params |
| body      | Promise\<Buffer\>           | lazy body reader (cached) |

`incoming.body` rejects instead of returning partial or empty data. The `code` on the
rejected error is one of:

- `HTTPLY_BODY_ABORTED`: the request stream was truncated — the client disconnected
  mid-body, the request failed to parse, or the server called `req.destroy()`.
- `HTTPLY_BODY_DROPPED`: the body was first read after the response had `finish`ed, and
  Node had already dropped the rest of it.

`HTTPLY_BODY_DROPPED` fires at the read itself, `HTTPLY_BODY_ABORTED` fires when the
stream terminates.

```js
try {
  const body = await incoming.body;
} catch (error) {
  if (error.code === 'HTTPLY_BODY_DROPPED') {
    // ordering bug: read the body before writing the response
  }
}
```

`IncomingMessage.body` is a whole-body `Promise<Buffer>`; streaming reads are not
offered. So httply suits consuming the request body where it arrives, not proxying or
forwarding: a forwarder has to await the body before it can pass it on, which costs
performance.

httply does not time out a body read. If you need one, implement it yourself or use the
Node API.

### OutgoingMessage

`OutgoingMessage.from(message)` accepts any of:

- `string`: responds with `text/plain`
- `Buffer` / `Readable`: responds with `application/octet-stream`
- `{ status?, headers?, content? }`: explicit control
- `null` / `undefined`: responds with 204 No Content

Use `new OutgoingMessage({ status?, headers?, content? })` for structured construction.

`message.applyToResponse(response)` writes the message to a `ServerResponse` and
resolves `{ completed: boolean }` when this write attempt is over:

- `completed: true`: the response was handed to the OS (the `finish` event fired). It
  does not mean the client received it.
- `completed: false`: the write ended before `finish`, typically because the connection
  was already gone. This is not an error; the promise still resolves.
- The promise rejects only when the content stream itself fails.

After `finish`, httply reclaims a connection whose request body was never fully read, so
a branch that answers without reading the body needs no `Connection: close` of its own.
