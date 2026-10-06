#!/bin/bash
# Floating lrc - one-time setup for macOS.
# Installs the overlay's dependencies (Electron) and creates "Floating lrc.app" next to this file.
cd "$(dirname "$0")" || exit 1
DIR="$(pwd)"
xattr -dr com.apple.quarantine "$DIR" 2>/dev/null

echo "== Floating lrc setup =="

# 1) Node.js (needed once, to install Electron). Use the system one if it is recent enough.
need_node=1
[ -x "$DIR/runtime/node/bin/node" ] && export PATH="$DIR/runtime/node/bin:$PATH"
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//; s/\..*//')"
  [ "${major:-0}" -ge 18 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  echo "Node.js 18+ not found. Downloading a private copy (about 40 MB) into ./runtime ..."
  case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  NODE_VER="v22.11.0"
  mkdir -p runtime && cd runtime || exit 1
  if ! curl -fL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-${ARCH}.tar.gz" -o node.tar.gz; then
    echo "Download failed. Install Node.js from https://nodejs.org and run this file again."; exit 1
  fi
  tar -xzf node.tar.gz && rm -rf node && mv "node-${NODE_VER}-darwin-${ARCH}" node && rm node.tar.gz
  cd "$DIR" || exit 1
  export PATH="$DIR/runtime/node/bin:$PATH"
fi
echo "node: $(node -v)"

# 2) Electron
cd "$DIR/app" || exit 1
npm install --no-audit --no-fund || { echo "npm install failed."; exit 1; }
cd "$DIR" || exit 1

# 3) Build a small launcher app you can drag to the Dock or add to Login Items
APP="$DIR/Floating lrc.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$DIR/app/assets/icon.icns" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Floating lrc</string>
<key>CFBundleDisplayName</key><string>Floating lrc</string>
<key>CFBundleIdentifier</key><string>local.floating-lrc.launcher</string>
<key>CFBundleExecutable</key><string>launcher</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1.0</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/launcher" <<LAUNCH
#!/bin/bash
cd "$DIR/app" || exit 1
ELECTRON="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "\$ELECTRON" ]; then
  osascript -e 'display dialog "Floating lrc is not set up here. Run Install.command again." buttons {"OK"} with icon note with title "Floating lrc"'
  exit 0
fi
nohup "\$ELECTRON" . >/dev/null 2>&1 &
LAUNCH
chmod +x "$APP/Contents/MacOS/launcher"
touch "$APP"

echo
echo "Done!"
echo "  1. Add the Chrome extension: open chrome://extensions, turn on Developer mode,"
echo "     click 'Load unpacked' and choose the 'extension' folder next to this file."
echo "  2. Start the overlay: double-click 'Floating lrc.app' (or Start.command)."
echo "  3. Play a song on music.youtube.com."
echo "You can close this window."
