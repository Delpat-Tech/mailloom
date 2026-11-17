import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decide, resolveTagToCommit, toLine, GithubError, discordPayload } from '../../deploy/mailloom-update-decide.mjs';

const SHA = 'a'.repeat(10) + 'b'.repeat(30);
const asset = { name: `mailloom-${SHA.slice(0, 10)}.tar.gz`, id: 7, digest: 'sha256:' + 'c'.repeat(64) };
const release = (o = {}) => ({ tag_name: 'v2026.11.18', draft: false, prerelease: false, assets: [asset], ...o });

// Stub: maps path fragments to answers ('ERR' throws like a failed request).
function stub(map) {
  return async (p) => {
    for (const [k, v] of Object.entries(map)) {
      if (p.includes(k)) {
        if (v === 'ERR') throw new GithubError('GitHub answered 500.');
        return typeof v === 'function' ? v(p) : v;
      }
    }
    throw new GithubError('unexpected ' + p);
  };
}
const ref = { object: { type: 'commit', sha: SHA } };
const MAIN = '1'.repeat(40);
const OLD = 'e'.repeat(10);
const mainRef = { object: { type: 'commit', sha: MAIN } };
// Compare answers: `main` is the status of candidate...main, `inst` of installed...candidate.
const cmp = (main = 'ahead', inst = 'ahead') => (p) => ({ status: p.includes(`/compare/${OLD}...`) ? inst : main });
const base = { repo: 'o/r', tag: 'v2026.11.18', installed: `mailloom-${OLD}` };
const good = { '/releases/latest': release(), '/releases/tags/': release(), '/git/ref/tags/': ref, '/git/ref/heads/main': mainRef, '/compare/': cmp() };

test('on main (ahead) -> install', async () => {
  const d = await decide({ ...base, mode: 'auto', get: stub(good) });
  assert.equal(d.action, 'install');
  assert.equal(d.commit, SHA);
});

test('on main (identical) -> install', async () => {
  const d = await decide({ ...base, mode: 'tag', get: stub({ ...good, '/compare/': cmp('identical') }) });
  assert.equal(d.action, 'install');
});

for (const status of ['diverged', 'behind', 'unknown']) {
  test(`not on main (${status}) -> refuse`, async () => {
    const d = await decide({ ...base, mode: 'tag', get: stub({ ...good, '/compare/': cmp(status) }) });
    assert.equal(d.action, 'refuse');
    assert.equal(d.code, 'not_on_main');
  });
}

test('prerelease on auto -> refuse', async () => {
  const d = await decide({ ...base, mode: 'auto', get: stub({ '/releases/latest': release({ prerelease: true }) }) });
  assert.equal(d.action, 'refuse');
  assert.equal(d.code, 'prerelease');
});

test('prerelease with --allow-prerelease still needs main', async () => {
  const pre = release({ prerelease: true });
  const ok = await decide({ ...base, mode: 'prerelease', get: stub({ ...good, '/releases/tags/': pre }) });
  assert.equal(ok.action, 'install');
  const bad = await decide({ ...base, mode: 'prerelease', get: stub({ ...good, '/releases/tags/': pre, '/compare/': cmp('diverged') }) });
  assert.equal(bad.action, 'refuse');
});

test('prerelease manual without the flag -> refuse', async () => {
  const d = await decide({ ...base, mode: 'tag', get: stub({ '/releases/tags/': release({ prerelease: true }) }) });
  assert.equal(d.code, 'prerelease');
});

test('draft -> refuse', async () => {
  const d = await decide({ ...base, mode: 'tag', get: stub({ '/releases/tags/': release({ draft: true }) }) });
  assert.equal(d.code, 'draft');
});

test('same version on auto -> noop', async () => {
  const d = await decide({ ...base, mode: 'auto', installed: asset.name.replace('.tar.gz', ''), get: stub(good) });
  assert.equal(d.action, 'noop');
  assert.match(d.message, /already running v2026\.11\.18/);
});

test('same version on a manual tag -> install again', async () => {
  const d = await decide({ ...base, mode: 'tag', installed: asset.name.replace('.tar.gz', ''), get: stub(good) });
  assert.equal(d.action, 'install');
});

