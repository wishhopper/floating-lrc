#!/bin/bash
# Starts the Floating lrc overlay (run Install.command once first).
cd "$(dirname "$0")/app" || exit 1
ELECTRON="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON" ]; then echo "Please run Install.command first."; exit 1; fi
nohup "$ELECTRON" . >/dev/null 2>&1 &
echo "Floating lrc started. Quit: Cmd+Option+Q. Show/hide: Cmd+Option+L. You can close this window."
