#!/usr/bin/env node
// Decides whether mailloom-update may install a release. Only releases whose commit is on main are accepted.
// Installed next to the update script (see docs/deploy.md). Every doubt ends in "refuse" or "error": it never guesses.
//
// CLI: node mailloom-update-decide.mjs <repo> <mode> <installed> [tag] [skip]
//   mode: auto | latest | tag | prerelease   (prerelease = a manual install of a tag that is marked pre-release)
//   installed: first line of the running VERSION file ("-" if unknown)
//   skip: release file name that must not be installed again automatically (after a rollback or a failed install)
// Prints one tab-separated line: ACTION CODE TAG COMMIT ASSET_NAME ASSET_ID DIGEST MESSAGE   ("-" when empty)
//   ACTION: install | noop | refuse | error
import { fileURLToPath } from 'node:url';

// Tests only: a local stand-in for the API, honoured only together with MAILLOOM_UPDATE_ROOT (never set on the server).
const API = (process.env.MAILLOOM_UPDATE_ROOT && process.env.MAILLOOM_UPDATE_TEST_API) || 'https://api.github.com';
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ASSET_RE = /^mailloom-[0-9a-f]{10,40}\.tar\.gz$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export class GithubError extends Error {}

export async function fetchJson(path, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(API + path, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mailloom-update' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new GithubError(`Could not reach GitHub (${e && e.message ? e.message : e}).`);
  }
  if (!res.ok) {
    const e = new GithubError(`GitHub answered ${res.status} for ${path}.`);
    e.status = res.status;
    throw e;
  }
  try {
    return await res.json();
  } catch {
    throw new GithubError(`GitHub sent an unreadable answer for ${path}.`);
  }
}

