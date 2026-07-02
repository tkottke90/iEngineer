import { describe, it } from 'mocha';
import { expect } from 'chai';
import { splitSentences, SentenceStreamSplitter } from '../../../src/engineer/sentence-splitter.js';

describe('sentence-splitter — splitSentences (POC-0003 hardening)', () => {
  it('does NOT split on decimals (the POC-0003 regression)', () => {
    const { sentences, remainder } = splitSentences('You are 2.4 seconds behind car 45. Box now.');
    expect(sentences).to.deep.equal(['You are 2.4 seconds behind car 45.']);
    expect(remainder).to.equal('Box now.'); // trailing '.' held until flush
  });

  it('does NOT split on a lower-case abbreviation like "No. 45"', () => {
    const { sentences } = splitSentences('No. 45 is closing. Push now.');
    expect(sentences).to.deep.equal(['No. 45 is closing.']);
  });

  it('splits multiple real sentences', () => {
    const { sentences, remainder } = splitSentences(
      'Box this lap. Fuel is tight. Keep it clean now',
    );
    expect(sentences).to.deep.equal(['Box this lap.', 'Fuel is tight.']);
    expect(remainder).to.equal('Keep it clean now');
  });

  it('holds a boundary at the very end until more text arrives', () => {
    const { sentences, remainder } = splitSentences('Box this lap.');
    expect(sentences).to.deep.equal([]); // no lookahead yet
    expect(remainder).to.equal('Box this lap.');
  });
});

describe('sentence-splitter — SentenceStreamSplitter', () => {
  it('emits sentences across chunk boundaries and flushes the remainder', () => {
    const s = new SentenceStreamSplitter();
    const emitted: string[] = [];
    emitted.push(...s.push('You are 2.'));
    emitted.push(...s.push('4 seconds behind. '));
    emitted.push(...s.push('Box now'));
    expect(emitted).to.deep.equal(['You are 2.4 seconds behind.']);
    expect(s.flush()).to.equal('Box now');
  });

  it('flush returns null when nothing is buffered', () => {
    const s = new SentenceStreamSplitter();
    s.push('All done. ');
    s.push('Nice job.');
    // "Nice job." is held (trailing '.'); flush emits it, then buffer is empty.
    expect(s.flush()).to.equal('Nice job.');
    expect(s.flush()).to.equal(null);
  });
});
