import type { EngineerConfig } from '@iracing-engineer/types';
import { logger } from '../logger.js';

// M10 US6 (T034/T035): the ACTIVE voice reference file. Upload switches it in
// memory; startup recovery re-applies it from Redis after a hub restart. Null
// = no uploaded profile → engineer-config's chatterboxVoiceFile (default voice).
let activeVoiceFile: string | null = null;

export function setActiveVoiceFile(filename: string): void {
  activeVoiceFile = filename;
}

/** The reference file every synthesis uses right now (FR-023: after an upload,
 *  ALL playback — including the M4 test clip — naturally uses the new voice). */
export function resolveVoiceFile(config: EngineerConfig): string {
  return activeVoiceFile ?? config.chatterboxVoiceFile;
}

/** Test hook — resets the in-memory override. */
export function _resetActiveVoiceFile(): void {
  activeVoiceFile = null;
}

/**
 * T035: re-apply the uploaded voice profile after a hub restart. Reads
 * `hub:config:voice-profile` and applies the stored filename only if the file
 * still exists on disk AND is non-empty (a failed/interrupted upload leaving a
 * 0-byte file falls back to the config default with a warn).
 */
export async function recoverVoiceProfile(
  redisGet: (key: string) => Promise<string | null>,
  config: EngineerConfig,
  fileSize: (path: string) => Promise<number>, // throws when missing
): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await redisGet('hub:config:voice-profile');
  } catch {
    raw = null;
  }
  if (!raw) return; // no profile uploaded — default voice
  let filename: string | undefined;
  try {
    filename = (JSON.parse(raw) as { filename?: string }).filename;
  } catch {
    filename = undefined;
  }
  if (!filename) return;
  const path = `${config.chatterboxReferenceAudioDir}/${filename}`;
  try {
    const size = await fileSize(path);
    if (size <= 0) throw new Error('empty file');
    setActiveVoiceFile(filename);
    logger.info('[engineer] voice profile recovered from Redis', {
      component: 'engineer',
      event: 'voice-profile-recovered',
      filename,
    });
  } catch {
    logger.warn('[engineer] voice profile file missing or empty — using default voice', {
      component: 'engineer',
      event: 'voice-profile-invalid',
      reason: 'file missing or empty',
      filename,
    });
  }
}

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
      reference_audio_filename: resolveVoiceFile(config),
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
