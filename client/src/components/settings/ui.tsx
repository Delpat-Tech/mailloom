import React from 'react';

/** An on/off control. role="switch" with aria-checked; the whole row is the touch target. */
export const Switch: React.FC<{
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}> = ({ checked, onChange, label, description, disabled }) => {
  const id = React.useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3.5">
      <div className="min-w-0">
        <div id={`${id}-l`} className="text-[14.5px] font-bold text-ink">{label}</div>
        {description && <p id={`${id}-d`} className="mt-0.5 text-[13px] leading-snug text-ink-3">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="t-fast shrink-0 -my-1.5 min-h-[44px] min-w-[52px] grid place-items-center rounded disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={`t-fast relative block h-[26px] w-[46px] rounded-full border ${checked ? 'bg-act border-act' : 'bg-sheet border-line-2'}`}
        >
          <span
            className={`absolute top-[2px] h-5 w-5 rounded-full transition-[left] duration-[160ms] ${
              checked ? 'left-[22px] bg-act-ink' : 'left-[2px] bg-ink-3'
            }`}
          />
        </span>
      </button>
    </div>
  );
};

/** A small set of exclusive choices (Light / Dark / System). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-full sm:w-auto gap-0.5 p-0.5 rounded bg-sheet border border-line">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`t-fast flex-1 sm:flex-none sm:min-w-[84px] min-h-[44px] sm:min-h-[36px] px-4 rounded-[3px] text-[13.5px] font-bold ${
              on ? 'bg-act text-act-ink' : 'text-ink-2 hover:bg-hover'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled setting: title and help on the left, the control under it on a phone and beside it on a desktop. */
export const Setting: React.FC<{ title: string; help?: string; children: React.ReactNode }> = ({ title, help, children }) => (
  <div className="py-3.5 sm:flex sm:items-center sm:justify-between sm:gap-6">
    <div className="min-w-0 mb-2.5 sm:mb-0">
      <div className="text-[14.5px] font-bold text-ink">{title}</div>
      {help && <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{help}</p>}
    </div>
    <div className="sm:shrink-0">{children}</div>
  </div>
);

/** Rows grouped on one white card with thin dividers. */
export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`rounded border border-line bg-surface px-4 sm:px-5 divide-y divide-line ${className}`}>{children}</div>
);

export const SectionTitle: React.FC<{ children: React.ReactNode; hint?: string }> = ({ children, hint }) => (
  <div className="mt-8 first:mt-0 mb-2.5">
    <h3 className="text-[13px] font-extrabold text-ink-2">{children}</h3>
    {hint && <p className="mt-0.5 text-[13px] text-ink-3">{hint}</p>}
  </div>
);

export const ErrorNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p role="alert" className="mt-2 rounded bg-warn-bg border border-warn-line text-warn-ink text-[13px] font-semibold px-3 py-2">
    {children}
  </p>
);

export const BTN =
  't-fast inline-flex items-center justify-center gap-2 min-h-[44px] sm:min-h-[38px] px-4 rounded border border-line-2 bg-surface hover:bg-hover text-ink-2 text-[13.5px] font-bold disabled:opacity-50';
export const BTN_PRIMARY =
  't-fast cut-tr inline-flex items-center justify-center gap-2 min-h-[44px] sm:min-h-[38px] px-4 bg-act hover:bg-act-hov text-act-ink text-[13.5px] font-extrabold disabled:opacity-50';
export const BTN_DANGER =
  't-fast inline-flex items-center justify-center gap-2 min-h-[44px] sm:min-h-[38px] px-4 rounded border border-warn-line bg-warn-bg text-warn-ink text-[13.5px] font-bold hover:opacity-90 disabled:opacity-50';
export const INPUT =
  'w-full bg-surface border border-line-2 rounded px-3 min-h-[44px] sm:min-h-[38px] text-base sm:text-[14px] text-ink placeholder:text-ink-3';

export function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'That could not be saved. Please try again.';
}
