import http, {
  IncomingHttpHeaders
} from 'node:http';

import type {
  CodedError,
  HttpMethod,
  IIncomingMessage
} from '../types.js';

function buildCodedError({ code, message }: { code: string; message: string; }): CodedError {
  return Object.assign(new Error(message), { code });
}

function readRawBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // 响应 finish 后 Node 把请求流置为 flowing 并丢弃残余，首读只会读到空 Buffer
    // readableDidRead 变为 true 晚于 readableFlowing，两个条件都要读（spec X2-5、X6-2）
    if (request.readableDidRead || request.readableFlowing === true) {
      reject(buildCodedError({ code: 'HTTPLY_BODY_DROPPED', message: 'request body dropped: read incoming.body before responding' }));
      return;
    }
    const chunks: Buffer[] = [];
    const abort = (): void => reject(buildCodedError({ code: 'HTTPLY_BODY_ABORTED', message: 'request aborted' }));
    // 终止信号之一，兼防无监听器的 error 事件抛出到进程外
    // 不区分原因，一律以 HTTPLY_BODY_ABORTED reject（spec X2-2）
    request.on('error', abort);
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    // 响应 finish 后 req 层不再派发终止事件，被截断的 body 会永久 pending
    // socket close 是唯一通用的终止信号（spec X1-1、X3-3）
    request.socket.once('close', () => {
      if (!request.readableEnded) {
        abort();
      }
    });
  });
}

export class IncomingMessage implements IIncomingMessage {
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers: IncomingHttpHeaders;

  private _raw: http.IncomingMessage;
  private _cachedQuery?: Record<string, string | string[]>;
  private _cachedBody?: Promise<Buffer>;

  constructor(raw: http.IncomingMessage) {
    this._raw = raw;
    this.url = raw.url || '/';
    this.method = (raw.method || 'GET').toUpperCase() as HttpMethod;
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
