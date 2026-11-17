#!/usr/bin/env bash
# Update Mailloom on the live server to a GitHub release. Only releases whose commit is on main are ever installed.
#   sudo mailloom-update                          latest release
#   sudo mailloom-update v2026.11.16              that release
#   sudo mailloom-update --allow-prerelease TAG   a release marked pre-release (its commit must still be on main)
#   sudo mailloom-update --check [TAG]            report what would happen; installs nothing
#   sudo mailloom-update --auto                   what the nightly timer runs: quiet when there is nothing new
#   sudo mailloom-update --rollback               put the previous version back
# Layout: systemd unit "mailloom", app in /opt/www/mailloom (with its .env), previous version in /opt/www/mailloom.prev.
# Email: set MAILLOOM_UPDATE_NOTIFY=address in /opt/www/mailloom/.env to get a short note after any install,
# rollback, refusal or failure (never when there was nothing new, and never any .env contents).
set -euo pipefail

REPO="Delpat-Tech/mailloom"
APP="/opt/www/mailloom"
PREV="/opt/www/mailloom.prev"
NEXT="/opt/www/mailloom.next"
DECIDE="${MAILLOOM_UPDATE_DECIDE:-/usr/local/lib/mailloom/update-decide.mjs}"
LOCK="/run/lock/mailloom-update.lock"
PORT="$(grep -E '^PORT=' "$APP/.env" 2>/dev/null | cut -d= -f2 || true)"; PORT="${PORT:-3000}"

[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }

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

# ---- one update at a time (the timer and a manual run never overlap) ---------------------------
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Another mailloom-update is running."
  [ "$AUTO" = 1 ] && exit 0
  exit 1
fi

# ---- email report ------------------------------------------------------------------------------
NOTIFY="$(grep -E '^MAILLOOM_UPDATE_NOTIFY=' "$APP/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
[[ "$NOTIFY" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || NOTIFY=""

# notify "subject" "body text" [with-log]. Never fails the update.
notify() {
  [ "$CHECK" = 0 ] && [ -n "$NOTIFY" ] && [ -x /usr/sbin/sendmail ] || return 0
  {
    printf 'To: %s\nFrom: Mailloom updater <root@%s>\nSubject: %s\nDate: %s\n' \
      "$NOTIFY" "$(hostname -f 2>/dev/null || hostname)" "$1" "$(date -R)"
    printf 'Content-Type: text/plain; charset=utf-8\n\n%s\n' "$2"
    printf '\nTime: %s\nServer: %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$(hostname)"
    if [ "${3:-}" = with-log ]; then
      printf '\nLast lines of the service log:\n'
      journalctl -u mailloom -n 15 --no-pager 2>/dev/null | grep -iv 'secret\|password\|token\|authorization\|cookie\|key' || true
    fi
  } | /usr/sbin/sendmail -t >/dev/null 2>&1 || true
}

healthy() {
  for _ in $(seq 1 15); do
    if systemctl is-active --quiet mailloom && curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/auth/accounts" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

CUR="$(head -1 "$APP/VERSION" 2>/dev/null || echo unknown)"

# ---- rollback ----------------------------------------------------------------------------------
if [ "$ROLLBACK" = 1 ]; then
  [ -d "$PREV" ] || { echo "No previous version in $PREV."; exit 1; }
  if [ "$CHECK" = 1 ]; then echo "Would put back: $(head -1 "$PREV/VERSION" 2>/dev/null) (running now: $CUR). Nothing changed."; exit 0; fi
  systemctl stop mailloom
  rm -rf "$APP.bad"; mv "$APP" "$APP.bad"; mv "$PREV" "$APP"
  systemctl start mailloom
  NOW="$(head -1 "$APP/VERSION" 2>/dev/null || echo unknown)"
  if healthy; then
    echo "Rolled back. Running: $NOW"
    notify "Mailloom rolled back to $NOW (healthy)" "Rolled back by hand from $CUR to $NOW."
    exit 0
  fi
  echo "Rolled back but not answering; check: journalctl -u mailloom -n 30"
  notify "Mailloom rolled back to $NOW but is not answering" "Rolled back from $CUR to $NOW; the service is not answering." with-log
  exit 1
fi

# ---- decide: is there a release, and is it on main? --------------------------------------------
if [ "$AUTO" = 1 ] || { [ -z "$TAG" ] && [ "$PRE" = 0 ]; }; then
  [ "$AUTO" = 1 ] && MODE=auto || MODE=latest
elif [ "$PRE" = 1 ]; then MODE=prerelease
else MODE=tag; fi
# A manual check with no tag behaves like the nightly run, so it can say "already running".
[ "$CHECK" = 1 ] && [ "$MODE" = latest ] && MODE=auto

DECISION="$(node "$DECIDE" "$REPO" "$MODE" "${CUR:-unknown}" "$TAG" || true)"
IFS=$'\t' read -r ACTION CODE RTAG COMMIT NAME ID DIGEST MSG <<<"$DECISION" || true
[ -n "${ACTION:-}" ] || { ACTION=error; MSG="The decision helper gave no answer ($DECIDE)."; RTAG="-"; }

case "$ACTION" in
  noop)
    echo "$MSG"; exit 0 ;;
  refuse)
    echo "Not installing: $MSG"
    [ "$CODE" = not_on_main ] && SUBJ="Mailloom skipped $RTAG: not on main" || SUBJ="Mailloom skipped $RTAG: $CODE"
    notify "$SUBJ" "$MSG
Running now: $CUR"
    exit 1 ;;
  error)
    echo "Could not check for a release: $MSG Nothing changed."
    notify "Mailloom update check failed" "$MSG Nothing was changed. Running now: $CUR"
    exit 1 ;;
  install) ;;
  *) echo "Unexpected answer from the decision helper. Nothing changed."; exit 1 ;;