for (const where of ['/releases/latest', '/git/ref/tags/', '/git/ref/heads/main', '/compare/']) {
  test(`API error at ${where} -> error (fail closed)`, async () => {
    const d = await decide({ ...base, mode: 'auto', get: stub({ ...good, [where]: 'ERR' }) });
    assert.equal(d.action, 'error');
  });
}

test('garbage answers never install', async () => {
  const bads = [null, {}, { tag_name: 5 }, release({ assets: 'x' }), release({ assets: [{ ...asset, digest: 'md5:zz' }] })];
  for (const rel of bads) {
    const d = await decide({ ...base, mode: 'auto', get: stub({ '/releases/latest': rel }) });
    assert.notEqual(d.action, 'install');
  }
  const badRef = { object: { type: 'commit', sha: 'zz' } };
  const d = await decide({ ...base, mode: 'auto', get: stub({ ...good, '/git/ref/tags/': badRef }) });
  assert.notEqual(d.action, 'install');
});

test('annotated tag is followed to its commit', async () => {
  const tagObj = 'd'.repeat(40);
  const get = stub({ '/git/ref/': { object: { type: 'tag', sha: tagObj } }, [`/git/tags/${tagObj}`]: { object: { type: 'commit', sha: SHA } } });
  assert.equal(await resolveTagToCommit('o/r', 'v1', get), SHA);
});

test('tag pointing at a tree is refused', async () => {
  const get = stub({ '/git/ref/': { object: { type: 'tree', sha: SHA } } });
  await assert.rejects(resolveTagToCommit('o/r', 'v1', get), GithubError);
});

test('release file built from another commit -> refuse', async () => {
  const other = { ...asset, name: 'mailloom-0123456789.tar.gz' };
  const d = await decide({ ...base, mode: 'auto', get: stub({ ...good, '/releases/latest': release({ assets: [other] }) }) });
  assert.equal(d.code, 'asset_mismatch');
});

test('bad tag text is refused before any request', async () => {
  const get = async () => { throw new Error('no request expected'); };
  const d = await decide({ ...base, mode: 'tag', tag: '../x; rm -rf', get });
  assert.equal(d.code, 'bad_tag');
});

test('output line has 8 tab-separated fields, none empty', async () => {
  const d = await decide({ ...base, mode: 'auto', get: stub(good) });
  const f = toLine(d).split('\t');
  assert.equal(f.length, 8);
  assert.ok(f.every((x) => x !== ''));
});

test('a tag named main cannot stand in for the branch: compare uses the branch SHA', async () => {
  const seen = [];
  const get = async (p) => { seen.push(p); return stub({ ...good, '/compare/': cmp('ahead') })(p); };
  const d = await decide({ ...base, tag: 'main', mode: 'tag', get: stub({ '/releases/tags/': release({ tag_name: 'main' }), '/git/ref/tags/main': ref, '/git/ref/heads/main': mainRef, '/compare/': (p) => { seen.push(p); return { status: 'ahead' }; } }) });
  assert.equal(d.action, 'install');
  assert.ok(seen.some((p) => p.includes(`/compare/${SHA}...${MAIN}`)));
  assert.ok(!seen.some((p) => p.includes('...main')));
  void get;
});

test('main branch answer that is not a commit -> error', async () => {
  const d = await decide({ ...base, mode: 'auto', get: stub({ ...good, '/git/ref/heads/main': { object: { type: 'tag', sha: SHA } } }) });
  assert.equal(d.action, 'error');
});

test('auto never downgrades: candidate behind or diverged from installed -> refuse', async () => {
  for (const inst of ['behind', 'diverged', 'unknown']) {
    const d = await decide({ ...base, mode: 'auto', get: stub({ ...good, '/compare/': cmp('ahead', inst) }) });
    assert.equal(d.action, 'refuse');
    assert.equal(d.code, 'not_newer');
  }
});

test('auto with identical installed commit -> noop', async () => {
  const d = await decide({ ...base, mode: 'auto', get: stub({ ...good, '/compare/': cmp('ahead', 'identical') }) });
  assert.equal(d.action, 'noop');
});