// Follows annotated tags until a commit is reached.
export async function resolveTagToCommit(repo, tag, get) {
  const ref = await get(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  let obj = ref && ref.object;
  for (let depth = 0; depth < 5; depth++) {
    if (!obj || typeof obj.sha !== 'string' || !SHA_RE.test(obj.sha)) throw new GithubError('Tag answer was not understood.');
    if (obj.type === 'commit') return obj.sha;
    if (obj.type !== 'tag') throw new GithubError(`Tag points at a ${obj.type}, not a commit.`);
    const t = await get(`/repos/${repo}/git/tags/${obj.sha}`);
    obj = t && t.object;
  }
  throw new GithubError('Tag chain is too deep.');
}

// The tip of a branch as a full commit SHA. The exact-ref endpoint is used so a tag with the same name cannot stand in.
export async function resolveBranch(repo, branch, get) {
  const ref = await get(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const o = ref && ref.object;
  if (!o || o.type !== 'commit' || typeof o.sha !== 'string' || !SHA_RE.test(o.sha)) throw new GithubError(`The ${branch} branch answer was not understood.`);
  return o.sha;
}

const out = (o) => ({ action: 'refuse', code: '', tag: '', commit: '', asset: null, message: '', ...o });

// mode: auto | latest | tag | prerelease
export async function decide({ repo, mode, tag, installed, skip, get }) {
  try {
    const latest = mode === 'auto' || mode === 'latest';
    if (!latest && !TAG_RE.test(tag || '')) {
      return out({ code: 'bad_tag', message: 'That is not a valid release tag.' });
    }
    const path = latest ? `/repos/${repo}/releases/latest` : `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
    const rel = await get(path);
    if (!rel || typeof rel.tag_name !== 'string' || !TAG_RE.test(rel.tag_name)) throw new GithubError('Release answer was not understood.');
    const t = rel.tag_name;
    if (rel.draft) return out({ code: 'draft', tag: t, message: `${t} is a draft and is not installed.` });
    if (rel.prerelease && mode !== 'prerelease') {
      return out({ code: 'prerelease', tag: t, message: `${t} is a pre-release. Use --allow-prerelease ${t} to install it on purpose.` });
    }
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const a = assets.find((x) => x && typeof x.name === 'string' && ASSET_RE.test(x.name));
    const digest = a && typeof a.digest === 'string' ? a.digest.replace(/^sha256:/, '') : '';
    if (!a || !/^[0-9a-f]{64}$/.test(digest) || !Number.isInteger(a.id)) {
      return out({ code: 'no_asset', tag: t, message: `${t} has no release file with a checksum.` });
    }
    const asset = { name: a.name, id: a.id, digest };

    // Checked against main before anything else is decided, even when the version is the same.
    const commit = await resolveTagToCommit(repo, t, get);
    // Compare against main's SHA, never the word "main": a tag called main would win that lookup.
    const mainSha = await resolveBranch(repo, 'main', get);
    const cmp = await get(`/repos/${repo}/compare/${commit}...${mainSha}?per_page=1`);
    if (!cmp || (cmp.status !== 'identical' && cmp.status !== 'ahead')) {
      const says = cmp && cmp.status ? cmp.status : 'unknown';
      return out({ code: 'not_on_main', tag: t, commit, asset, message: `${t} (commit ${commit.slice(0, 10)}) is not on main (GitHub says: ${says}). Nothing changed.` });
    }
    // The file must have been built from the commit the tag names.
    const built = a.name.replace(/^mailloom-/, '').replace(/\.tar\.gz$/, '');
    if (!commit.startsWith(built)) {
      return out({ code: 'asset_mismatch', tag: t, commit, asset, message: `The release file ${a.name} was not built from the commit of ${t} (${commit.slice(0, 10)}). Nothing changed.` });
    }
    if (mode === 'auto') {
      const built2 = a.name.replace(/\.tar\.gz$/, '');
      if (installed === built2) return out({ action: 'noop', code: 'same', tag: t, commit, asset, message: `already running ${t}` });
      if (skip && skip === a.name) {
        return out({ action: 'noop', code: 'skipped', tag: t, commit, asset, message: `${t} was rolled back or failed earlier, so it is not tried again. To install it anyway: sudo mailloom-update ${t}` });
      }
      // The nightly run only ever moves forward: the candidate must be strictly ahead of what is installed.
      const m = /^mailloom-([0-9a-f]{10,40})$/.exec(installed || '');
      if (!m) return out({ code: 'installed_unknown', tag: t, commit, asset, message: `Cannot tell which commit is installed (${installed || 'unknown'}), so ${t} is not installed automatically. Install it by hand.` });
      let fwd;
      try {
        fwd = await get(`/repos/${repo}/compare/${m[1]}...${commit}?per_page=1`);
      } catch (e) {
        if (e instanceof GithubError && e.status === 404) {
          return out({ code: 'installed_unknown', tag: t, commit, asset, message: `installed commit unknown to GitHub (${installed}), so ${t} is not installed automatically. Install it by hand.` });
        }
        throw e;
      }
      if (fwd && fwd.status === 'identical') return out({ action: 'noop', code: 'same', tag: t, commit, asset, message: `already running ${t}` });
      if (!fwd || fwd.status !== 'ahead') {
        return out({ code: 'not_newer', tag: t, commit, asset, message: `${t} is not newer than the installed ${installed} (GitHub says: ${fwd && fwd.status ? fwd.status : 'unknown'}), so the nightly run will not install it. Nothing changed.` });
      }
    }
    return out({ action: 'install', code: 'ok', tag: t, commit, asset, message: `${t} is on main.` });
  } catch (e) {
    return out({ action: 'error', code: 'api_error', message: e instanceof GithubError ? e.message : `Unexpected problem: ${e && e.message ? e.message : e}` });
  }
}

export function toLine(d) {
  const f = (v) => (v === '' || v == null ? '-' : String(v).replace(/[\t\r\n]+/g, ' '));
  return [d.action, d.code, d.tag, d.commit, d.asset && d.asset.name, d.asset && d.asset.id, d.asset && d.asset.digest, d.message].map(f).join('\t');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [repo, mode, installed, tag, skip] = process.argv.slice(2);
  const ok = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo || '') && ['auto', 'latest', 'tag', 'prerelease'].includes(mode);
  const d = ok
    ? await decide({ repo, mode, tag, installed, skip, get: (p) => fetchJson(p) })
    : out({ action: 'error', code: 'usage', message: 'Bad arguments.' });
  console.log(toLine(d));
}
