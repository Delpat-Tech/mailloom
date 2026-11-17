#!/usr/bin/env bash
# Update Mailloom on the live server to a GitHub release. Only releases whose commit is on main are ever installed.
#   sudo mailloom-update                          latest release
#   sudo mailloom-update v2026.11.16              that release (may be older: going back is allowed by hand)
#   sudo mailloom-update --allow-prerelease TAG   a release marked pre-release (its commit must still be on main)
#   sudo mailloom-update --check [TAG]            report what would happen; installs nothing
#   sudo mailloom-update --auto                   what the nightly timer runs: quiet when there is nothing new,
#                                                 never goes backwards, never retries a rolled-back or failed release
#   sudo mailloom-update --rollback               put the previous version back
# Layout: systemd unit "mailloom", app in /opt/www/mailloom (with its .env), previous version in /opt/www/mailloom.prev.
# State (root only): /var/lib/mailloom-update. This script does not update itself: see docs/deploy.md section 8b.
# Discord: set MAILLOOM_UPDATE_DISCORD_WEBHOOK=<webhook url> in /opt/www/mailloom/.env to get a short note after any
# install, rollback, refusal or failure (never when there was nothing new, never any .env contents or log lines, and
# the webhook address itself is never printed).
set -Eeuo pipefail

REPO="Delpat-Tech/mailloom"
# MAILLOOM_UPDATE_ROOT moves every path under a test folder (scripts/test/update-e2e.sh). It is empty on the server.
R="${MAILLOOM_UPDATE_ROOT:-}"
# The test overrides are refused anywhere but the harness: not "/", not under systemd, and only in a folder the harness marked.
if [ -n "$R" ] || [ -n "${MAILLOOM_UPDATE_DECIDE:-}" ] || [ -n "${MAILLOOM_UPDATE_ASSET_FILE:-}" ] || [ -n "${MAILLOOM_UPDATE_TEST_API:-}" ] || [ -n "${MAILLOOM_UPDATE_WEBHOOK_RE:-}" ]; then
  if [ -z "$R" ] || [ "$R" = "/" ] || [ -n "${INVOCATION_ID:-}" ] || [ ! -f "$R/.mailloom-e2e" ]; then
    echo "Test overrides (MAILLOOM_UPDATE_*) are only accepted by the test harness. Nothing changed."; exit 1
  fi
fi
APP="$R/opt/www/mailloom"
PREV="$R/opt/www/mailloom.prev"
NEXT="$R/opt/www/mailloom.next"
STATE="$R/var/lib/mailloom-update"
DECIDE="${MAILLOOM_UPDATE_DECIDE:-$R/usr/local/lib/mailloom/update-decide.mjs}"
LOCK="$R/run/mailloom-update.lock"
PORT="$(grep -E '^PORT=' "$APP/.env" 2>/dev/null | cut -d= -f2 || true)"; PORT="${PORT:-3000}"

[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js was not found in PATH ($PATH). It is needed to check releases. Nothing changed."; exit 1; }

# ---- arguments ---------------------------------------------------------------------------------
AUTO=0; CHECK=0; ROLLBACK=0; PRE=0; TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --auto) AUTO=1 ;;
    --check) CHECK=1 ;;
    --rollback) ROLLBACK=1 ;;
    --allow-prerelease) PRE=1 ;;
    -*) echo "Unknown option: $1"; exit 1 ;;
    *) [ -z "$TAG" ] || { echo "Only one release tag, please."; exit 1; }; TAG="$1" ;;
  esac
  shift
done
if [ "$PRE" = 1 ] && [ -z "$TAG" ]; then echo "--allow-prerelease needs a tag, for example: --allow-prerelease v2026.11.16"; exit 1; fi
if [ "$AUTO" = 1 ] && { [ -n "$TAG" ] || [ "$ROLLBACK" = 1 ] || [ "$PRE" = 1 ]; }; then echo "--auto takes no tag and no other mode."; exit 1; fi

install -d -m 0700 -o root -g root "$STATE"
[ -z "$R" ] || mkdir -p "$(dirname "$LOCK")"

# ---- one update at a time (the timer and a manual run never overlap) ---------------------------
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Another mailloom-update is running."
  [ "$AUTO" = 1 ] && exit 0
  exit 1
fi

# ---- helpers -----------------------------------------------------------------------------------
# One redaction for everything that is shown or posted: lines that look like secrets are dropped.
redact() { grep -iv 'secret\|password\|token\|authorization\|cookie\|key\|webhook' || true; }

