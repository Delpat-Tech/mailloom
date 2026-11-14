// Avatar colour and initials. The same sender always gets the same colour.
// Full class names are written out so Tailwind keeps them.
const COLOURS = ['bg-av1', 'bg-av2', 'bg-av3', 'bg-av4', 'bg-av5', 'bg-av6'];

export function avatarClass(key: string): string {
  let h = 0;
  for (const ch of key.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

/** Up to two capital letters: first letters of the first and last word of the name. */
export function initialsOf(name: string): string {
  const words = name
    .replace(/[<>"']/g, ' ')
    .split(/[\s@._-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0])[0] ?? '?';
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
  return (first + last).toUpperCase();
}
