// M10 T038: POST /api/voice-profile validation gates + persistence contract.
import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import type { EngineerConfig } from '@iracing-engineer/types';
import {
  handleVoiceProfileUpload,
  isMp3MagicBytes,
  profileFilename,
  type VoiceProfileDeps,
} from '../../../src/engineer/voice-profile.js';
import {
  resolveVoiceFile,
  _resetActiveVoiceFile,
  recoverVoiceProfile,
} from '../../../src/engineer/tts-client.js';

const CONFIG = {
  chatterboxVoiceFile: 'voice2.wav',
  chatterboxReferenceAudioDir: '/data/chatterbox/reference',
  minVoiceProfileDurationSecs: 3,
  maxVoiceProfileDurationSecs: 60,
} as unknown as EngineerConfig;

// A buffer whose first bytes are a valid MP3 frame sync (FF FB) — passes the
// magic-byte gate; duration comes from the injected parser.
const MP3ISH = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03]);
const ID3ISH = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const WAVISH = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00]); // "RIFF"

interface Recorded {
  written: Array<{ path: string; bytes: number }>;
  unlinked: string[];
  redis: Record<string, string>;
  synthesized: number;
}

function makeDeps(over: Partial<VoiceProfileDeps> = {}): { deps: VoiceProfileDeps; rec: Recorded } {
  const rec: Recorded = { written: [], unlinked: [], redis: {}, synthesized: 0 };
  const deps: VoiceProfileDeps = {
    config: CONFIG,
    parseDurationSecs: async () => 15,
    writeFile: async (path, data) => {
      rec.written.push({ path, bytes: data.length });
    },
    unlink: async (path) => {
      rec.unlinked.push(path);
    },
    redisSet: async (key, value) => {
      rec.redis[key] = value;
    },
    synthesizeTestClip: async () => {
      rec.synthesized += 1;
      return Buffer.from('clip');
    },
    storeClip: () => ({ clipUrl: '/api/audio/test-clip-1' }),
    now: () => new Date('2026-07-08T12:00:00.000Z'),
    ...over,
  };
  return { deps, rec };
}

beforeEach(() => _resetActiveVoiceFile());

describe('voice-profile upload — validation gates (T038)', () => {
  it('non-MP3 MIME → 422 invalid-format', async () => {
    const { deps } = makeDeps();
    const out = await handleVoiceProfileUpload(deps, 'audio/wav', MP3ISH);
    expect(out.status).to.equal(422);
    expect(out.body.error).to.equal('invalid-format');
  });

  it('valid MIME but wrong magic bytes → 422 invalid-format (hub second gate, I5)', async () => {
    const { deps, rec } = makeDeps();
    const out = await handleVoiceProfileUpload(deps, 'audio/mpeg', WAVISH);
    expect(out.status).to.equal(422);
    expect(out.body.error).to.equal('invalid-format');
    expect(rec.written).to.have.length(0, 'nothing written for a rejected file');
  });

  it('duration below the minimum → 422 duration-out-of-range with the config bounds', async () => {
    const { deps } = makeDeps({ parseDurationSecs: async () => 2.2 });
    const out = await handleVoiceProfileUpload(deps, 'audio/mpeg', MP3ISH);
    expect(out.status).to.equal(422);
    expect(out.body.error).to.equal('duration-out-of-range');
    expect(out.body.message).to.equal('Audio must be between 3 and 60 seconds (got 2.2s)');
  });

  it('duration above the maximum → 422 duration-out-of-range', async () => {
    const { deps } = makeDeps({ parseDurationSecs: async () => 75 });
    const out = await handleVoiceProfileUpload(deps, 'audio/mpeg', MP3ISH);
    expect(out.status).to.equal(422);
    expect(out.body.error).to.equal('duration-out-of-range');
  });

  it('isMp3MagicBytes accepts all canonical signatures incl. ID3', () => {
    expect(isMp3MagicBytes(MP3ISH)).to.equal(true);
    expect(isMp3MagicBytes(ID3ISH)).to.equal(true);
    expect(isMp3MagicBytes(Buffer.from([0xff, 0xf3, 0x00]))).to.equal(true);
    expect(isMp3MagicBytes(Buffer.from([0xff, 0xf2, 0x00]))).to.equal(true);
    expect(isMp3MagicBytes(WAVISH)).to.equal(false);
  });
});

