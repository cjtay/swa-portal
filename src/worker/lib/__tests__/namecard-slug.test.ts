import { describe, it, expect } from 'vitest';
import { deriveSlug, validateSlug, suggestAlternatives } from '../namecard-slug';

describe('deriveSlug', () => {
  it('kebabs a normal Western name', () => {
    expect(deriveSlug('Sarah Chen')).toBe('sarah-chen');
  });

  it('kebabs a three-word Chinese name', () => {
    expect(deriveSlug('Lee Li Hua')).toBe('lee-li-hua');
  });

  it('lowercases', () => {
    expect(deriveSlug('SARAH CHEN')).toBe('sarah-chen');
  });

  it('folds accented characters toward ASCII', () => {
    expect(deriveSlug('Mária Núñez')).toBe('maria-nunez');
  });

  it('collapses runs of whitespace and hyphens into a single hyphen', () => {
    expect(deriveSlug('Sarah   -   Chen')).toBe('sarah-chen');
  });

  it('trims leading and trailing hyphens', () => {
    expect(deriveSlug("  -- Sarah Chen --  ")).toBe('sarah-chen');
  });

  it('drops non-ASCII-alphanumeric characters but keeps inter-word spaces', () => {
    expect(deriveSlug('Aishwarya R.')).toBe('aishwarya-r');
    expect(deriveSlug("O'Brien")).toBe('o-brien');
  });

  it('returns null for names with no ASCII alphanumerics', () => {
    expect(deriveSlug('李小龙')).toBeNull();
    expect(deriveSlug('   ')).toBeNull();
    expect(deriveSlug('!@#$%')).toBeNull();
    expect(deriveSlug('')).toBeNull();
  });

  it('truncates at the last word boundary within the length cap', () => {
    const long = 'This Is A Very Long Name That Definitely Exceeds The Maximum Allowed Slug Length Limit';
    const derived = deriveSlug(long);
    expect(derived).not.toBeNull();
    expect(derived!.length).toBeLessThanOrEqual(64);
    expect(derived!).not.toMatch(/-$/);
  });
});

describe('validateSlug', () => {
  it('accepts well-formed slugs', () => {
    expect(validateSlug('sarah-chen')).toBe(true);
    expect(validateSlug('lee-li-hua')).toBe(true);
    expect(validateSlug('a')).toBe(true);
    expect(validateSlug('member-2')).toBe(true);
  });

  it('rejects malformed slugs', () => {
    expect(validateSlug('')).toBe(false);
    expect(validateSlug('Sarah Chen')).toBe(false); // uppercase + space
    expect(validateSlug('-leading')).toBe(false);
    expect(validateSlug('trailing-')).toBe(false);
    expect(validateSlug('double--hyphen')).toBe(false);
    expect(validateSlug('has.dot')).toBe(false);
    expect(validateSlug('has_underscore')).toBe(false);
  });

  it('rejects slugs over 64 chars', () => {
    expect(validateSlug('a'.repeat(64))).toBe(true);
    expect(validateSlug('a'.repeat(65))).toBe(false);
  });
});

describe('suggestAlternatives', () => {
  it('returns the desired slug unchanged when free', () => {
    expect(suggestAlternatives('sarah-chen', new Set())).toBe('sarah-chen');
    expect(suggestAlternatives('sarah-chen', new Set(['other-slug']))).toBe('sarah-chen');
  });

  it('appends -2 when the desired slug is taken', () => {
    expect(suggestAlternatives('sarah-chen', new Set(['sarah-chen']))).toBe('sarah-chen-2');
  });

  it('skips existing -N variants', () => {
    const taken = new Set(['sarah-chen', 'sarah-chen-2', 'sarah-chen-3']);
    expect(suggestAlternatives('sarah-chen', taken)).toBe('sarah-chen-4');
  });

  it('continues from the existing suffix when the desired slug already ends in -N', () => {
    const taken = new Set(['sarah-chen-2', 'sarah-chen-3']);
    expect(suggestAlternatives('sarah-chen-2', taken)).toBe('sarah-chen-4');
  });
});
