import React from 'react';

/**
 * The Mailloom mark. On the sky rail it uses the rail colours (--rm-a/--rm-b); on a plain page
 * ("page") it uses --mk-a/--mk-b. Both pairs are set per theme in index.css.
 */
export const Logo: React.FC<{ size?: number; className?: string; tone?: 'rail' | 'page' }> = ({
  size = 28,
  className,
  tone = 'rail'
}) => {
  const a = tone === 'rail' ? 'var(--rm-a)' : 'var(--mk-a)';
  const b = tone === 'rail' ? 'var(--rm-b)' : 'var(--mk-b)';
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M3 2.5l8 7V30H3z" fill={a} />
      <path d="M13 2.5h5a13.5 13.5 0 0 1 9.6 23l-4.2-10.3A7.6 7.6 0 0 0 18 8.6h-5z" fill={b} />
      <path
        d="M13 10.6h5a4.7 4.7 0 0 1 0 9.4h-5zM13 22h5a9.5 9.5 0 0 0 5.6-1.9l3.2 7.7A13.4 13.4 0 0 1 18 30h-5z"
        fill={a}
      />
    </svg>
  );
};
