import React from 'react';
import { DBAND, MARK_H, MARK_W, PBOWL, SLAB } from './markPaths.js';

const SIDE = Math.max(MARK_W, MARK_H);
/** A square box around the mark. */
export const MARK_VIEWBOX = `${(MARK_W - SIDE) / 2} ${(MARK_H - SIDE) / 2} ${SIDE} ${SIDE}`;

/** The two fills of the mark: `a` for the P, `b` for the D. On the rail it uses --rm-a/--rm-b, on a plain page --mk-a/--mk-b (set per theme in index.css). */
export function markTones(tone: 'rail' | 'page'): { a: string; b: string } {
  return tone === 'rail' ? { a: 'var(--rm-a)', b: 'var(--rm-b)' } : { a: 'var(--mk-a)', b: 'var(--mk-b)' };
}

/**
 * The Mailloom mark: a P inside a D, for Delpat. Its geometry comes from scripts/make-icons.py (markPaths.ts),
 * the same source as the app icons. For the moving version see LogoMotion.
 */
export const Logo: React.FC<{ size?: number; className?: string; tone?: 'rail' | 'page' }> = ({
  size = 28,
  className,
  tone = 'rail'
}) => {
  const { a, b } = markTones(tone);
  return (
    <svg className={className} width={size} height={size} viewBox={MARK_VIEWBOX} aria-hidden="true" focusable="false">
      <path d={DBAND} fill={b} />
      <path d={SLAB} fill={a} />
      <path d={PBOWL} fill={a} />
    </svg>
  );
};
