import React, { useEffect, useId, useRef, useState } from 'react';
import { MARK_VIEWBOX, markTones } from './Logo.js';
import { DBAND, D_SWEEP, PBOWL, P_SWEEP, SLAB } from './markPaths.js';

export type MarkMode = 'still' | 'intro' | 'outro' | 'loader';

/**
 * The mark in motion (keyframes in motion.css, under "The mark"). It tells the name: the P first, then the D.
 *   intro   the slab rises, the bowl of the P is written from it, then the D draws round the P (1.1 s)
 *   loader  the P holds still; the D dims to a track and two arcs of it travel round
 *   outro   the D runs on round and off, the P follows it, the slab drops away (0.46 s)
 *   still   no motion
 * With "reduce motion" on, every mode shows the still mark.
 *
 * The bowl and the D are each a thick circle stroke clipped to the piece, so they can be drawn round.
 * Both circles use pathLength 360, so dash values are degrees.
 */
export const LogoMotion: React.FC<{ mode: MarkMode; size?: number; className?: string; tone?: 'rail' | 'page' }> = ({
  mode,
  size = 28,
  className,
  tone = 'page'
}) => {
  const { a, b } = markTones(tone);
  const id = useId().replace(/:/g, '');
  const ring = (cls: string, v: typeof D_SWEEP, stroke: string, dash = '360 360') => (
    <circle
      className={cls}
      cx={v.cx}
      cy={v.cy}
      r={v.r}
      fill="none"
      stroke={stroke}
      strokeWidth={v.w}
      pathLength={360}
      strokeDasharray={dash}
      transform={`rotate(${v.from} ${v.cx} ${v.cy})`}
    />
  );
  const vars = {
    '--mk-d': 360 - D_SWEEP.sweep,
    '--mk-d-off': -D_SWEEP.sweep,
    '--mk-p': 360 - P_SWEEP.sweep,
    '--mk-p-off': -P_SWEEP.sweep
  } as React.CSSProperties;
  return (
    <svg
      className={`mk mk-${mode}${className ? ` ${className}` : ''}`}
      style={vars}
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={`${id}d`}>
          <path d={DBAND} />
        </clipPath>
        <clipPath id={`${id}p`}>
          <path d={PBOWL} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}d)`}>{ring('mk-d', D_SWEEP, b)}</g>
      {mode === 'loader' && (
        <g clipPath={`url(#${id}d)`} className="mk-orbit">
          {/* The rotation is a CSS transform, so the arcs sit in a group that carries the centre. */}
          <g style={{ transformOrigin: `${D_SWEEP.cx}px ${D_SWEEP.cy}px` }} className="mk-orbit-turn">
            {ring('', D_SWEEP, b, '100 80')}
          </g>
        </g>
      )}
      <path className="mk-slab" d={SLAB} fill={a} />
      <g clipPath={`url(#${id}p)`}>{ring('mk-p', P_SWEEP, a)}</g>
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

const INTRO_MS = 1100;
const OUTRO_MS = 460;
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
