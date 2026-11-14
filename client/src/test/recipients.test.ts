import { describe, it, expect } from 'vitest';
import { splitRecipients, mergeRecipients } from '../services/recipients';

describe('splitRecipients', () => {
  it('splits on commas and semicolons', () => {
    expect(splitRecipients('a@x.com, b@x.com; c@x.com,')).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });
  it('keeps quoted names and angle addresses whole', () => {
    expect(splitRecipients('"Doe, Jo" <jo@x.com>, Ann <ann@x.com>')).toEqual(['"Doe, Jo" <jo@x.com>', 'Ann <ann@x.com>']);
  });
  it('merges without duplicates', () => {
    expect(mergeRecipients(['a@x.com'], 'a@x.com; b@x.com')).toEqual(['a@x.com', 'b@x.com']);
  });
});
