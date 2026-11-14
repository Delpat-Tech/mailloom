import React, { useEffect, useState } from 'react';

/** True only after `ms` of waiting, so a fast load never flashes a placeholder. */
export function useAfterDelay(active: boolean, ms = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return shown;
}

/** Placeholder rows shaped like real message rows. */
export const SkeletonRows: React.FC<{ count?: number }> = ({ count = 8 }) => (
  <div role="status" aria-label="Loading messages" className="flex-1 overflow-hidden">
    {Array.from({ length: count }, (_, i) => (
      <div key={i} className="flex gap-3 px-4 py-[11px] border-b border-line" aria-hidden="true">
        <div className="skel w-9 h-9 shrink-0 ml-8" style={{ clipPath: 'polygon(0 0, 64% 0, 100% 34%, 100% 100%, 0 100%)' }} />
        <div className="flex-1 min-w-0 space-y-2 pt-0.5">
          <div className="flex justify-between gap-6">
            <div className="skel h-3.5" style={{ width: `${38 + ((i * 17) % 30)}%` }} />
            <div className="skel h-3 w-10" />
          </div>
          <div className="skel h-3.5" style={{ width: `${62 + ((i * 13) % 30)}%` }} />
          <div className="skel h-3" style={{ width: `${50 + ((i * 7) % 40)}%` }} />
        </div>
      </div>
    ))}
  </div>
);

/** Placeholder for the reader while a message loads. */
export const SkeletonReader: React.FC = () => (
  <div role="status" aria-label="Loading message" className="flex-1 px-4 sm:px-10 py-6" aria-busy="true">
    <div className="skel h-7 w-2/3 mb-5" />
    <div className="border border-line bg-surface p-5 space-y-3">
      <div className="flex gap-3 items-center">
        <div className="skel w-10 h-10" />
        <div className="space-y-2 flex-1">
          <div className="skel h-4 w-1/3" />
          <div className="skel h-3 w-1/2" />
        </div>
      </div>
      <div className="skel h-3.5 w-full" />
      <div className="skel h-3.5 w-11/12" />
      <div className="skel h-3.5 w-3/4" />
    </div>
  </div>
);
