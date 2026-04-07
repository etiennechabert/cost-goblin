export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly context?: Readonly<Record<string, unknown>> | undefined;
}

export type LogHandler = (entry: LogEntry) => void;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private handlers: LogHandler[] = [];
  private minLevel: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  addHandler(handler: LogHandler): void {
    this.handlers.push(handler);
  }

  private log(level: LogLevel, message: string, context?: Readonly<Record<string, unknown>>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.minLevel]) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(context !== undefined ? { context } : {}),
    };

    for (const handler of this.handlers) {
      handler(entry);
    }
  }

  debug(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.log('error', message, context);
  }
}

export const logger = new Logger();
