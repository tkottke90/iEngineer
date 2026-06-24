export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export class DiscordWebhook {
  constructor(private readonly url: string = process.env.DISCORD_WEBHOOK_URL ?? "") {}

  async send(content: string, embeds?: DiscordEmbed[]): Promise<void> {
    if (!this.url) return;

    const response = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, embeds }),
    });

    if (!response.ok) {
      console.error(`Discord webhook error: ${response.status}`);
    }
  }
}
