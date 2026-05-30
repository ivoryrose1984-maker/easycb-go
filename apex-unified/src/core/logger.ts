import CONFIG from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const configured: number = LEVELS[(CONFIG.LOG_LEVEL as Level) ?? 'info'] ?? 1;

function log(level: Level, prefix: string, msg: string): void {
  if (LEVELS[level] < configured) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}][${prefix}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (prefix: string, msg: string) => log('debug', prefix, msg),
  info:  (prefix: string, msg: string) => log('info',  prefix, msg),
  warn:  (prefix: string, msg: string) => log('warn',  prefix, msg),
  error: (prefix: string, msg: string) => log('error', prefix, msg),
};