WEBHOOK="$(grep -E '^MAILLOOM_UPDATE_DISCORD_WEBHOOK=' "$APP/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
WEBHOOK_RE='^https://(discord\.com|discordapp\.com)/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$'
[ -z "${MAILLOOM_UPDATE_WEBHOOK_RE:-}" ] || WEBHOOK_RE="$MAILLOOM_UPDATE_WEBHOOK_RE"   # tests only (guarded above)
if [ -n "$WEBHOOK" ] && ! [[ "$WEBHOOK" =~ $WEBHOOK_RE ]]; then echo "webhook not valid"; WEBHOOK=""; fi

# notify "subject" "body text": one short plain-text Discord post. Never fails the update, never prints the webhook.
notify() {
  [ "$CHECK" = 0 ] && [ -n "$WEBHOOK" ] || return 0
  local s="${1#Mailloom }" body tmp
  s="${s#update }"
  body="$(printf 'Mailloom update: %s\n%s\nTime: %s\nServer: %s' "$s" "$(printf '%s\n' "$2" | redact)" "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$(hostname)")"
  tmp="$(mktemp)"
  if printf '%s' "$body" | "$NODE" "$DECIDE" --payload >"$tmp" 2>/dev/null; then
    # The address goes to curl on stdin (-K -), so it never appears in the process list.
    printf 'url = "%s"\n' "$WEBHOOK" | curl -fsS -K - --max-time 10 -H 'Content-Type: application/json' --data-binary "@$tmp" -o /dev/null >/dev/null 2>&1 \
      || echo "(the Discord notice could not be sent)" >&2
  fi
  rm -f "$tmp"
}

# State kept between runs (root only): the release not to retry, the failed-check count, the last refusal posted.
skip_get() {
  local v=""
  [ -f "$STATE/skip" ] && [ ! -L "$STATE/skip" ] && v="$(head -1 "$STATE/skip" 2>/dev/null || true)"
  [[ "$v" =~ ^mailloom-[0-9a-f]{10,40}\.tar\.gz$ ]] && printf '%s' "$v" || true
}
skip_set() { printf '%s\n' "$1" >"$STATE/skip"; rm -f "$STATE/skip.notified"; }
skip_clear() { rm -f "$STATE/skip" "$STATE/skip.notified"; }

healthy() {
  for _ in $(seq 1 15); do
    if systemctl is-active --quiet mailloom && curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/auth/accounts" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

# Puts the previous version back (also from a half-finished swap) and starts the service.
restore_previous() {
  systemctl stop mailloom || true
  if [ -d "$PREV" ]; then
    rm -rf "$APP.bad"
    [ ! -e "$APP" ] || mv "$APP" "$APP.bad"
    mv "$PREV" "$APP"
  fi
  systemctl start mailloom || true
}

CUR="$(head -1 "$APP/VERSION" 2>/dev/null || echo unknown)"
RTAG="-"; NAME=""; WORK=""; STAGE=pre   # STAGE: pre -> stopping -> swapping -> swapped -> restoring; rollback for --rollback

on_exit() { [ -z "$WORK" ] || rm -rf "$WORK"; }
trap on_exit EXIT

# Any command that fails unexpectedly lands here: undo a half-done swap, tell Om, stop.
on_err() {
  local line="$1" what
  trap - ERR
  set +e
  echo "Update stopped by an unexpected error at line $line."
  what="The update stopped by an unexpected error at line $line. Release: $RTAG. Running before: $CUR."
  case "$STAGE" in
    stopping) systemctl start mailloom || true ;;
    restoring)
      # The restore itself failed part-way: do not run it twice.
      what="$what The automatic restore failed part-way. Check the server now: ls /opt/www and journalctl -u mailloom -n 30." ;;
    rollback)
      if [ ! -e "$APP" ] && [ -d "$APP.bad" ]; then
        mv "$APP.bad" "$APP" && what="$what The version that was running was put back from $APP.bad."
      fi
      systemctl start mailloom || true
      if healthy; then what="$what The service is answering."; else what="$what The service is NOT answering: check the server now."; fi
      ;;
    swapping | swapped)
      STAGE=restoring
      restore_previous
      if healthy; then what="$what The previous version is running again."; else what="$what The service is NOT answering: check the server now."; fi
      [ -z "$NAME" ] || skip_set "$NAME"
      ;;
  esac
  notify "Mailloom update aborted at line $line" "$what See: journalctl -u mailloom -n 30"
  exit 1
}
trap 'on_err $LINENO' ERR

