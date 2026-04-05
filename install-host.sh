#!/bin/bash
set -e

# Install the ChromeGPT native messaging host manifest.
# One-time setup — run after loading the extension in Chrome.

HOST_NAME="com.chromegpt.bridge"
EXT_ID="hgkbnnohieahaecookipomahikkmbhli"
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
    echo "Unsupported OS. See: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging"
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
echo ""
echo "Restart Chrome, then click Connect in the side panel."
