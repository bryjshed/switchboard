/** Minimal logger interface, structurally compatible with OpenFeature's `Logger` and with console. */
export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

const noop = (): void => {};

/** Discards everything. */
export const silentLogger: Logger = { error: noop, warn: noop, info: noop, debug: noop };

/**
 * Default logger: warnings and errors go to the console, info and debug are dropped.
 *
 * A flag SDK is on the critical path of everything that reads it, so it stays quiet unless
 * something is actually wrong. Pass your own `logger` to route this into your log pipeline.
 */
export function defaultLogger(prefix = '[switchboard]'): Logger {
  /* eslint-disable no-console */
  return {
    error: (...args) => console.error(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    info: noop,
    debug: noop,
  };
  /* eslint-enable no-console */
}

/** Wraps a logger so a throwing logger can never break the SDK. */
export function safeLogger(logger: Logger): Logger {
  const guard =
    (level: keyof Logger) =>
    (...args: unknown[]): void => {
      try {
        logger[level](...args);
      } catch {
        // A logger that throws must not take the host application down with it.
      }
    };
  return { error: guard('error'), warn: guard('warn'), info: guard('info'), debug: guard('debug') };
}