test('auto with an unreadable installed version -> refuse', async () => {
  for (const installed of ['unknown', '-', 'mailloom-abc1234567-dirty', '']) {
    const d = await decide({ ...base, mode: 'auto', installed, get: stub(good) });
    assert.equal(d.code, 'installed_unknown');
  }
});

test('manual tag may go back on purpose', async () => {
  const d = await decide({ ...base, mode: 'tag', get: stub({ ...good, '/compare/': cmp('ahead', 'behind') }) });
  assert.equal(d.action, 'install');
});

test('skipped release -> noop on auto, still installable by hand', async () => {
  const a = await decide({ ...base, mode: 'auto', skip: asset.name, get: stub(good) });
  assert.equal(a.action, 'noop');
  assert.equal(a.code, 'skipped');
  const m = await decide({ ...base, mode: 'tag', skip: asset.name, get: stub(good) });
  assert.equal(m.action, 'install');
  const other = await decide({ ...base, mode: 'auto', skip: 'mailloom-0000000000.tar.gz', get: stub(good) });
  assert.equal(other.action, 'install');
});

test('release file name needs a 10 to 40 digit hex hash', async () => {
  for (const name of ['mailloom-abc.tar.gz', 'mailloom-' + 'a'.repeat(41) + '.tar.gz', 'mailloom-zzzzzzzzzz.tar.gz']) {
    const d = await decide({ ...base, mode: 'auto', get: stub({ ...good, '/releases/latest': release({ assets: [{ ...asset, name }] }) }) });
    assert.equal(d.code, 'no_asset');
  }
});

test('installed commit unknown to GitHub (404) -> refuse, not error', async () => {
  const get = stub({ ...good, '/compare/': (p) => { if (p.includes(`/compare/${OLD}...`)) { const e = new GithubError('GitHub answered 404.'); e.status = 404; throw e; } return { status: 'ahead' }; } });
  const d = await decide({ ...base, mode: 'auto', get });
  assert.equal(d.action, 'refuse');
  assert.equal(d.code, 'installed_unknown');
  assert.match(d.message, /installed commit unknown/);
});

// Script hygiene: no noisy expected errors, and the health poll stays silent.
const script = fs.readFileSync(new URL('../../deploy/mailloom-update.sh', import.meta.url), 'utf8');
test('health-poll curl is silent: -fs without -S, stderr to /dev/null', () => {
  const lines = script.split('\n').filter((l) => /curl[^\n]*127\.0\.0\.1/.test(l));
  assert.ok(lines.length >= 1);
  for (const l of lines) {
    assert.match(l, /curl -fs -o \/dev\/null/);
    assert.doesNotMatch(l, /curl -\w*S/);
    assert.match(l, /2>\/dev\/null/);
  }
});

test('script safety pieces are present', () => {
  assert.match(script, /trap 'on_err \$LINENO' ERR/);
  assert.match(script, /LOCK="\$R\/run\/mailloom-update\.lock"/);
  assert.match(script, /--no-same-owner --no-same-permissions/);
});

test('Discord payload: markdown and @ escaped, mentions off, at most 1900 characters', () => {
  const bs = String.fromCharCode(92);
  const p = JSON.parse(discordPayload('hi @everyone *bold* [a](b) _x_'));
  assert.deepEqual(p.allowed_mentions, { parse: [] });
  assert.ok(p.content.includes(bs + '@everyone') && p.content.includes(bs + '*bold' + bs + '*'));
  assert.ok(JSON.parse(discordPayload('x'.repeat(5000))).content.length <= 1900);
});

test('webhook is passed to curl on stdin, never on a command line; no email path is left', () => {
  const curls = script.split('\n').filter((l) => /\bcurl\b/.test(l) && !l.trim().startsWith('#'));
  for (const l of curls) assert.ok(!l.includes('$WEBHOOK') || l.includes('printf'), l);
  assert.match(script, /curl -fsS -K - --max-time 10/);
  assert.doesNotMatch(script, /sendmail|MAILLOOM_UPDATE_NOTIFY/i);
});
