// M10 US6 (T034): POST /api/voice-profile core — validation gates, disk +
// Redis writes with partial-failure cleanup (U2), and the upload-time test
// clip. Deps are injected so T038 tests run hermetically (no fs/Redis/TTS).
import type { EngineerConfig } from '@iracing-engineer/types';
import { setActiveVoiceFile } from './tts-client.js';
import { logger } from '../logger.js';

// Canonical MP3 magic byte sequences — see data-model.md "MP3 magic byte
// sequences (shared reference)"; the Tauri client (first gate) checks the
// same list. Update data-model.md first if this set ever changes.
const MP3_MAGIC: ReadonlyArray<readonly number[]> = [
  [0xff, 0xfb],
  [0xff, 0xf3],
  [0xff, 0xf2],
  [0x49, 0x44, 0x33], // ID3-tagged MP3
];

export function isMp3MagicBytes(data: Buffer): boolean {
  return MP3_MAGIC.some((sig) => sig.every((byte, i) => data[i] === byte));
}

export interface VoiceProfileDeps {
  config: EngineerConfig;
  /** MP3 duration in seconds (production binds music-metadata's parseBuffer). */
  parseDurationSecs(data: Buffer): Promise<number>;
  writeFile(path: string, data: Buffer): Promise<void>;
  unlink(path: string): Promise<void>;
  redisSet(key: string, value: string): Promise<void>;
  /** Synthesize the upload-confirmation phrase with the (just-switched) voice. */
  synthesizeTestClip(): Promise<Buffer>;
  storeClip(buffer: Buffer): { clipUrl: string };
  now(): Date;
}

export interface UploadOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** `profile-{ISO8601 with : → -}.mp3` per contracts/hub-voice-profile.md. */
export function profileFilename(now: Date): string {
  return `profile-${now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '')}.mp3`;
}

export async function handleVoiceProfileUpload(
  deps: VoiceProfileDeps,
  mimeType: string,
  data: Buffer,
): Promise<UploadOutcome> {
  const { config } = deps;

  // Gate 1 (MIME) + gate 2 (magic bytes — the hub NEVER trusts the client's
  // format check, FR-022/I5).
  if (mimeType !== 'audio/mpeg' || !isMp3MagicBytes(data)) {
    return {
      status: 422,
      body: { error: 'invalid-format', message: 'File must be an MP3 (audio/mpeg)' },
    };
  }

  // Gate 3 (duration — hub-side only; limits are named config constants).
  const min = config.minVoiceProfileDurationSecs;
  const max = config.maxVoiceProfileDurationSecs;
  let duration: number;
  try {
    duration = await deps.parseDurationSecs(data);
  } catch (err) {
    return {
      status: 422,
      body: { error: 'invalid-format', message: `Could not read MP3 duration: ${String(err)}` },
    };
  }
  if (!Number.isFinite(duration) || duration < min || duration > max) {
    return {
      status: 422,
      body: {
        error: 'duration-out-of-range',
        message: `Audio must be between ${min} and ${max} seconds (got ${duration.toFixed(1)}s)`,
      },
    };
  }

  const uploadedAt = deps.now().toISOString();
  const filename = profileFilename(deps.now());
  const path = `${config.chatterboxReferenceAudioDir}/${filename}`;

  try {
    await deps.writeFile(path, data);
  } catch (err) {
    logger.error('[engineer] voice profile file write failed', {
      component: 'engineer',
      event: 'voice-profile-write-failed',
      error: String(err),
    });
    return { status: 500, body: { error: 'write-failed', message: String(err) } };
  }

  // U2 atomicity: file ok but Redis fails → delete the file, 500, and do NOT
  // switch the in-memory voice. Both writes must succeed before the switch.
  const durationSeconds = Math.round(duration * 10) / 10;
  try {
    await deps.redisSet(
      'hub:config:voice-profile',
      // durationSeconds persisted so get_voice_profile() answers without
      // re-reading the file; testClipUrl is EPHEMERAL — never stored (B4).
      JSON.stringify({ filename, uploadedAt, durationSeconds }),
    );
  } catch (err) {
    await deps.unlink(path).catch(() => {});
    logger.error('[engineer] voice profile Redis sync failed — file rolled back', {
      component: 'engineer',
      event: 'voice-profile-sync-failed',
      error: String(err),
    });
    return {
      status: 500,
      body: {
        error: 'voice-profile-sync-failed',
        message: 'File saved but Redis update failed — retry upload',
      },
    };
  }

  setActiveVoiceFile(filename);
  logger.info('[engineer] voice profile activated', {
    component: 'engineer',
    event: 'voice-profile-activated',
    filename,
    durationSeconds,
  });

  // Upload-time confirmation clip (distinct from the on-demand "Test Voice"
  // button, which reuses the M4 test_audio_playback path — T034/C4).
  let testClipUrl = '';
  try {
    const clip = await deps.synthesizeTestClip();
    testClipUrl = deps.storeClip(clip).clipUrl;
  } catch (err) {
    // The profile IS active — a failed confirmation clip is a warning, not a
    // rollback (the driver can still use Test Voice).
    logger.warn('[engineer] upload confirmation clip synthesis failed', {
      component: 'engineer',
      event: 'voice-profile-test-clip-failed',
      error: String(err),
    });
  }

  return {
    status: 200,
    body: { filename, uploadedAt, durationSeconds, testClipUrl },
  };
}
