import { readFileSync } from 'node:fs';

interface TranscriptionResponse {
  text: string;
}

export async function transcribe(wavPath: string, sttUrl: string, model: string): Promise<string> {
  const audioBytes = readFileSync(wavPath);
  const blob = new Blob([audioBytes], { type: 'audio/wav' });

  const form = new FormData();
  form.append('file', blob, 'query.wav');
  form.append('model', model);

  const res = await fetch(`${sttUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    throw new Error(`STT ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as TranscriptionResponse;
  return data.text.trim();
}