# ---- rollback ----------------------------------------------------------------------------------
if [ "$ROLLBACK" = 1 ]; then
  [ -d "$PREV" ] || { echo "No previous version in $PREV."; exit 1; }
  if [ "$CHECK" = 1 ]; then echo "Would put back: $(head -1 "$PREV/VERSION" 2>/dev/null) (running now: $CUR). Nothing changed."; exit 0; fi
  STAGE=rollback
  systemctl stop mailloom || true
  rm -rf "$APP.bad"; mv "$APP" "$APP.bad"; mv "$PREV" "$APP"
  systemctl start mailloom || true
  STAGE=pre
  # The nightly run must not put the version that was just rolled back from straight back.
  [[ "$CUR" =~ ^mailloom-[0-9a-f]{10,40}$ ]] && skip_set "$CUR.tar.gz"
  NOW="$(head -1 "$APP/VERSION" 2>/dev/null || echo unknown)"
  if healthy; then
    echo "Rolled back. Running: $NOW"
    notify "Mailloom rolled back to $NOW (healthy)" "Rolled back by hand from $CUR to $NOW. The nightly update will not install $CUR again unless you do it by hand."
    exit 0
  fi
  echo "Rolled back but not answering; check: journalctl -u mailloom -n 30"
  notify "Mailloom rolled back to $NOW but is not answering" "Rolled back from $CUR to $NOW; the service is not answering. See: journalctl -u mailloom -n 30"
  exit 1
fi

# ---- decide: is there a release, and is it on main? --------------------------------------------
if [ "$AUTO" = 1 ]; then MODE=auto
elif [ "$PRE" = 1 ]; then MODE=prerelease
elif [ -n "$TAG" ]; then MODE=tag
elif [ "$CHECK" = 1 ]; then MODE=auto   # a manual check with no tag behaves like the nightly run
else MODE=latest; fi

DECISION="$("$NODE" "$DECIDE" "$REPO" "$MODE" "$CUR" "$TAG" "$(skip_get)" || true)"
ACTION=""; CODE=""; COMMIT=""; ID=""; DIGEST=""; MSG=""
IFS=$'\t' read -r ACTION CODE RTAG COMMIT NAME ID DIGEST MSG <<<"$DECISION" || true
[ "$NAME" != "-" ] || NAME=""
if [ -z "$ACTION" ]; then ACTION=error; MSG="The decision helper gave no answer ($DECIDE)."; RTAG="-"; fi

# Repeated identical news is mailed once: a failed check only on the second night in a row, a refusal once per release.
if [ "$ACTION" = error ] && [ "$AUTO" = 1 ]; then
  N="$(cat "$STATE/check-failures" 2>/dev/null || echo 0)"; [[ "$N" =~ ^[0-9]+$ ]] || N=0
  N=$((N + 1)); echo "$N" >"$STATE/check-failures"
else
  rm -f "$STATE/check-failures"
fi
if [ "$ACTION" != refuse ]; then rm -f "$STATE/last-refusal"; fi

case "$ACTION" in
  noop)
    echo "$MSG"
    if [ "$CODE" = skipped ] && [ "$CHECK" = 0 ] && [ ! -e "$STATE/skip.notified" ]; then
      notify "Mailloom $RTAG not installed (rolled back or failed earlier)" "$MSG Running now: $CUR"
      : >"$STATE/skip.notified"
    fi
    exit 0 ;;
  refuse)
    echo "Not installing: $MSG"
    if [ "$CODE" = not_on_main ]; then SUBJ="Mailloom skipped $RTAG: not on main"; else SUBJ="Mailloom skipped $RTAG: $CODE"; fi
    if [ "$AUTO" = 1 ] && [ "$CHECK" = 0 ]; then
      [ "$(cat "$STATE/last-refusal" 2>/dev/null || true)" != "$RTAG:$CODE" ] || exit 1
      printf '%s' "$RTAG:$CODE" >"$STATE/last-refusal"
    fi
    notify "$SUBJ" "$MSG
Running now: $CUR"
    exit 1 ;;
  error)
    echo "Could not check for a release: $MSG Nothing changed."
    [ "$AUTO" = 1 ] && [ "${N:-0}" = 2 ] && notify "Mailloom update check failed (2 nights running)" "$MSG Nothing was changed. Running now: $CUR"
    exit 1 ;;
  install) ;;
  *) echo "Unexpected answer from the decision helper. Nothing changed."; exit 1 ;;
esac

