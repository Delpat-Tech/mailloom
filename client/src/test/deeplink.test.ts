import { describe, it, expect } from 'vitest';
import { clearMessageLinkHash, messageLinkHash, parseMessageLinkHash } from '../services/deeplink';

describe('message deep link route', () => {
  it('reads an encoded Message-ID', () => {
    expect(parseMessageLinkHash('#/m/' + encodeURIComponent('<abc.123@mail.delpat.in>'))).toBe('<abc.123@mail.delpat.in>');
  });
  it('accepts an id without angle brackets and a trailing slash', () => {
    expect(parseMessageLinkHash('#/m/abc%40delpat.in/')).toBe('<abc@delpat.in>');
  });
  it('keeps characters such as + and = inside the id', () => {
    expect(parseMessageLinkHash('#/m/' + encodeURIComponent('<a+b=c@x.y>'))).toBe('<a+b=c@x.y>');
  });
  it('ignores other hashes, empty ids and bad encoding', () => {
    expect(parseMessageLinkHash('')).toBeNull();
    expect(parseMessageLinkHash('#open=%7B%7D')).toBeNull();
    expect(parseMessageLinkHash('#/m/')).toBeNull();
    expect(parseMessageLinkHash('#/m/%E0%A4%A')).toBeNull();
    expect(parseMessageLinkHash('#/m/a%20b%40c')).toBeNull();
    expect(parseMessageLinkHash('#/x/abc')).toBeNull();
  });
  it('round-trips and clears the hash', () => {
    const h = messageLinkHash('x@y.z');
    expect(parseMessageLinkHash(h)).toBe('<x@y.z>');
    window.location.hash = h;
    clearMessageLinkHash();
    expect(window.location.hash).toBe('');
  });
});
