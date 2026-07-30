import { LoggerService } from '@nestjs/common';

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return typeof obj === 'string' ? obj : Object.prototype.toString.call(obj);
  }
}

function toMetaString(p: unknown): string {
  if (typeof p === 'string') return p;
  if (p !== null && typeof p === 'object') return safeStringify(p);
  return safeStringify(p);
}

function isoNow(): string {
  return new Date().toISOString();
}

function toLevel(severity: string): 'info' | 'warn' | 'error' | 'debug' {
  switch (severity) {
    case 'log':
    case 'verbose':
      return 'debug';
    case 'warn':
      return 'warn';
    case 'error':
    case 'fatal':
      return 'error';
    default:
      return 'info';
  }
}

export class JsonLogger implements LoggerService {
  private context?: string;

  constructor(context?: string) {
    this.context = context;
  }

  setContext(context: string): void {
    this.context = context;
  }

  private emit(
    severity: string,
    message: unknown,
    ...optionalParams: unknown[]
  ): void {
    const entry: Record<string, unknown> = {
      timestamp: isoNow(),
      level: toLevel(severity),
      context: this.context || 'app',
      message: typeof message === 'string' ? message : safeStringify(message),
    };
    if (optionalParams.length > 0) {
      if (
        optionalParams.length === 1 &&
        typeof optionalParams[0] === 'object' &&
        optionalParams[0] !== null
      ) {
        entry.meta = optionalParams[0];
      } else if (optionalParams.length === 1) {
        entry.meta = String(optionalParams[0]);
      } else {
        entry.meta = optionalParams.map((p) => toMetaString(p));
      }
    }
    process.stdout.write(`${safeStringify(entry)}\n`);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('log', message, ...optionalParams);
  }
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, ...optionalParams);
  }
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('warn', message, ...optionalParams);
  }
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', message, ...optionalParams);
  }
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('verbose', message, ...optionalParams);
  }
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('fatal', message, ...optionalParams);
  }
}
