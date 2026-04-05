#!/bin/bash
set -e

# Install the ChromeGPT native messaging host manifest.
# Run once after loading the extension in Chrome.
#
# Usage: ./install-host.sh <chrome-extension-id>
#
# Find your extension ID at chrome://extensions (enable Developer Mode).

if [ -z "$1" ]; then
  echo "Usage: ./install-host.sh <chrome-extension-id>"
  echo ""
  echo "Steps:"
  echo "  1. Go to chrome://extensions"
  echo "  2. Enable Developer Mode"
  echo "  3. Load the extension (Load unpacked → this directory)"
  echo "  4. Copy the extension ID shown under the extension name"
  echo "  5. Run: ./install-host.sh <that-id>"
  exit 1
fi

EXT_ID="$1"
HOST_NAME="com.chromegpt.bridge"
BRIDGE_PATH="$(cd "$(dirname "$0")" && pwd)/bridge.js"

# Detect OS and set manifest directory
case "$(uname -s)" in
  Darwin)
    MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported OS. Manually create the native messaging host manifest."
    echo "See: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging"
    exit 1
    ;;
esac

mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "ChromeGPT bridge to Codex app-server (stdio)",
  "path": "$BRIDGE_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

chmod +x "$BRIDGE_PATH"

echo "Installed native messaging host."
echo ""
echo "  Manifest: $MANIFEST_DIR/$HOST_NAME.json"
echo "  Bridge:   $BRIDGE_PATH"
echo "  Extension: $EXT_ID"
echo ""
echo "Restart Chrome for the change to take effect."
