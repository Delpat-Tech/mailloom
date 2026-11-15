import React, { useEffect, useRef, useState } from 'react';
import { MARK_VIEWBOX, MarkGradients, markFill, useMarkId, type MarkTone } from './Logo.js';
import { BOWL, BOWL_SWEEP, COUNTER, LOWER, LOWER_SWEEP, MARK_CX, MARK_CY, MARK_H, MARK_W, SLAB } from './markPaths.js';

export type MarkMode = 'still' | 'intro' | 'outro' | 'loader';

/**
 * The mark in motion (keyframes in motion.css, under "The mark"). Three different movements:
 *   intro   it is drawn: the slab rises, the D is swept round in one stroke (bowl, then lower piece), and the
 *           counter settles in the middle (1.1 s)
 *   loader  it comes and goes in steps, every piece staying exactly in its place: slab, bowl, lower piece and
 *           counter arrive one after another, the whole mark holds a beat, then they leave in the same order.
 *           The last piece is still leaving while the first one returns, so the loop has no seam and no empty
 *           frame. It starts from the whole mark and runs for as long as it is shown.
 *   outro   it runs off: the counter slips into the stem, the D runs on round and off its own foot, and the
 *           slab sinks through the baseline (0.62 s). Movement only, no fades.
 *   still   no motion
 * With "reduce motion" on, every mode shows the still mark.
 *
 * The bowl and the lower piece are shown through a mask holding a thick circle stroke about the centre of the D
 * (pathLength 360, so dash values are degrees): moving the dash sweeps the piece in or out along its own arc.
 * In the loader the slab and the counter are shown through a window that slides across them. A mask leaves each
 * piece's own fill untouched, and with no animation every mask shows its whole piece.
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
  const ring = (cls: string, v: { r: number; w: number; from: number }) => (
    <circle
      className={cls}
      cx={MARK_CX}
      cy={MARK_CY}
      r={v.r}
      fill="none"
      stroke="#fff"
      strokeWidth={v.w}
      pathLength={360}
      strokeDasharray="360 360"
      transform={`rotate(${v.from} ${MARK_CX} ${MARK_CY})`}
    />
  );
  // Dash offsets (degrees): 360 hides a piece before its start, --mk-bowl shows all of it, --mk-bowl-off hides
  // it past its end.
  const vars = {
    '--mk-bowl': 360 - BOWL_SWEEP.sweep,
    '--mk-bowl-off': -BOWL_SWEEP.sweep,
    '--mk-lower': 360 - LOWER_SWEEP.sweep,
    '--mk-lower-off': -LOWER_SWEEP.sweep
  } as React.CSSProperties;
  const moving = mode !== 'still';
  const loader = mode === 'loader';
  const slab = <path className="mk-slab" d={SLAB} {...fill('slab')} mask={loader ? `url(#${id}ms)` : undefined} />;
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
        {moving && (
          <>
            <mask id={`${id}mb`} {...box}>
              {ring('mk-sweep-bowl', BOWL_SWEEP)}
            </mask>
            <mask id={`${id}ml`} {...box}>
              {ring('mk-sweep-lower', LOWER_SWEEP)}
            </mask>
          </>
        )}
        {loader && (
          <>
            <mask id={`${id}ms`} {...box}>
              <rect className="mk-win-slab" x={-20} y={-20} width={300} height={MARK_H + 40} fill="#fff" />
            </mask>
            <mask id={`${id}mc`} {...box}>
              <rect className="mk-win-counter" x={284} y={240} width={260} height={240} fill="#fff" />
            </mask>
          </>
        )}
        {mode === 'outro' && (
          <clipPath id={`${id}floor`}>
            <rect x={-200} y={-200} width={MARK_W + 400} height={MARK_H + 200} />
          </clipPath>
        )}
      </defs>
      <path className="mk-bowl" d={BOWL} {...fill('bowl')} mask={moving ? `url(#${id}mb)` : undefined} />
      {mode === 'outro' ? <g clipPath={`url(#${id}floor)`}>{slab}</g> : slab}
      <path className="mk-counter" d={COUNTER} {...fill('counter')} mask={loader ? `url(#${id}mc)` : undefined} />
      <path className="mk-lower" d={LOWER} {...fill('lower')} mask={moving ? `url(#${id}ml)` : undefined} />
    </svg>
  );
};

/** A small looping mark for waiting states inside a page (the full-page one is BrandCurtain). It loops until it is unmounted. */
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
const OUTRO_MS = 620;
/** The outro waits this long while the curtain arrives (--mk-wait on .brand-curtain-outro). */
const OUTRO_WAIT_MS = 60;
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
    const t = setTimeout(() => setLeaving(true), kind === 'intro' ? INTRO_MS : OUTRO_WAIT_MS + OUTRO_MS);
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
