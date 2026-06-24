import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, unlink, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export class ChatterboxClient {
  constructor(private readonly baseUrl: string = process.env.CHATTERBOX_URL ?? "http://chatterbox:8001") {}

  async synthesize(text: string, voiceId?: string): Promise<Buffer> {
    const body: Record<string, string> = { text };
    if (voiceId) body.voice_id = voiceId;

    const response = await fetch(`${this.baseUrl}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Chatterbox error: ${response.status} ${response.statusText}`);
    }

    const wavBuffer = Buffer.from(await response.arrayBuffer());
    return this.convertToMp3(wavBuffer);
  }

  private async convertToMp3(wavBuffer: Buffer): Promise<Buffer> {
    const id = crypto.randomUUID();
    const wavPath = join(tmpdir(), `tts-${id}.wav`);
    const mp3Path = join(tmpdir(), `tts-${id}.mp3`);

    await writeFile(wavPath, wavBuffer);
    await execFileAsync("ffmpeg", ["-i", wavPath, "-q:a", "2", mp3Path]);
    const mp3 = await readFile(mp3Path);

    await Promise.all([unlink(wavPath), unlink(mp3Path)]);
    return mp3;
  }
}
