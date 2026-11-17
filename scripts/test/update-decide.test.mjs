import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decide, resolveTagToCommit, toLine, GithubError } from '../../deploy/mailloom-update-decide.mjs';

const SHA = 'a'.repeat(10) + 'b'.repeat(30);
const asset = { name: `mailloom-${SHA.slice(0, 10)}.tar.gz`, id: 7, digest: 'sha256:' + 'c'.repeat(64) };
const release = (o = {}) => ({ tag_name: 'v2026.11.18', draft: false, prerelease: false, assets: [asset], ...o });

// Stub: maps path fragments to answers ('ERR' throws like a failed request).
function stub(map) {
  return async (p) => {
    for (const [k, v] of Object.entries(map)) {
      if (p.includes(k)) {
        if (v === 'ERR') throw new GithubError('GitHub answered 500.');
        return v;
      }
    }
    throw new GithubError('unexpected ' + p);
  };
}
const ref = { object: { type: 'commit', sha: SHA } };
const base = { repo: 'o/r', tag: 'v2026.11.18', installed: 'mailloom-old' };
const good = { '/releases/latest': release(), '/releases/tags/': release(), '/git/ref/': ref, '/compare/': { status: 'ahead' } };

test('on main (ahead) -> install', async () => {
  const d = await decide({ ...base, mode: 'auto', get: stub(good) });
  assert.equal(d.action, 'install');
  assert.equal(d.commit, SHA);
});

test('on main (identical) -> install', async () => {
  const d = await decide({ ...base, mode: 'tag', get: stub({ ...good, '/compare/': { status: 'identical' } }) });
  assert.equal(d.action, 'install');
});

for (const status of ['diverged', 'behind', undefined]) {
  test(`not on main (${status}) -> refuse`, async () => {
    const d = await decide({ ...base, mode: 'tag', get: stub({ ...good, '/compare/': { status } }) });
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
  const bad = await decide({ ...base, mode: 'prerelease', get: stub({ ...good, '/releases/tags/': pre, '/compare/': { status: 'diverged' } }) });
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

for (const where of ['/releases/latest', '/git/ref/', '/compare/']) {
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
  const d = await decide({ ...base, mode: 'auto', get: stub({ ...good, '/git/ref/': badRef }) });
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
