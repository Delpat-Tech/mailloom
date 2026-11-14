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

import { recipientSnapshot, isValidRecipient } from '../services/recipients';

describe('unsaved-changes snapshot and chip validity', () => {
  it('treats half-typed text without an @ as a change', () => {
    const saved = JSON.stringify(recipientSnapshot(['a@x.com'], ''));
    expect(JSON.stringify(recipientSnapshot(['a@x.com'], 'jo'))).not.toBe(saved);
    expect(recipientSnapshot(['a@x.com', 'bob'], '')).toContain('bob');
  });
  it('flags entries that are not one valid address', () => {
    expect(isValidRecipient('a@x.com')).toBe(true);
    expect(isValidRecipient('Ann <ann@x.com>')).toBe(true);
    expect(isValidRecipient('bob')).toBe(false);
  });
});
