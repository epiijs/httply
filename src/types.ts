import type {
  IncomingHttpHeaders, OutgoingHttpHeaders
} from 'http';
import type stream from 'stream';

export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface IIncomingMessage {
  url: string;
  method: HTTPMethod;
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
