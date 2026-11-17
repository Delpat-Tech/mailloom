#!/usr/bin/env bash
# End-to-end test of deploy/mailloom-update.sh in a sandbox. Linux only (run it in WSL or CI), as root.
#   bash scripts/test/update-e2e.sh
# Needs: node 22, curl, flock, tar, internet (reads the real GitHub API and downloads the latest release file, about 2 MB).
# Everything lives in a temp folder (MAILLOOM_UPDATE_ROOT); systemctl, journalctl, a fake Discord webhook server, and (for failure
# injection) cp and mv are stubs found through PATH. The real /opt, /var and /etc are never touched.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$HERE/../../deploy"
SCRIPT="$DEPLOY/mailloom-update.sh"
DECIDE="$DEPLOY/mailloom-update-decide.mjs"
REPO="Delpat-Tech/mailloom"
OLD="3ff0c2de13"   # a real commit that is an ancestor of every release since 2026-11-16d

[ "$(id -u)" = 0 ] || { echo "Run as root (the script installs files as root:www-data)."; exit 2; }
for c in node curl flock tar sha256sum; do command -v "$c" >/dev/null || { echo "Missing: $c"; exit 2; }; done

SB="$(mktemp -d /tmp/mailloom-e2e.XXXXXX)"
export STUB_DIR="$SB/stub"; mkdir -p "$STUB_DIR/bin" "$STUB_DIR/mail" "$SB/assets"
export MAILLOOM_UPDATE_ROOT="$SB/root" MAILLOOM_UPDATE_DECIDE="$DECIDE"
R="$MAILLOOM_UPDATE_ROOT"; APP="$R/opt/www/mailloom"; PREV="$R/opt/www/mailloom.prev"; STATE="$R/var/lib/mailloom-update"
MAIL="$STUB_DIR/mail"
export PATH="$STUB_DIR/bin:$PATH"
PASS=0; FAIL=0

cleanup() {
  [ -f "$STUB_DIR/pid" ] && kill "$(cat "$STUB_DIR/pid")" 2>/dev/null
  [ -n "${GP_PID:-}" ] && kill "$GP_PID" 2>/dev/null
  [ -n "${WH_PID:-}" ] && kill "$WH_PID" 2>/dev/null
  rm -rf "$SB"
}
trap cleanup EXIT

# ---- stubs -------------------------------------------------------------------------------------
cat >"$STUB_DIR/server.js" <<'EOF'
require('http').createServer((q, r) => { r.statusCode = q.url === '/api/auth/accounts' ? 200 : 404; r.end('ok'); }).listen(+process.argv[2], '127.0.0.1');
EOF
# A read-only caching stand-in for api.github.com (real answers, fetched once per path), so a full run stays far
# below GitHub's 60 unauthenticated requests per hour.
cat >"$STUB_DIR/ghproxy.js" <<'EOF'
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = process.argv[3];
http.createServer(async (q, r) => {
  const f = path.join(dir, crypto.createHash('sha1').update(q.url).digest('hex'));
  if (q.method !== 'GET') { r.statusCode = 405; return r.end(); }
  if (!fs.existsSync(f)) {
    const g = await fetch('https://api.github.com' + q.url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mailloom-e2e' } });
    const body = await g.text();
    if (g.status === 403 || g.status === 429) { r.statusCode = g.status; return r.end(body); }
    fs.writeFileSync(f, JSON.stringify({ status: g.status, body }));
  }
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  r.statusCode = c.status; r.setHeader('content-type', 'application/json'); r.end(c.body);
}).listen(+process.argv[2], '127.0.0.1');
EOF
cat >"$STUB_DIR/bin/systemctl" <<'EOF'
#!/bin/bash
APP="$MAILLOOM_UPDATE_ROOT/opt/www/mailloom"; PIDF="$STUB_DIR/pid"
alive() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }
case "$1" in
  is-active) alive ;;
  stop)
    [ -f "$STUB_DIR/slowstop" ] && sleep 4
    if alive; then kill "$(cat "$PIDF")"; for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do alive || break; sleep 0.1; done; fi
    rm -f "$PIDF"; exit 0 ;;
  start)
    alive && exit 0
    # A "bad build" never answers: anything whose VERSION is not the fake old one.
    if [ -f "$STUB_DIR/badbuild" ] && ! grep -q "^mailloom-$OLD_VERSION" "$APP/VERSION" 2>/dev/null; then exit 0; fi
    port="$(grep -E '^PORT=' "$APP/.env" | cut -d= -f2)"
    setsid nohup node "$STUB_DIR/server.js" "$port" >/dev/null 2>&1 </dev/null 9>&- &
    echo $! >"$PIDF"; sleep 0.3; exit 0 ;;
