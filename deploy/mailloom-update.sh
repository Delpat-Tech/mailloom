#!/usr/bin/env bash
# Update Mailloom on the live server to the latest GitHub release (or a given tag).
#   sudo mailloom-update            latest release
#   sudo mailloom-update v2026.11.16
#   sudo mailloom-update --rollback put the previous version back
# Layout: systemd unit "mailloom", app in /opt/www/mailloom (with its .env), previous version in /opt/www/mailloom.prev.
set -euo pipefail

REPO="Delpat-Tech/mailloom"
APP="/opt/www/mailloom"
PREV="/opt/www/mailloom.prev"
NEXT="/opt/www/mailloom.next"
PORT="$(grep -E '^PORT=' "$APP/.env" 2>/dev/null | cut -d= -f2 || true)"; PORT="${PORT:-3000}"

[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }

healthy() {
  for _ in $(seq 1 15); do
    if systemctl is-active --quiet mailloom && curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/auth/accounts"; then return 0; fi
    sleep 1
  done
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  [ -d "$PREV" ] || { echo "No previous version in $PREV."; exit 1; }
  systemctl stop mailloom
  rm -rf "$APP.bad"; mv "$APP" "$APP.bad"; mv "$PREV" "$APP"
  systemctl start mailloom
  healthy && echo "Rolled back. Running: $(head -1 "$APP/VERSION" 2>/dev/null)" || { echo "Rolled back but not answering; check: journalctl -u mailloom -n 30"; exit 1; }
  exit 0
fi

if [ -n "${1:-}" ]; then API="https://api.github.com/repos/$REPO/releases/tags/$1"; else API="https://api.github.com/repos/$REPO/releases/latest"; fi
META="$(curl -fsSL "$API")"
read -r TAG NAME ID DIGEST < <(printf '%s' "$META" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);
  const a=r.assets.find(x=>/^mailloom-[0-9a-f]+\.tar\.gz$/.test(x.name));
  if(!a||!a.digest){console.error("No release file or checksum found.");process.exit(1)}
  console.log(r.tag_name,a.name,a.id,a.digest.replace(/^sha256:/,""))})')

CUR="$(head -1 "$APP/VERSION" 2>/dev/null || echo unknown)"
echo "Installing $TAG ($NAME). Running now: $CUR"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
curl -fsSL -H "Accept: application/octet-stream" -o "$WORK/$NAME" "https://api.github.com/repos/$REPO/releases/assets/$ID"
GOT="$(sha256sum "$WORK/$NAME" | cut -d' ' -f1)"
[ "$GOT" = "$DIGEST" ] || { echo "Checksum does not match GitHub's. Nothing changed."; exit 1; }
tar -xzf "$WORK/$NAME" -C "$WORK"
DIR="$WORK/${NAME%.tar.gz}"
[ -f "$DIR/server.mjs" ] && [ -f "$DIR/server.bundle.mjs" ] || { echo "Release file is incomplete. Nothing changed."; exit 1; }

rm -rf "$NEXT"; cp -a "$DIR" "$NEXT"
cp -a "$APP/.env" "$NEXT/.env"
chown -R root:www-data "$NEXT"; chmod 640 "$NEXT/.env"

systemctl stop mailloom
rm -rf "$PREV"; mv "$APP" "$PREV"; mv "$NEXT" "$APP"
systemctl start mailloom

if healthy; then
  echo "Done. Running $TAG. Previous version kept for: sudo mailloom-update --rollback"
else
  echo "New version did not start; putting the previous one back."
  journalctl -u mailloom -n 15 --no-pager | grep -iv "secret\|password" || true
  systemctl stop mailloom
  rm -rf "$APP.bad"; mv "$APP" "$APP.bad"; mv "$PREV" "$APP"
  systemctl start mailloom
  healthy && echo "Previous version is running again." || echo "Previous version is not answering either; check: journalctl -u mailloom -n 30"
  exit 1
fi
