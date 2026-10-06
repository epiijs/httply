import type {
  IncomingHttpHeaders, OutgoingHttpHeaders
} from 'node:http';
import type stream from 'node:stream';

/** 常用的带有 code 的 Error 扩展类型 */
export type CodedError = Error & { code?: string; };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** @deprecated 改用 `HttpMethod` */
// eslint-disable-next-line @typescript-eslint/naming-convention
export type HTTPMethod = HttpMethod;

export interface IIncomingMessage {
  url: string;
  method: HttpMethod;
  headers: IncomingHttpHeaders;
  query: Record<string, string | string[]>;
  body: Promise<Buffer>;
}

export type OutgoingMessageContent = string | Buffer | stream.Readable | null | undefined;

export interface IOutgoingMessage {
  status: number;
  headers: OutgoingHttpHeaders;
  content: OutgoingMessageContent;
}

export type AnyForOutgoingMessage = Partial<IOutgoingMessage> | OutgoingMessageContent | void;