esac
exit 0
EOF
cat >"$STUB_DIR/bin/journalctl" <<'EOF'
#!/bin/bash
printf 'mailloom[1]: starting\nmailloom[1]: SESSION_SECRET=hunter2\nmailloom[1]: Error: boom\n'
EOF
# A fake Discord webhook: stores each post's text; anything that breaks the rules (mentions on, over 1900 characters) is stored as .bad.
cat >"$STUB_DIR/webhook.js" <<'EOF'
const http = require('http'), fs = require('fs');
let n = 0;
http.createServer((q, r) => {
  let b = '';
  q.on('data', (d) => (b += d));
  q.on('end', () => {
    let j = {}; try { j = JSON.parse(b); } catch (e) {}
    const ok = q.method === 'POST' && q.url === '/api/webhooks/123/abc_DEF-9' && typeof j.content === 'string' && j.content.length <= 1900
      && j.allowed_mentions && Array.isArray(j.allowed_mentions.parse) && j.allowed_mentions.parse.length === 0;
    fs.writeFileSync(process.argv[3] + '/' + Date.now() + '-' + (n++) + (ok ? '.msg' : '.bad'), ok ? j.content : b);
    r.statusCode = ok ? 204 : 400; r.end();
  });
}).listen(+process.argv[2], '127.0.0.1');
EOF
cat >"$STUB_DIR/bin/mv" <<'EOF'
#!/bin/bash
# failmv holds the suffix of the source path whose move must fail (.next = the swap, .prev = the rollback)
if [ -f "$STUB_DIR/failmv" ]; then case "${@: -2:1}" in *"$(cat "$STUB_DIR/failmv")") exit 1 ;; esac; fi
exec /bin/mv "$@"
EOF
cat >"$STUB_DIR/bin/rm" <<'EOF'
#!/bin/bash
if [ -f "$STUB_DIR/failrm" ]; then case "${@: -1}" in *.prev) exit 1 ;; esac; fi
exec /bin/rm "$@"
EOF
cat >"$STUB_DIR/bin/cp" <<'EOF'
#!/bin/bash
if [ -f "$STUB_DIR/failcp" ]; then case "${@: -1}" in *.next) exit 1 ;; esac; fi
exec /bin/cp "$@"
EOF
chmod +x "$STUB_DIR"/bin/*
export OLD_VERSION="$OLD"

WHPORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
mkdir -p "$STUB_DIR/mail"
node "$STUB_DIR/webhook.js" "$WHPORT" "$STUB_DIR/mail" & WH_PID=$!
WEBHOOK_URL="http://127.0.0.1:$WHPORT/api/webhooks/123/abc_DEF-9"
export MAILLOOM_UPDATE_WEBHOOK_RE="^http://127[.]0[.]0[.]1:[0-9]+/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$"
GPPORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
mkdir -p "$STUB_DIR/ghcache"
node "$STUB_DIR/ghproxy.js" "$GPPORT" "$STUB_DIR/ghcache" & GP_PID=$!
export MAILLOOM_UPDATE_TEST_API="http://127.0.0.1:$GPPORT"
sleep 0.5
PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"

# ---- helpers -----------------------------------------------------------------------------------
RUNID=0; SHOWN=-1
check() { # check "name" command...  (a failing check shows the output of the last run once)
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); echo "  ok    $name"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL  $name"
    if [ "$SHOWN" != "$RUNID" ]; then SHOWN=$RUNID; echo "        output was (exit ${RC:-?}):"; printf '%s\n' "${OUT:-}" | sed 's/^/        | /'; fi
  fi
}
has() { printf '%s' "$OUT" | grep -qF -- "$1"; }
hasnt() { ! printf '%s' "$OUT" | grep -qF -- "$1"; }
mails() { find "$MAIL" -name '*.msg' | wc -l; }
version() { head -1 "$APP/VERSION"; }
healthy() { curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/auth/accounts"; }
run() {
  RUNID=$((RUNID + 1)); OUT="$(bash "$SCRIPT" "$@" 2>&1)"; RC=$?
  case "$OUT" in *api/webhooks*|*abc_DEF*) check "the webhook address is never printed" false ;; esac
}
section() { echo; echo "== $1"; }

reset() {
  systemctl stop mailloom; rm -f "$STUB_DIR"/{badbuild,failmv,failcp,failrm,slowstop}
  rm -rf "$R" "$MAIL"; mkdir -p "$APP" "$R/usr/sbin" "$MAIL"; : >"$R/.mailloom-e2e"
  printf 'mailloom-%s\nbuilt test\n' "$OLD" >"$APP/VERSION"
  echo "// old" >"$APP/server.mjs"
  printf 'PORT=%s\nMAILLOOM_UPDATE_DISCORD_WEBHOOK=%s\nSESSION_SECRET=zzz\n' "$PORT" "$WEBHOOK_URL" >"$APP/.env"
  chmod 640 "$APP/.env"
  systemctl start mailloom
}

FAKE="${E2E_FAKE_GITHUB:-0}"   # 1 = no network: invented release data and a small invented release file (for debugging the harness)
if [ "$FAKE" = 1 ]; then
  LCOMMIT="aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd"; MAINSHA="1111111111111111111111111111111111111111"
  LTAG="v2099.01.01"; LNAME="mailloom-${LCOMMIT:0:10}.tar.gz"; LVER="${LNAME%.tar.gz}"
  mkdir -p "$SB/fake/$LVER" && echo x >"$SB/fake/$LVER/server.mjs" && echo x >"$SB/fake/$LVER/server.bundle.mjs" && echo "$LVER" >"$SB/fake/$LVER/VERSION"
  tar -czf "$SB/assets/$LNAME" -C "$SB/fake" "$LVER"
  LDIGEST="$(sha256sum "$SB/assets/$LNAME" | cut -d' ' -f1)"
  SB="$SB" LTAG="$LTAG" LNAME="$LNAME" LDIGEST="$LDIGEST" LCOMMIT="$LCOMMIT" MAINSHA="$MAINSHA" OLD="$OLD" REPO="$REPO" node -e '
    const fs = require("fs"), c = require("crypto"), e = process.env, d = e.STUB_DIR + "/ghcache/";
    const put = (u, o) => fs.writeFileSync(d + c.createHash("sha1").update(u).digest("hex"), JSON.stringify({ status: 200, body: JSON.stringify(o) }));
    const r = "/repos/" + e.REPO;
    put(r + "/releases/latest", { tag_name: e.LTAG, draft: false, prerelease: false, assets: [{ name: e.LNAME, id: 1, digest: "sha256:" + e.LDIGEST }] });
    put(r + "/git/ref/tags/" + e.LTAG, { object: { type: "commit", sha: e.LCOMMIT } });
    put(r + "/git/ref/heads/main", { object: { type: "commit", sha: e.MAINSHA } });
    put(r + "/compare/" + e.LCOMMIT + "..." + e.MAINSHA + "?per_page=1", { status: "ahead" });
    put(r + "/compare/" + e.OLD + "..." + e.LCOMMIT + "?per_page=1", { status: "ahead" });'
  LID=1
else
  # What does GitHub say is the latest release? (read-only; also fills the test cache)
  IFS=$'	' read -r _ _ LTAG LCOMMIT LNAME LID LDIGEST _ < <(node "$DECIDE" "$REPO" latest - "" "")
  [ "$LNAME" != "-" ] || { echo "Could not read the latest release from GitHub."; exit 2; }
  curl -fsSL -H "Accept: application/octet-stream" -o "$SB/assets/$LNAME" "https://api.github.com/repos/$REPO/releases/assets/$LID" || { echo "Download failed."; exit 2; }
  [ "$(sha256sum "$SB/assets/$LNAME" | cut -d' ' -f1)" = "$LDIGEST" ] || { echo "Cached download has the wrong checksum."; exit 2; }
fi
echo "Latest release: $LTAG ($LNAME, commit ${LCOMMIT:0:10})"
CACHED="$SB/assets/$LNAME"
LVER="${LNAME%.tar.gz}"

# ---- (a) --check -------------------------------------------------------------------------------
section "(a) --check changes nothing"
reset; before="$(find "$R/opt" | sort | xargs sha256sum 2>/dev/null | sha256sum)"
run --auto --check
check "exit 0" test "$RC" = 0
check "says what it would install" has "Would install $LTAG"
check "says nothing changed" has "Nothing changed"
check "files untouched" test "$(find "$R/opt" | sort | xargs sha256sum 2>/dev/null | sha256sum)" = "$before"
check "no message" test "$(mails)" = 0
check "no previous copy" test ! -e "$PREV"
check "version unchanged" test "$(version)" = "mailloom-$OLD"

# ---- (b) fresh install, real download ----------------------------------------------------------
section "(b) install from an older version (real download)"
if [ "$FAKE" = 1 ]; then reset; MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run --auto; else reset; run --auto; fi
echo "$OUT" | sed 's/^/        | /'
check "exit 0" test "$RC" = 0
check "prints Installing and Done" bash -c 'printf "%s" "$0" | grep -q "^Installing" && printf "%s" "$0" | grep -q "^Done"' "$OUT"
check "version is the release" test "$(version)" = "$LVER"
check "service answers" healthy
check "previous version kept" test "$(head -1 "$PREV/VERSION")" = "mailloom-$OLD"
check ".env carried over, mode 640" bash -c 'grep -q "^PORT=$0" "$1/.env" && test "$(stat -c %a "$1/.env")" = 640 && test "$(stat -c %G "$1/.env")" = www-data' "$PORT" "$APP"
check "one message: updated" bash -c 'test "$(find "$0" -name "*.msg" | wc -l)" = 1 && cat "$0"/*.msg | grep -q "Mailloom update: updated to '"$LTAG"' (healthy)"' "$MAIL"
check "message has no .env contents" bash -c '! cat "$0"/*.msg | grep -q "SESSION_SECRET\|zzz"' "$MAIL"
check "no curl noise" hasnt "curl:"
check "no 'Failed' noise" hasnt "Failed"
check "skip cleared" test ! -e "$STATE/skip"

# ---- (c) auto again ----------------------------------------------------------------------------
section "(c) --auto again"
run --auto
check "exit 0" test "$RC" = 0
check "already running" has "already running $LTAG"
check "no new message" test "$(mails)" = 1
check "output is one line" test "$(printf '%s\n' "$OUT" | wc -l)" = 1

# ---- (d) health failure ------------------------------------------------------------------------
section "(d) health failure rolls back"
reset; touch "$STUB_DIR/badbuild"
MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run --auto
echo "$OUT" | sed 's/^/        | /'
check "exit 1" test "$RC" = 1
check "says it put the previous one back" has "Previous version is running again."
check "version back to old" test "$(version)" = "mailloom-$OLD"
check "service answers" healthy
check "skip file names the release" test "$(cat "$STATE/skip")" = "$LNAME"
check "message: rolled back" bash -c 'grep -q "Mailloom update: failed, rolled back to mailloom-'"$OLD"'" "$0"/*.msg' "$MAIL"
check "secret line not shown" hasnt "hunter2"
check "no log lines in the message" bash -c '! grep -q "boom\|starting" "$0"/*.msg' "$MAIL"
rm -f "$STUB_DIR/badbuild"; n="$(mails)"
MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run --auto
check "next --auto: exit 0, nothing installed" test "$RC" = 0 -a "$(version)" = "mailloom-$OLD"
check "next --auto: says it is skipped" has "not tried again"
check "skip noted by one message only" test "$(mails)" = "$((n + 1))"
run --auto
check "third --auto: no more message" test "$(mails)" = "$((n + 1))"

# ---- (e) rollback ------------------------------------------------------------------------------
section "(e) --rollback"
reset; MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run
check "manual install ok" test "$RC" = 0 -a "$(version)" = "$LVER"
run --rollback
check "rollback exit 0" test "$RC" = 0
check "back to old" test "$(version)" = "mailloom-$OLD"
check "service answers" healthy
check "skip written" test "$(cat "$STATE/skip")" = "$LNAME"
check "message: rolled back" bash -c 'grep -q "Mailloom update: rolled back to mailloom-'"$OLD"' (healthy)" "$0"/*.msg' "$MAIL"
run --auto
check "--auto does not undo the rollback" test "$RC" = 0 -a "$(version)" = "mailloom-$OLD"
MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run
check "manual install clears the skip" test "$RC" = 0 -a ! -e "$STATE/skip" -a "$(version)" = "$LVER"

# ---- (f) tampered tarballs ---------------------------------------------------------------------
section "(f) tampered release files are refused"
mk() { # mk kind -> file
  local d="$SB/t-$1"; rm -rf "$d"; mkdir -p "$d/${LVER}"
  echo x >"$d/$LVER/server.mjs"; echo x >"$d/$LVER/server.bundle.mjs"; echo "$LVER" >"$d/$LVER/VERSION"
  case "$1" in
    symlink) ln -s /etc/passwd "$d/$LVER/evil"; tar -czf "$SB/assets/t-$1.tgz" -C "$d" "$LVER" ;;
    hardlink) ln "$d/$LVER/server.mjs" "$d/$LVER/hard"; tar -czf "$SB/assets/t-$1.tgz" -C "$d" "$LVER" ;;
    dotdot) mkdir -p "$d/x"; echo pwn >"$d/x/f"; tar -czf "$SB/assets/t-$1.tgz" -C "$d" "$LVER" --transform 's,^x/,../x/,' "x/f" ;;
    absolute) echo pwn >"$d/abs"; tar -czPf "$SB/assets/t-$1.tgz" -C "$d" "$LVER" "$d/abs" ;;
    elsewhere) mkdir -p "$d/other"; echo x >"$d/other/f"; tar -czf "$SB/assets/t-$1.tgz" -C "$d" "$LVER" other ;;
  esac
}
for kind in symlink hardlink dotdot absolute elsewhere; do
  mk "$kind"; reset
  MAILLOOM_UPDATE_ASSET_FILE="$SB/assets/t-$kind.tgz" run --auto
  check "$kind: refused (exit 1)" test "$RC" = 1
  check "$kind: says why" bash -c 'printf "%s" "$0" | grep -q "links or special files\|outside its own folder"' "$OUT"
  check "$kind: nothing changed" test "$(version)" = "mailloom-$OLD" -a ! -e "$PREV" -a ! -e "$R/opt/www/mailloom.next"
  check "$kind: service still answers" healthy
  check "$kind: message says failed before installing" bash -c 'grep -q "Mailloom update: failed before installing" "$0"/*.msg' "$MAIL"
  check "$kind: nothing escaped the sandbox" test ! -e /tmp/pwn -a ! -e "$SB/x/f"
done

# ---- (g) failures during the install -----------------------------------------------------------
section "(g) an error in the middle of the swap restores the previous version"
reset; echo .next >"$STUB_DIR/failmv"
MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run --auto
echo "$OUT" | sed 's/^/        | /'
rm -f "$STUB_DIR/failmv"
check "exit 1" test "$RC" = 1
check "says it stopped" has "unexpected error at line"
check "old version is back" test "$(version)" = "mailloom-$OLD"
check "service answers" healthy
check "message: aborted" bash -c 'grep -q "Mailloom update: aborted at line" "$0"/*.msg && grep -q "previous version is running again" "$0"/*.msg' "$MAIL"
check "release will not be retried" test "$(cat "$STATE/skip")" = "$LNAME"

section "(g2) a failed copy before the swap changes nothing"
reset; touch "$STUB_DIR/failcp"
MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run --auto
rm -f "$STUB_DIR/failcp"
check "exit 1" test "$RC" = 1
check "old version still in place" test "$(version)" = "mailloom-$OLD" -a ! -e "$PREV"
check "service answers" healthy
check "message: aborted" bash -c 'grep -q "Mailloom update: aborted at line" "$0"/*.msg' "$MAIL"

# ---- (i) S1: the old copy cannot be deleted ----------------------------------------------------
section "(i) a failure while clearing the old backup leaves the running version untouched"
reset; mkdir -p "$PREV"; echo older >"$PREV/VERSION"; touch "$STUB_DIR/failrm"
MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run --auto
rm -f "$STUB_DIR/failrm"
check "exit 1" test "$RC" = 1
check "running version never moved" test "$(version)" = "mailloom-$OLD" -a ! -e "$APP.bad"
check "service answers" healthy
check "old backup still there" test "$(cat "$PREV/VERSION")" = older
check "message: aborted" bash -c 'grep -q "Mailloom update: aborted at line" "$0"/*.msg' "$MAIL"
check "no skip written (nothing was tried)" test ! -e "$STATE/skip"

# ---- (j) S2: a failed manual install keeps the do-not-retry mark ---------------------------------
section "(j) the skip mark is only cleared by a healthy install"
reset; mkdir -p "$STATE"; echo mailloom-0000000000.tar.gz >"$STATE/skip"; touch "$STUB_DIR/failcp"
MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run
rm -f "$STUB_DIR/failcp"
check "manual install failed" test "$RC" = 1
check "skip mark still there" test "$(cat "$STATE/skip")" = mailloom-0000000000.tar.gz
MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run
check "healthy manual install clears it" test "$RC" = 0 -a ! -e "$STATE/skip"

# ---- (k) S3: --rollback fails half-way ------------------------------------------------------------
section "(k) a failed --rollback puts the running version back"
reset; MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run
echo .prev >"$STUB_DIR/failmv"; run --rollback
rm -f "$STUB_DIR/failmv"
check "exit 1" test "$RC" = 1
check "the version that was running is back" test "$(version)" = "$LVER" -a ! -e "$APP.bad"
check "service answers" healthy
check "message says aborted and put back" bash -c 'grep -q "Mailloom update: aborted at line" "$0"/*.msg && grep -q "put back from" "$0"/*.msg' "$MAIL"

# ---- (l) the test overrides are refused outside the harness ---------------------------------------
section "(l) test overrides are refused outside the harness"
mkdir -p "$SB/nomarker"
refused() { [ "$RC" = 1 ] && has "only accepted by the test harness"; }
OUT="$(MAILLOOM_UPDATE_ROOT="$SB/nomarker" bash "$SCRIPT" --check 2>&1)"; RC=$?
check "folder without marker refused" refused
OUT="$(MAILLOOM_UPDATE_ROOT=/ bash "$SCRIPT" --check 2>&1)"; RC=$?
check "root / refused" refused
OUT="$(INVOCATION_ID=abc bash "$SCRIPT" --check 2>&1)"; RC=$?
check "refused under systemd" refused
OUT="$(env -u MAILLOOM_UPDATE_ROOT bash "$SCRIPT" --check 2>&1)"; RC=$?
check "helper override without a root refused" refused

# ---- (m) webhook rules -----------------------------------------------------------------------------
section "(m) an invalid webhook is refused and never printed; posts follow the rules"
reset; sed -i 's#^MAILLOOM_UPDATE_DISCORD_WEBHOOK=.*#MAILLOOM_UPDATE_DISCORD_WEBHOOK=https://evil.example/api/webhooks/1/secrettoken#' "$APP/.env"
MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run --auto
check "says webhook not valid" has "webhook not valid"
check "does not print the bad value" hasnt "evil.example"
check "update still happened" test "$RC" = 0 -a "$(version)" = "$LVER"
check "nothing posted" test "$(mails)" = 0
reset; MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run --auto
check "all posts accepted by the fake Discord (no mentions, short)" test -z "$(find "$MAIL" -name '*.bad')"
check "a post carries the prefix" bash -c 'grep -q "^Mailloom update: updated to" "$0"/*.msg' "$MAIL"
kill "$WH_PID" 2>/dev/null; wait "$WH_PID" 2>/dev/null
reset; MAILLOOM_UPDATE_ASSET_FILE="$CACHED" run --auto
check "an unreachable Discord does not break the update" test "$RC" = 0 -a "$(version)" = "$LVER"
node "$STUB_DIR/webhook.js" "$WHPORT" "$STUB_DIR/mail" & WH_PID=$!
sleep 0.5

# ---- (h) lock ----------------------------------------------------------------------------------
section "(h) two runs at once"
reset; touch "$STUB_DIR/slowstop"
( MAILLOOM_UPDATE_ASSET_FILE="$CACHED" bash "$SCRIPT" --auto >"$SB/a.out" 2>&1; echo $? >"$SB/a.rc" ) &
APID=$!
sleep 1.5
run --auto
check "second (auto) exits 0 cleanly" test "$RC" = 0
check "second says another is running" has "Another mailloom-update is running."
run
check "second (manual) exits 1" test "$RC" = 1
wait "$APID"
rm -f "$STUB_DIR/slowstop"
check "first finished fine" test "$(cat "$SB/a.rc")" = 0 -a "$(version)" = "$LVER"
check "only one message" test "$(mails)" = 1

echo
echo "Passed: $PASS   Failed: $FAIL"
[ "$FAIL" = 0 ]
