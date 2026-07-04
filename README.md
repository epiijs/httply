# @epiijs/httply

A toolkit for handling HTTP requests and responses.

## Install

```bash
npm i @epiijs/httply --save
```

## Usage

```js
import http from 'http';
import { IncomingMessage, OutgoingMessage } from '@epiijs/httply';

http.createServer(async (request, response) => {
  // build a structured incoming message from raw request
  const incoming = new IncomingMessage(request);

  // read body (lazy, cached, available for any method)
  const body = await incoming.body;

  // build a structured outgoing message from various types
  const outgoing = OutgoingMessage.from('Hello, world!');
  // or: OutgoingMessage.from(Buffer.from('...'))
  // or: new OutgoingMessage({ status: 201, headers: {...}, content: '...' })

  // send outgoing message to response
  await outgoing.applyToResponse(response);
}).listen(8080);
```

### IncomingMessage

`new IncomingMessage(req)` wraps a Node.js `IncomingMessage` into:

| Field     | Type                        | Description              |
|-----------|-----------------------------|--------------------------|
| url       | string                      | request URL              |
| method    | HTTPMethod                  | GET, POST, PUT, etc.     |
| headers   | IncomingHttpHeaders         | request headers          |
| query     | Record\<string, string \| string[]\> | lazily parsed query params |
| body      | Promise\<Buffer\>           | lazy body reader (cached) |

### OutgoingMessage

`OutgoingMessage.from(message)` accepts any of:

- `string` — responds with `text/plain`
- `Buffer` / `Readable` — responds with `application/octet-stream`
- `{ status?, headers?, content? }` — explicit control
- `null` / `undefined` — responds with 204 No Content

`new OutgoingMessage({ status?, headers?, content? })` for structured construction.

`message.applyToResponse(response)` writes the message to a `ServerResponse`.
