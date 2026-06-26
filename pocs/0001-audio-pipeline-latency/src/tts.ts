interface TtsRequest {
  text: string;
  voice_mode: 'clone';
  reference_audio_filename: string;
  output_format: 'mp3';
  split_text: boolean;
  chunk_size: number;
  temperature: number;
  exaggeration: number;
  cfg_weight: number;
  speed_factor: number;
  seed: number;
  language: string;
  stream: boolean;
}

export async function streamSpeech(
  text: string,
  chatterboxUrl: string,
  referenceAudio: string,
  onFirstByte: () => void,
): Promise<void> {
  const body: TtsRequest = {
    text,
    voice_mode: 'clone',
    reference_audio_filename: referenceAudio,
    output_format: 'mp3',
    split_text: true,
    chunk_size: 240,
    temperature: 0.85,
    exaggeration: 1.2,
    cfg_weight: 0.55,
    speed_factor: 1,
    seed: 0,
    language: 'en',
    stream: true,
  };

  const res = await fetch(`${chatterboxUrl}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`TTS ${res.status}: ${await res.text()}`);
  }

  if (!res.body) {
    throw new Error('TTS response has no body');
  }

  let sawFirstByte = false;
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0 && !sawFirstByte) {
      sawFirstByte = true;
      onFirstByte();
    }
  }
}
