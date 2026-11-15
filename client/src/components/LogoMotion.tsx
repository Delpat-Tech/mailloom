import React, { useEffect, useId, useRef, useState } from 'react';
import { MARK_VIEWBOX, markTones } from './Logo.js';
import { BOWL, BOWL_END, COUNTER, LOWER, LOWER_START, MARK_CX, MARK_CY, RING_R, RING_W, SLAB } from './markPaths.js';

export type MarkMode = 'still' | 'intro' | 'outro' | 'loader';

// The ring of the D is drawn as two thick circle strokes, each clipped to its piece, so it can sweep round.
// Both circles use pathLength 360, so dash values are degrees. Each sweep starts just before its piece.
const BOWL_FROM = -138;
const LOWER_FROM = LOWER_START - 3;
/** Degrees each sweep must cover to show its whole piece (the keyframes in motion.css use 360 minus these). */
export const BOWL_SWEEP = Math.ceil(BOWL_END - BOWL_FROM) + 3;
export const LOWER_SWEEP = Math.ceil(135 - LOWER_FROM) + 3;

/**
 * The mark in motion (keyframes in motion.css, under "The mark").
 *   intro   the slab rises, the bowl sweeps round, the lower piece follows, the counter settles (1 s)
 *   outro   the same in reverse, shorter (0.45 s)
 *   loader  the ring draws round and clears, on a loop
 *   still   no motion
 * With "reduce motion" on, every mode shows the still mark.
 */
export const LogoMotion: React.FC<{ mode: MarkMode; size?: number; className?: string; tone?: 'rail' | 'page' }> = ({
  mode,
  size = 28,
  className,
  tone = 'page'
}) => {
  const { a, b } = markTones(tone);
  const id = useId().replace(/:/g, '');
  const sweep = (piece: 'bowl' | 'lower') => (
    <g clipPath={`url(#${id}${piece})`}>
      <circle
        className={`mk-${piece}`}
        cx={MARK_CX}
        cy={MARK_CY}
        r={RING_R}
        fill="none"
        stroke={piece === 'bowl' ? b : a}
        strokeWidth={RING_W}
        pathLength={360}
        strokeDasharray="360 360"
        transform={`rotate(${piece === 'bowl' ? BOWL_FROM : LOWER_FROM} ${MARK_CX} ${MARK_CY})`}
      />
    </g>
  );
  return (
    <svg
      className={`mk mk-${mode}${className ? ` ${className}` : ''}`}
      style={{ '--mk-bowl': 360 - BOWL_SWEEP, '--mk-lower': 360 - LOWER_SWEEP } as React.CSSProperties}
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={`${id}bowl`}>
          <path d={BOWL} />
        </clipPath>
        <clipPath id={`${id}lower`}>
          <path d={LOWER} />
        </clipPath>
      </defs>
      <path className="mk-slab" d={SLAB} fill={a} />
      {sweep('bowl')}
      <path className="mk-counter" d={COUNTER} fill={a} />
      {sweep('lower')}
    </svg>
  );
};

/** A small looping mark for waiting states inside a page (the full-page one is BrandCurtain). */
export const MarkLoader: React.FC<{ size?: number; label?: string; className?: string; tone?: 'rail' | 'page' }> = ({
  size = 20,
  label = 'Loading',
  className,
  tone
}) => (
  <span role="status" aria-label={label} className={`inline-flex ${className ?? ''}`}>
    <LogoMotion mode="loader" size={size} tone={tone} />
  </span>
);

export type CurtainKind = 'boot' | 'intro' | 'outro';

const INTRO_MS = 1000;
const OUTRO_MS = 440;
const FADE_MS = 180;
/** A boot faster than this shows no curtain at all. */
const BOOT_GRACE_MS = 150;

/**
 * The full-screen brand moment. It never holds the user up:
 *   boot   while the session check runs: nothing for the first 150 ms, then the intro, then the loader for as
 *          long as the check takes. It goes the moment `ready` is true.
 *   intro  after signing in: plays over the mailbox as it loads and lets clicks through. It goes when `ready`
 *          is true or the intro ends, whichever is first.
 *   outro  after signing out: plays over the sign-in screen and lets clicks through.
 */
export const BrandCurtain: React.FC<{ kind: CurtainKind; ready?: boolean; onGone: () => void }> = ({
  kind,
  ready = false,
  onGone
}) => {
  const started = useRef(Date.now());
  const [looping, setLooping] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const gone = useRef(onGone);
  gone.current = onGone;

  // Boot: once the intro has played, keep the ring turning.
  useEffect(() => {
    if (kind !== 'boot') return;
    const t = setTimeout(() => setLooping(true), BOOT_GRACE_MS + INTRO_MS + 60);
    return () => clearTimeout(t);
  }, [kind]);

  // When to start leaving.
  useEffect(() => {
    if (leaving) return;
    if (kind === 'boot') {
      if (!ready) return;
      if (Date.now() - started.current < BOOT_GRACE_MS) gone.current();
      else setLeaving(true);
      return;
    }
    if (ready) {
      setLeaving(true);
      return;
    }
    const t = setTimeout(() => setLeaving(true), kind === 'intro' ? INTRO_MS : OUTRO_MS);
    return () => clearTimeout(t);
  }, [kind, ready, leaving]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => gone.current(), FADE_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  const blocking = kind === 'boot' && !leaving;
  return (
    <div
      className={`brand-curtain brand-curtain-${kind} fixed inset-0 z-[200] flex items-center justify-center bg-surface text-ink ${
        blocking ? '' : 'pointer-events-none'
      }`}
      data-leaving={leaving ? 'true' : undefined}
      role={kind === 'boot' ? 'status' : undefined}
      aria-hidden={kind === 'boot' ? undefined : true}
    >
      <div className="flex flex-col items-center gap-4">
        <LogoMotion mode={kind === 'outro' ? 'outro' : looping ? 'loader' : 'intro'} size={72} />
        {kind === 'boot' && <span className="brand-curtain-label text-xs font-semibold text-ink-3">Launching Mailloom...</span>}
      </div>
    </div>
  );
};
