import React, { useEffect, useRef, useState } from 'react';
import { FROST, MARK_VIEWBOX, MarkGradients, markFill, useMarkId, type MarkTone } from './Logo.js';
import { BOWL, BOWL_SWEEP, COUNTER, LOWER, LOWER_SWEEP, MARK_CX, MARK_CY, MARK_H, MARK_W, RING, SLAB, SPLIT } from './markPaths.js';

export type MarkMode = 'still' | 'intro' | 'outro' | 'loader';

/** How far the bowl and the lower piece slide apart along their shared diagonal in the outro (mark units). */
const PART = 110;

/**
 * The mark in motion (keyframes in motion.css, under "The mark"). Three different movements:
 *   intro   it is drawn: the slab rises, the D is swept round in one stroke (bowl, then lower piece), and the
 *           counter settles in the middle (1.1 s)
 *   loader  it waits: the D dims to a track and two lit arcs travel round it; slab and counter hold still
 *   outro   it comes apart: the counter closes, the bowl and the lower piece slide apart along their
 *           diagonal, the slab drops away (0.46 s)
 *   still   no motion
 * With "reduce motion" on, every mode shows the still mark.
 *
 * The sweeps and the travelling arcs are masks (a thick circle stroke about the centre of the D, with
 * pathLength 360 so dash values are degrees). A mask leaves each piece's own fill untouched.
 */
export const LogoMotion: React.FC<{ mode: MarkMode; size?: number; className?: string; tone?: MarkTone }> = ({
  mode,
  size = 28,
  className,
  tone = 'theme'
}) => {
  const id = useMarkId();
  const fill = (piece: Parameters<typeof markFill>[2]) => markFill(id, tone, piece);
  const box = { maskUnits: 'userSpaceOnUse' as const, x: -200, y: -200, width: MARK_W + 400, height: MARK_H + 400 };
  const ring = (cls: string, v: { r: number; w: number }, from: number, dash: string) => (
    <circle
      className={cls}
      cx={MARK_CX}
      cy={MARK_CY}
      r={v.r}
      fill="none"
      stroke="#fff"
      strokeWidth={v.w}
      pathLength={360}
      strokeDasharray={dash}
      transform={`rotate(${from} ${MARK_CX} ${MARK_CY})`}
    />
  );
  const vars = {
    '--mk-bowl': 360 - BOWL_SWEEP.sweep,
    '--mk-lower': 360 - LOWER_SWEEP.sweep,
    '--mk-px': `${(SPLIT.x * PART).toFixed(1)}px`,
    '--mk-py': `${(SPLIT.y * PART).toFixed(1)}px`
  } as React.CSSProperties;
  const intro = mode === 'intro';
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
        {tone === 'theme' && <MarkGradients id={id} />}
        {intro && (
          <>
            <mask id={`${id}mb`} {...box}>
              {ring('mk-sweep-bowl', BOWL_SWEEP, BOWL_SWEEP.from, '360 360')}
            </mask>
            <mask id={`${id}ml`} {...box}>
              {ring('mk-sweep-lower', LOWER_SWEEP, LOWER_SWEEP.from, '360 360')}
            </mask>
          </>
        )}
        {mode === 'loader' && (
          <mask id={`${id}mo`} {...box}>
            <g className="mk-orbit-turn" style={{ transformOrigin: `${MARK_CX}px ${MARK_CY}px` }}>
              {ring('', RING, BOWL_SWEEP.from, '96 84')}
            </g>
          </mask>
        )}
      </defs>
      <g className="mk-bowl">
        <path d={BOWL} {...fill('bowl')} mask={intro ? `url(#${id}mb)` : undefined} />
      </g>
      <path className="mk-slab" d={SLAB} {...fill('slab')} />
      <path className="mk-counter" d={COUNTER} {...fill('counter')} />
      <g className="mk-lower">
        <path d={LOWER} {...fill('lower')} mask={intro ? `url(#${id}ml)` : undefined} />
      </g>
      {mode === 'loader' && (
        <g className="mk-orbit" mask={`url(#${id}mo)`}>
          <path d={BOWL} {...fill('bowl')} fillOpacity={tone === 'white' ? FROST + 0.3 : undefined} />
          <path d={LOWER} {...fill('lower')} />
        </g>
      )}
    </svg>
  );
};

/** A small looping mark for waiting states inside a page (the full-page one is BrandCurtain). */
export const MarkLoader: React.FC<{ size?: number; label?: string; className?: string; tone?: MarkTone }> = ({
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
 * It is the app icon at full size: the white mark on the navy-to-blue ground, in both themes, so it follows
 * the launch screen (the manifest's navy background) without a flash.
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

  // Boot: once the intro has played, switch to the loader.
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
      className={`brand-curtain brand-curtain-${kind} fixed inset-0 z-[200] flex items-center justify-center ${
        blocking ? '' : 'pointer-events-none'
      }`}
      data-leaving={leaving ? 'true' : undefined}
      role={kind === 'boot' ? 'status' : undefined}
      aria-hidden={kind === 'boot' ? undefined : true}
    >
      <div className="flex flex-col items-center gap-4">
        <LogoMotion mode={kind === 'outro' ? 'outro' : looping ? 'loader' : 'intro'} size={84} tone="white" />
        {kind === 'boot' && <span className="brand-curtain-label text-xs font-semibold">Launching Mailloom...</span>}
      </div>
    </div>
  );
};
