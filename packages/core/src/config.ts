import { z } from 'zod'

/** Bus configuration with the defaults from PRODUCT_DESIGN §5.7 (`agentbus.yaml`). */
export const BusConfig = z.object({
  bind: z.string().default('127.0.0.1'),
  port: z.number().int().default(7777),
  /** Host name/IP other machines use to reach this bus (A2A cards, blob URLs). */
  public_host: z.string().optional(),
  data_dir: z.string().default('~/.agentbus'),
  guard: z
    .object({
      cap: z.number().int().positive().default(20),
      min_interval_ms: z.number().int().nonnegative().default(2000),
    })
    .default({}),
  mailbox: z
    .object({
      ttl_hours: z.number().positive().default(24),
      max_per_agent: z.number().int().positive().default(1000),
    })
    .default({}),
  push: z.object({ seen_timeout_s: z.number().positive().default(10) }).default({}),
  blobs: z
    .object({
      max_bytes: z
        .number()
        .int()
        .positive()
        .default(100 * 1024 * 1024),
      quota_bytes: z
        .number()
        .int()
        .positive()
        .default(10 * 1024 * 1024 * 1024),
    })
    .default({}),
  message: z.object({ max_text_bytes: z.number().int().positive().default(65536) }).default({}),
  tasks: z
    .object({
      /** Default deadline for a new task, seconds. */
      deadline_s: z.number().positive().default(3600),
      /** Default bot-message budget per task thread. */
      max_turns: z.number().int().positive().default(30),
    })
    .default({}),
  /** Connections silent for longer than this are considered dead (ms). */
  heartbeat_timeout_ms: z.number().int().positive().default(30_000),
  /** Tail of room history rendered into driver prompts / inbox context. */
  history_tail: z.number().int().nonnegative().default(20),
})
export type BusConfig = z.infer<typeof BusConfig>

export function loadConfig(raw: unknown = {}): BusConfig {
  return BusConfig.parse(raw ?? {})
}
