import React from 'react';
import { BOWL, COUNTER, LOWER, MARK_H, MARK_W, SLAB } from './markPaths.js';

/** A square box around the mark (it is a little wider than tall). */
export const MARK_VIEWBOX = `0 ${(MARK_H - MARK_W) / 2} ${MARK_W} ${MARK_W}`;

/** The two fills of the mark. On the rail it uses --rm-a/--rm-b, on a plain page --mk-a/--mk-b (set per theme in index.css). */
export function markTones(tone: 'rail' | 'page'): { a: string; b: string } {
  return tone === 'rail' ? { a: 'var(--rm-a)', b: 'var(--rm-b)' } : { a: 'var(--mk-a)', b: 'var(--mk-b)' };
}

/**
 * The Mailloom mark: the Delpat 'D'. Its geometry comes from scripts/make-icons.py (markPaths.ts), the same
 * source as the app icons. For the moving version see LogoMotion.
 */
export const Logo: React.FC<{ size?: number; className?: string; tone?: 'rail' | 'page' }> = ({
  size = 28,
  className,
  tone = 'rail'
}) => {
  const { a, b } = markTones(tone);
  return (
    <svg className={className} width={size} height={size} viewBox={MARK_VIEWBOX} aria-hidden="true" focusable="false">
      <path d={SLAB} fill={a} />
      <path d={BOWL} fill={b} />
      <path d={COUNTER} fill={a} />
      <path d={LOWER} fill={a} />
    </svg>
  );
};