esac

if [ "$CHECK" = 1 ]; then
  echo "Would install $RTAG ($NAME, commit ${COMMIT:0:10}), which is on main. Running now: $CUR. Nothing changed."
  exit 0
fi

echo "Installing $RTAG ($NAME). Running now: $CUR"

# ---- download and verify -----------------------------------------------------------------------
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
fail_early() { echo "$1 Nothing changed."; notify "Mailloom update to $RTAG failed before installing" "$1 Nothing was changed. Running now: $CUR"; exit 1; }
curl -fsSL --max-time 300 -H "Accept: application/octet-stream" -o "$WORK/$NAME" "https://api.github.com/repos/$REPO/releases/assets/$ID" \
  || fail_early "Could not download the release file."
GOT="$(sha256sum "$WORK/$NAME" | cut -d' ' -f1)"
[ "$GOT" = "$DIGEST" ] || { echo "Checksum does not match GitHub's. Nothing changed."; notify "Mailloom skipped $RTAG: checksum mismatch" "The downloaded file's checksum does not match GitHub's. Nothing was changed. Running now: $CUR"; exit 1; }
tar -xzf "$WORK/$NAME" -C "$WORK"
DIR="$WORK/${NAME%.tar.gz}"
[ -f "$DIR/server.mjs" ] && [ -f "$DIR/server.bundle.mjs" ] || fail_early "Release file is incomplete."

# ---- swap, health-check, roll back on failure --------------------------------------------------
rm -rf "$NEXT"; cp -a "$DIR" "$NEXT"
cp -a "$APP/.env" "$NEXT/.env"
chown -R root:www-data "$NEXT"; chmod 640 "$NEXT/.env"

systemctl stop mailloom
rm -rf "$PREV"; mv "$APP" "$PREV"; mv "$NEXT" "$APP"
systemctl start mailloom

if healthy; then
  echo "Done. Running $RTAG. Previous version kept for: sudo mailloom-update --rollback"
  notify "Mailloom updated to $RTAG (healthy)" "Updated from $CUR to $RTAG ($NAME). The service is answering. Roll back with: sudo mailloom-update --rollback"
else
  echo "New version did not start; putting the previous one back."
  LOG="$(journalctl -u mailloom -n 15 --no-pager 2>/dev/null | grep -iv 'secret\|password' || true)"
  [ -z "$LOG" ] || echo "$LOG"
  systemctl stop mailloom
  rm -rf "$APP.bad"; mv "$APP" "$APP.bad"; mv "$PREV" "$APP"
  systemctl start mailloom
  if healthy; then
    echo "Previous version is running again."
    notify "Mailloom update failed, rolled back to $CUR" "$RTAG did not start. The previous version ($CUR) is running again." with-log
  else
    echo "Previous version is not answering either; check: journalctl -u mailloom -n 30"
    notify "Mailloom update failed and the service is not answering" "$RTAG did not start and the previous version ($CUR) is not answering either. Check the server now." with-log
  fi
  exit 1
fi
