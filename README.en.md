# @epiijs/httply

[中文](README.md)

A toolkit for handling server-side HTTP requests and responses.

It shapes a Node request/response pair into structured messages, providing a
simpler and easier-to-use API.

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

  // read the request body (lazy, cached, available for any method)
  const body = await incoming.body;

  // build a structured outgoing message from any content type
  const outgoing = OutgoingMessage.from('Hello, world!');
  // or: OutgoingMessage.from(Buffer.from('...'))
  // or: new OutgoingMessage({ status: 201, headers: {...}, content: '...' })

  // write the response
  const { completed } = await outgoing.applyToResponse(response);
  // completed tells whether the response was fully handed to the OS kernel
  // completed = false means it was not (typically because the client disconnected
  // early); this is not an error
}).listen(8080);
```

### IncomingMessage

`new IncomingMessage(req)` wraps a Node `IncomingMessage` into:

| Field     | Type                        | Description              |
|-----------|-----------------------------|--------------------------|
| url       | string                      | request URL              |
| method    | HttpMethod                  | GET, POST, PUT, etc.     |
| headers   | IncomingHttpHeaders         | raw request headers      |
| query     | Record\<string, string \| string[]\> | lazily parsed query params |
| body      | Promise\<Buffer\>           | lazy body reader (cached) |

`incoming.body` rejects when the complete data cannot be read; it never returns truncated
or empty data. The `code` on the rejected error is one of:

- `HTTPLY_BODY_ABORTED`: the request stream was truncated — the client disconnected
  mid-body, the request failed to parse, or the server called `req.destroy()`.
- `HTTPLY_BODY_DROPPED`: the body was first read after the response had `finish`ed (a
  common usage mistake), and Node had already dropped the rest of it.

`IncomingMessage.body` is a whole-body `Promise<Buffer>`. It does not expose streaming
reads and does not provide timeout control for reading the request body. httply
therefore suits consuming the request body right after it is received; it does not suit
proxying or forwarding, and does not suit reading very large request bodies.

If you need finer-grained control over a request, use the Node API directly.

### OutgoingMessage

`OutgoingMessage.from(message)` accepts any of:

- `string`: responds with `text/plain`
- `Buffer` / `Readable`: responds with `application/octet-stream`
- `{ status?, headers?, content? }`: specify each item individually
- `null` / `undefined`: responds with 204 No Content

Use `new OutgoingMessage({ status?, headers?, content? })` for structured construction.

`message.applyToResponse(response)` writes the message to a `ServerResponse` and resolves
`{ completed: boolean }` when the write operation terminates:

- `completed: true`: the response has been committed to the OS kernel (the `finish`
  event fired). It does not mean the client received it.
- `completed: false`: the write ended before `finish`, typically because the connection
  was already gone. This is not an error; the Promise still resolves.
- The Promise rejects only when the content stream being written itself fails.

After `finish` is triggered, if the paired inbound request's body has not been fully
read, httply reclaims its connection, so a branch that answers without reading the body
needs no `Connection: close` of its own.
