import type { Redis } from "ioredis";

export class StreamConsumer {
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly stream: string,
    private readonly group: string,
    private readonly consumer: string,
  ) {}

  async start(handler: (message: Record<string, string>) => Promise<void>): Promise<void> {
    // Create consumer group if not exists
    try {
      await this.redis.xgroup("CREATE", this.stream, this.group, "$", "MKSTREAM");
    } catch (err: unknown) {
      const e = err as { message?: string };
      if (!e.message?.includes("BUSYGROUP")) throw err;
    }

    this.running = true;

    while (this.running) {
      const results = await this.redis.xreadgroup(
        "GROUP", this.group, this.consumer,
        "COUNT", "100",
        "BLOCK", "1000",
        "STREAMS", this.stream, ">",
      ) as Array<[string, Array<[string, string[]]>]> | null;

      if (!results) continue;

      for (const [, messages] of results) {
        for (const [id, fields] of messages) {
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            obj[fields[i]] = fields[i + 1];
          }
          await handler(obj);
          await this.redis.xack(this.stream, this.group, id);
        }
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}
