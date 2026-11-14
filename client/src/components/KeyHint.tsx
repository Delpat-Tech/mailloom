import React from 'react';

/** A small key hint like "E". Decorative: the button carries aria-keyshortcuts for screen readers. */
export const KeyHint: React.FC<{ keys: string; className?: string }> = ({ keys, className = '' }) => (
  <kbd
    aria-hidden="true"
    className={`hidden lg:inline-block text-[10.5px] font-semibold leading-none px-1 py-[3px] min-w-[18px] text-center rounded-[3px] border border-line-2 bg-surface text-ink-2 ${className}`}
  >
    {keys}
  </kbd>
);