# The helper's fields are checked again here before they are used in a download or a path.
[[ "$NAME" =~ ^mailloom-[0-9a-f]{10,40}\.tar\.gz$ ]] && [[ "$ID" =~ ^[0-9]+$ ]] && [[ "$DIGEST" =~ ^[0-9a-f]{64}$ ]] \
  && [[ "$RTAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] \
  || { echo "The release details look wrong. Nothing changed."; exit 1; }

if [ "$CHECK" = 1 ]; then
  echo "Would install $RTAG ($NAME, commit ${COMMIT:0:10}), which is on main. Running now: $CUR. Nothing changed."
  exit 0
fi

echo "Installing $RTAG ($NAME). Running now: $CUR"

# ---- download and verify -----------------------------------------------------------------------
WORK="$(mktemp -d)"
fail_early() { echo "$1 Nothing changed."; notify "Mailloom update failed before installing $RTAG" "$1 Nothing was changed. Running now: $CUR"; exit 1; }
if [ -n "$R" ] && [ -n "${MAILLOOM_UPDATE_ASSET_FILE:-}" ]; then
  # Tests only (needs MAILLOOM_UPDATE_ROOT): use a prepared file instead of the download.
  cp "$MAILLOOM_UPDATE_ASSET_FILE" "$WORK/$NAME"
  DIGEST="$(sha256sum "$WORK/$NAME" | cut -d' ' -f1)"
else
  curl -fsSL --max-time 300 -H "Accept: application/octet-stream" -o "$WORK/$NAME" "https://api.github.com/repos/$REPO/releases/assets/$ID" \
    || fail_early "Could not download the release file."
fi
GOT="$(sha256sum "$WORK/$NAME" | cut -d' ' -f1)"
if [ "$GOT" != "$DIGEST" ]; then
  echo "Checksum does not match GitHub's. Nothing changed."
  notify "Mailloom skipped $RTAG: checksum mismatch" "The downloaded file's checksum does not match GitHub's. Nothing was changed. Running now: $CUR"
  exit 1
fi

# Look inside before unpacking: only plain files and folders under one folder named after the release.
PFX="${NAME%.tar.gz}"
tar -tzf "$WORK/$NAME" >"$WORK/names" || fail_early "The release file cannot be read."
tar -tvzf "$WORK/$NAME" | cut -c1 >"$WORK/types" || fail_early "The release file cannot be read."
if [ ! -s "$WORK/names" ] || grep -qvE "^$PFX(/.*)?\$" "$WORK/names" || grep -qE '(^|/)\.\.(/|$)' "$WORK/names" || grep -q '^/' "$WORK/names"; then
  fail_early "The release file has paths outside its own folder."
fi
if grep -qv '^[-d]$' "$WORK/types"; then fail_early "The release file contains links or special files."; fi

mkdir "$WORK/x"
tar -xzf "$WORK/$NAME" -C "$WORK/x" --no-same-owner --no-same-permissions
chmod -R u+rwX,g+rX,o+rX,go-w "$WORK/x"
[ -z "$(find "$WORK/x" ! -type f ! -type d -print -quit)" ] || fail_early "The unpacked release contains links or special files."
DIR="$WORK/x/$PFX"
[ -f "$DIR/server.mjs" ] && [ -f "$DIR/server.bundle.mjs" ] || fail_early "Release file is incomplete."
{ [ -f "$APP/.env" ] && [ ! -L "$APP/.env" ]; } || fail_early "$APP/.env is missing or is a link."

# ---- swap, health-check, roll back on failure --------------------------------------------------
rm -rf "$NEXT"; cp -a "$DIR" "$NEXT"
rm -f "$NEXT/.env"
chown -R --no-dereference root:www-data "$NEXT"
install -m 640 -o root -g www-data "$APP/.env" "$NEXT/.env"

STAGE=stopping
systemctl stop mailloom
rm -rf "$PREV"   # still "stopping": if this fails, the old version is untouched and is simply started again
STAGE=swapping
mv "$APP" "$PREV"; mv "$NEXT" "$APP"
STAGE=swapped
systemctl start mailloom || true

if healthy; then
  STAGE=pre
  skip_clear
  echo "Done. Running $RTAG. Previous version kept for: sudo mailloom-update --rollback"
  notify "Mailloom updated to $RTAG (healthy)" "Updated from $CUR to $RTAG ($NAME). The service is answering. Roll back with: sudo mailloom-update --rollback"
else
  echo "New version did not start; putting the previous one back."
  journalctl -u mailloom -n 15 --no-pager 2>/dev/null | redact || true
  STAGE=restoring
  restore_previous
  STAGE=pre
  skip_set "$NAME"
  if healthy; then
    echo "Previous version is running again."
    notify "Mailloom update failed, rolled back to $CUR" "$RTAG did not start. The previous version ($CUR) is running again and $RTAG will not be tried again automatically. See: journalctl -u mailloom -n 30"
  else
    echo "Previous version is not answering either; check: journalctl -u mailloom -n 30"
    notify "Mailloom update failed and the service is not answering" "$RTAG did not start and the previous version ($CUR) is not answering either. Check the server now: journalctl -u mailloom -n 30"
  fi
  exit 1
fi
