#!/bin/sh
# Turns the Bridge's signed LAN print API (TCP 9201) on or off. Run with sudo:
#
#   sudo /usr/local/hankha/print-bridge/lan-api.sh on | off | status
#
# It only writes or removes /usr/local/hankha/print-bridge/lan.json (the file the Bridge reads at
# startup; without it no extra port is opened) and restarts the daemon. The package's postinstall
# leaves an existing lan.json alone, so an upgrade keeps whatever was chosen here.
#
# macOS has no per-network-profile firewall rule like Windows' "private" profile. When the
# Application Firewall is switched on, "on" adds the Bridge binary to its allow list (best effort);
# it is per program, not per port, and applies on every network the Mac joins.
set -e

LABEL=la.hankha.print-bridge
DIR=/usr/local/hankha/print-bridge
BINARY=$DIR/hankha-print-bridge
CONF=$DIR/lan.json
SFW=/usr/libexec/ApplicationFirewall/socketfilterfw

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo:  sudo $0 on|off|status" >&2
  exit 1
fi

restart() {
  launchctl kickstart -k "system/$LABEL" 2>/dev/null || {
    launchctl bootout "system/$LABEL" 2>/dev/null || true
    launchctl bootstrap system "/Library/LaunchDaemons/$LABEL.plist"
  }
}

case "${1:-status}" in
  on)
    printf '%s\n' '{"enabled":true,"port":9201,"host":"0.0.0.0"}' > "$CONF"
    chown root:wheel "$CONF"
    chmod 644 "$CONF"
    if [ -x "$SFW" ]; then
      "$SFW" --add "$BINARY" >/dev/null 2>&1 || true
      "$SFW" --unblockapp "$BINARY" >/dev/null 2>&1 || true
    fi
    restart
    echo "LAN print API on: TCP 9201 (the Application Firewall, if enabled, allows the Bridge)."
    ;;
  off)
    rm -f "$CONF"
    if [ -x "$SFW" ]; then
      "$SFW" --remove "$BINARY" >/dev/null 2>&1 || true
    fi
    restart
    echo "LAN print API off. The Bridge's LAN key is kept, so earlier tickets stay valid if you turn it back on."
    ;;
  status)
    if [ -f "$CONF" ]; then
      echo "LAN print API config: $CONF"
      cat "$CONF"
    else
      echo "LAN print API is off (no lan.json): the Bridge opens no extra port."
    fi
    ;;
  *)
    echo "usage: sudo $0 on|off|status" >&2
    exit 2
    ;;
esac
