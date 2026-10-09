#!/bin/bash
# Installs a T4 server archive from build-cli.sh as an independent headless server in ~/.t4
# and runs it as its own user service (systemd t4code.service / launchd
# com.t4tools.t4code.service). Re-running it upgrades and restarts. Never touches ~/.t3.
# Usage: install-service.sh <archive.tar.gz> <version> <port> [commit]
# The commit is recorded in ~/.t4/runtime/t4-commit for deploy-all.sh. An already installed
# version needs no archive, which is how a rollback reinstalls the previous one.
# See docs/operations/t4-machines.md.
set -euo pipefail
ARCHIVE=$1 VERSION=$2 PORT=$3 COMMIT=${4:-}
T4="$HOME/.t4"
VERSIONS="$T4/runtime/versions"
DEST="$VERSIONS/$VERSION"
mkdir -p "$VERSIONS" "$T4/userdata/logs"
chmod 700 "$T4"

if [ ! -f "$DEST/.install-complete" ]; then
  stage=$(mktemp -d "$VERSIONS/.stage-XXXXXX")
  tar -xzf "$ARCHIVE" -C "$stage"
  inner=$(ls "$stage")
  rm -rf "$DEST"
  mv "$stage/$inner" "$DEST"
  rmdir "$stage"
  printf '%s' "$VERSION" > "$DEST/.install-complete"
fi
"$DEST/t3" --version
printf '{\n  "protocol": 3,\n  "activeVersion": "%s"\n}\n' "$VERSION" > "$T4/runtime/service-state.json"
if [ -n "$COMMIT" ]; then printf '%s\n' "$COMMIT" > "$T4/runtime/t4-commit"; else rm -f "$T4/runtime/t4-commit"; fi

LOG="$T4/userdata/logs/boot-service.log"
case "$(uname -s)" in
  Linux)
    unit="$HOME/.config/systemd/user/t4code.service"
    path=$(systemctl --user show t3code.service -p Environment | tr ' ' '\n' | sed -n 's/^PATH=//p')
    [ -n "$path" ] || path=$(systemctl --user show-environment | sed -n 's/^PATH=//p')
    cat > "$unit" <<UNIT
[Unit]
Description=T4 Code server
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=%h
Environment=T3CODE_HOME=$T4
Environment=T3CODE_PORT=$PORT
Environment=T3_BOOT_SERVICE_UNIT=t4code.service
# Self-update would fetch stock T3 releases over this fork; make it fail instead.
Environment=T3CODE_RELEASE_BASE_URL=https://t4-updates.invalid
Environment=PATH=$path
ExecStart=$DEST/t3 __service-launcher
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5
MemoryLow=512M
ManagedOOMPreference=avoid
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable t4code.service >/dev/null 2>&1
    systemctl --user restart t4code.service
    ;;
  Darwin)
    label=com.t4tools.t4code.service
    plist="$HOME/Library/LaunchAgents/$label.plist"
    path=$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PATH' "$HOME/Library/LaunchAgents/com.t3tools.t3code.service.plist" 2>/dev/null || echo "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DEST/t3</string>
    <string>__service-launcher</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$path</string>
    <key>T3CODE_HOME</key>
    <string>$T4</string>
    <key>T3CODE_PORT</key>
    <string>$PORT</string>
    <key>T3_BOOT_SERVICE_UNIT</key>
    <string>$label.plist</string>
    <key>T3CODE_RELEASE_BASE_URL</key>
    <string>https://t4-updates.invalid</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>90</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    # bootout returns before the old job is gone; bootstrap fails with EIO until then.
    for _ in $(seq 1 30); do launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break; sleep 1; done
    launchctl bootstrap "gui/$(id -u)" "$plist"
    ;;
esac

for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/.well-known/t3/environment" >/dev/null 2>&1; then
    echo "T4 server is up on 127.0.0.1:$PORT"
    exit 0
  fi
  sleep 1
done
echo "T4 server did not answer on $PORT; see $LOG" >&2
tail -20 "$LOG" >&2
exit 1
