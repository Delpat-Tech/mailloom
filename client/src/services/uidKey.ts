/**
 * Views such as Starred hold mail from several folders, where two messages can share a uid.
 * Inside a view each row gets a key that includes its folder: (folder number x 2^32) + uid.
 * Ordinary folders keep the plain uid (folder number 0). Real uids are below 2^32, so the
 * original is always recoverable, and `realUid` is applied wherever a uid goes to the server.
 */
const STEP = 2 ** 32;
const folders = new Map<string, number>();

export function keyFor(mailbox: string, uid: number): number {
  let n = folders.get(mailbox);
  if (n === undefined) {
    n = folders.size + 1;
    folders.set(mailbox, n);
  }
  return n * STEP + uid;
}

export function realUid(key: number): number {
  return key % STEP;
}
