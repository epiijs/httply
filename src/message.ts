import http, {
  IncomingHttpHeaders, OutgoingHttpHeaders
} from 'http';
import {
  pipeline, Readable
} from 'stream';

import type {
  AnyForOutgoingMessage,
  HTTPMethod,
  IIncomingMessage,
  IOutgoingMessage,
  OutgoingMessageContent
} from './types.js';

function isReadableStream(o: unknown): o is Readable {
  return o instanceof Readable;
}

function readRawBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('request aborted')));
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

export class IncomingMessage implements IIncomingMessage {
  readonly url: string;
  readonly method: HTTPMethod;
  readonly headers: IncomingHttpHeaders;

  private _raw: http.IncomingMessage;
  private _cachedQuery?: Record<string, string | string[]>;
  private _cachedBody?: Promise<Buffer>;

  constructor(raw: http.IncomingMessage) {
    this._raw = raw;
    this.url = raw.url || '/';
    this.method = (raw.method || 'GET').toUpperCase() as HTTPMethod;
    this.headers = raw.headers;
  }

  get query(): Record<string, string | string[]> {
    if (!this._cachedQuery) {
      const params = new URL(this.url, 'http://localhost').searchParams;
      this._cachedQuery = {};
      for (const key of params.keys()) {
        const values = params.getAll(key);
        this._cachedQuery[key] = values.length > 1 ? values : values[0];
      }
    }
    return this._cachedQuery;
  }

  get body(): Promise<Buffer> {
    if (!this._cachedBody) {
      this._cachedBody = readRawBody(this._raw);
    }
    return this._cachedBody;
  }
}

export class OutgoingMessage implements IOutgoingMessage {
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  readonly content: OutgoingMessageContent;

  constructor(init?: { status?: number; headers?: OutgoingHttpHeaders; content?: OutgoingMessageContent; }) {
    this.status = init?.status ?? 200;
    this.headers = init?.headers ?? {};
    this.content = init?.content ?? '';
  }

  static from(message: AnyForOutgoingMessage): OutgoingMessage {
    if (!message) {
      return new OutgoingMessage({ status: 204, content: '' });
    }
    if (typeof message === 'string') {
      return new OutgoingMessage({
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': Buffer.byteLength(message, 'utf-8').toString()
        },
        content: message
      });
    }
    if (Buffer.isBuffer(message)) {
      return new OutgoingMessage({
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': message.length.toString()
        },
        content: message
      });
    }
    if (isReadableStream(message)) {
      return new OutgoingMessage({
        status: 200,
        headers: {
          'content-type': 'application/octet-stream'
        },
        content: message
      });
    }
    const maybeContent = message.content;
    const maybeContentIsString = typeof maybeContent === 'string' || maybeContent == null;
    return new OutgoingMessage({
      status: message.status ?? 200,
      headers: message.headers ?? {
        'content-type': maybeContentIsString ? 'text/plain; charset=utf-8' : 'application/octet-stream'
      },
      content: maybeContent ?? ''
    });
  }

  async applyToResponse(response: http.ServerResponse): Promise<void> {
    return new Promise((resolve, reject) => {
      response.on('error', reject);
      response.on('finish', resolve);
      response.writeHead(this.status, this.headers);
      if (this.content) {
        if (isReadableStream(this.content)) {
          pipeline(this.content, response, (error: Error | null) => {
            if (error) {
              reject(error);
            }
          });
        } else {
          response.write(this.content);
          response.end();
        }
      } else {
        response.end();
      }
    });
  }
}
