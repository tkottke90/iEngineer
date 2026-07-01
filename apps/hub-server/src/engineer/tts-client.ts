import type { EngineerConfig } from '@iracing-engineer/types';

/**
 * Generate an MP3 audio clip from alert text via Chatterbox clone mode.
 * Returns the raw MP3 bytes. On any non-200 response, throws — the caller
 * (RacingEngineerService) emits an EngineerFailureLog and drops the alert.
 * See contracts/chatterbox-tts.md.
 */
export async function generateClip(text: string, config: EngineerConfig): Promise<Buffer> {
  const res = await fetch(`${config.chatterboxUrl}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voice_mode: 'clone',
      reference_audio_filename: config.chatterboxVoiceFile,
      output_format: 'mp3',
      stream: false,
      split_text: true,
      chunk_size: 240,
    }),
  });

  if (!res.ok) {
    throw new Error(`Chatterbox returned ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
