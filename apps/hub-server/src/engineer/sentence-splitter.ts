/**
 * Hardened sentence-boundary splitter for streaming LLM→TTS (FR-010, POC-0003).
 *
 * The naive `[.!?]\s` rule fragmented on decimals ("You are 2." from "2.4
 * seconds") and abbreviations. This splitter treats a `.!?` as a boundary ONLY
 * when it is followed by whitespace AND the next non-space character is
 * upper-case or an opening quote/bracket. That rejects decimals (`2.4` → '.'
 * followed by a digit) and lower-case abbreviations (`No. 45`), while still
 * splitting real sentences. A `.!?` at the very end of the buffer is held as the
 * remainder until more text arrives or the stream is flushed.
 */
export function splitSentences(text: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    const next = text[i + 1];
    if (next === undefined) break; // no lookahead yet — keep as remainder
    if (!/\s/.test(next)) continue; // e.g. "2.4" — '.' followed by a non-space

    // Scan past the whitespace to the following non-space character.
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    const following = text[j];
    if (following === undefined) break; // trailing whitespace only — keep remainder
    if (!/[A-Z"'([]/.test(following)) continue; // lower-case after ". " → abbreviation/decimal

    const sentence = text.slice(start, i + 1).trim();
    if (sentence) sentences.push(sentence);
    start = j;
    i = j - 1;
  }
  return { sentences, remainder: text.slice(start) };
}

/**
 * Streaming wrapper: `push` LLM token chunks, receive any newly-completed
 * sentences; `flush` at stream end to emit the trailing fragment (if any).
 */
export class SentenceStreamSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const { sentences, remainder } = splitSentences(this.buffer);
    this.buffer = remainder;
    return sentences;
  }

  flush(): string | null {
    const trailing = this.buffer.trim();
    this.buffer = '';
    return trailing.length > 0 ? trailing : null;
  }
}
