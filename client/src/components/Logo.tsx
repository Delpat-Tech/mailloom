import React, { useId } from 'react';
import { BOWL, COUNTER, GRADS, LOWER, MARK_H, MARK_W, SLAB } from './markPaths.js';

const SIDE = Math.max(MARK_W, MARK_H);
/** A square box around the mark. */
export const MARK_VIEWBOX = `${(MARK_W - SIDE) / 2} ${(MARK_H - SIDE) / 2} ${SIDE} ${SIDE}`;

/**
 * How the mark is coloured.
 *   theme  "Dusk": each piece carries a quiet gradient. The stops are --mk-* in index.css: navy and blue on
 *          light surfaces, near-white pieces with a blue bowl on dark ones.
 *   white  "Aurora", as on the app icon: white pieces and a frosted bowl, for the navy brand curtain.
 */
export type MarkTone = 'theme' | 'white';
export type MarkPiece = keyof typeof GRADS;

const STOPS: Record<MarkPiece, [number, string][]> = {
  slab: [[0, 's1'], [1, 's2']],
  counter: [[0, 'c1'], [1, 'c2']],
  lower: [[0, 'l1'], [1, 'l2']],
  bowl: [[0, 'b1'], [0.55, 'b2'], [1, 'b3']]
};
/** Opacity of the bowl in the white tone (the same frost as the app icon). */
export const FROST = 0.58;

/** The Dusk gradients. `id` must be unique per mark on the page (useId), or several marks would share one set. */
export const MarkGradients: React.FC<{ id: string }> = ({ id }) => (
  <>
    {(Object.keys(GRADS) as MarkPiece[]).map((piece) => (
      <linearGradient key={piece} id={`${id}${piece}`} gradientUnits="userSpaceOnUse" {...GRADS[piece]}>
        {STOPS[piece].map(([offset, name]) => (
          <stop key={name} offset={offset} style={{ stopColor: `var(--mk-${name})` }} />
        ))}
      </linearGradient>
    ))}
  </>
);

/** Fill attributes for one piece. */
export function markFill(id: string, tone: MarkTone, piece: MarkPiece): { fill: string; fillOpacity?: number } {
  if (tone === 'white') return piece === 'bowl' ? { fill: '#FFFFFF', fillOpacity: FROST } : { fill: '#FFFFFF' };
  return { fill: `url(#${id}${piece})` };
}

/** An id that is safe inside url(#...). */
export function useMarkId(): string {
  return `mk${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
}

/**
 * The Mailloom mark: the Delpat logo. Its geometry comes from scripts/make-icons.py (markPaths.ts), the same
 * source as the app icons. For the moving version see LogoMotion.
 */
export const Logo: React.FC<{ size?: number; className?: string; tone?: MarkTone }> = ({
  size = 28,
  className,
  tone = 'theme'
}) => {
  const id = useMarkId();
  return (
    <svg className={className} width={size} height={size} viewBox={MARK_VIEWBOX} aria-hidden="true" focusable="false">
      {tone === 'theme' && (
        <defs>
          <MarkGradients id={id} />
        </defs>
      )}
      <path d={BOWL} {...markFill(id, tone, 'bowl')} />
      <path d={SLAB} {...markFill(id, tone, 'slab')} />
      <path d={COUNTER} {...markFill(id, tone, 'counter')} />
      <path d={LOWER} {...markFill(id, tone, 'lower')} />
    </svg>
  );
};
