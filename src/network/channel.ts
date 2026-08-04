import type { z } from 'zod';

export interface JsonChannel {
  write(value: unknown, signal?: AbortSignal): Promise<void>;
  read<Schema extends z.ZodType>(
    schema: Schema,
    signal?: AbortSignal,
  ): Promise<z.output<Schema>>;
  close(): Promise<void>;
  abort(error: Error): void;
}
