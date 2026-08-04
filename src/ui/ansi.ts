const RESET = '\u001B[0m';

function wrap(open: string, value: string): string {
  return `${open}${value}${RESET}`;
}

export const ansi = {
  bold: (value: string): string => wrap('\u001B[1m', value),
  cyan: (value: string): string => wrap('\u001B[38;5;81m', value),
  dim: (value: string): string => wrap('\u001B[2m', value),
  green: (value: string): string => wrap('\u001B[38;5;114m', value),
  red: (value: string): string => wrap('\u001B[38;5;203m', value),
  yellow: (value: string): string => wrap('\u001B[38;5;221m', value),
} as const;