describe('voice-profile upload — success path + persistence contract (T038/B4/E3)', () => {
  it('valid upload → 200, file written, Redis has {filename, uploadedAt, durationSeconds} and NO testClipUrl', async () => {
    const { deps, rec } = makeDeps();
    const out = await handleVoiceProfileUpload(deps, 'audio/mpeg', MP3ISH);
    expect(out.status).to.equal(200);
    expect(out.body.filename).to.match(/^profile-2026-07-08T12-00-00\.mp3$/);
    expect(out.body.durationSeconds).to.equal(15);
    expect(out.body.testClipUrl).to.equal('/api/audio/test-clip-1');

    expect(rec.written).to.have.length(1);
    expect(rec.written[0].path).to.equal(
      `/data/chatterbox/reference/${out.body.filename}`,
    );

    // B4: durationSeconds persisted (get_voice_profile contract), testClipUrl
    // ephemeral — NEVER stored.
    const stored = JSON.parse(rec.redis['hub:config:voice-profile']);
    expect(stored.durationSeconds).to.equal(15);
    expect(stored.filename).to.equal(out.body.filename);
    expect(stored).to.not.have.property('testClipUrl');
  });

  it('E3: synthesis after a successful upload uses the NEW voice file (in-memory handoff)', async () => {
    const { deps } = makeDeps();
    expect(resolveVoiceFile(CONFIG)).to.equal('voice2.wav'); // startup default
    const out = await handleVoiceProfileUpload(deps, 'audio/mpeg', MP3ISH);
    expect(resolveVoiceFile(CONFIG)).to.equal(out.body.filename);
  });

  it('U2: file write ok but Redis fails → file unlinked, 500 sync-failed, voice NOT switched', async () => {
    const { deps, rec } = makeDeps({
      redisSet: async () => {
        throw new Error('redis down');
      },
    });
    const out = await handleVoiceProfileUpload(deps, 'audio/mpeg', MP3ISH);
    expect(out.status).to.equal(500);
    expect(out.body.error).to.equal('voice-profile-sync-failed');
    expect(rec.unlinked).to.have.length(1, 'partial file must be rolled back');
    expect(resolveVoiceFile(CONFIG)).to.equal('voice2.wav', 'voice must not switch');
  });

  it('file write failure → 500, no Redis write, voice NOT switched', async () => {
    const { deps, rec } = makeDeps({
      writeFile: async () => {
        throw new Error('disk full');
      },
    });
    const out = await handleVoiceProfileUpload(deps, 'audio/mpeg', MP3ISH);
    expect(out.status).to.equal(500);
    expect(Object.keys(rec.redis)).to.have.length(0);
    expect(resolveVoiceFile(CONFIG)).to.equal('voice2.wav');
  });

  it('profileFilename replaces colons for filesystem safety', () => {
    expect(profileFilename(new Date('2026-07-08T12:34:56.000Z'))).to.equal(
      'profile-2026-07-08T12-34-56.mp3',
    );
  });
});

describe('voice-profile startup recovery (T035)', () => {
  it('applies the stored filename when the file exists and is non-empty', async () => {
    await recoverVoiceProfile(
      async () => JSON.stringify({ filename: 'profile-x.mp3', durationSeconds: 10 }),
      CONFIG,
      async () => 12_345,
    );
    expect(resolveVoiceFile(CONFIG)).to.equal('profile-x.mp3');
  });

  it('falls back to the default voice when the file is missing or empty', async () => {
    await recoverVoiceProfile(
      async () => JSON.stringify({ filename: 'gone.mp3' }),
      CONFIG,
      async () => {
        throw new Error('ENOENT');
      },
    );
    expect(resolveVoiceFile(CONFIG)).to.equal('voice2.wav');

    await recoverVoiceProfile(
      async () => JSON.stringify({ filename: 'empty.mp3' }),
      CONFIG,
      async () => 0,
    );
    expect(resolveVoiceFile(CONFIG)).to.equal('voice2.wav');
  });

  it('absent key or unreachable Redis → default voice, no throw', async () => {
    await recoverVoiceProfile(async () => null, CONFIG, async () => 1);
    expect(resolveVoiceFile(CONFIG)).to.equal('voice2.wav');
    await recoverVoiceProfile(
      async () => {
        throw new Error('redis down');
      },
      CONFIG,
      async () => 1,
    );
    expect(resolveVoiceFile(CONFIG)).to.equal('voice2.wav');
  });
});
