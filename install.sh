#!/bin/bash
set -e

EXT_UUID="ai-usage-bar@sokolowski.tech"
ZIP_NAME="${EXT_UUID}.shell-extension.zip"

echo "► Compiling GSettings schema..."
glib-compile-schemas schemas/

echo "► Packaging extension..."
rm -f "$ZIP_NAME"
python3 -m zipfile -c "$ZIP_NAME" \
    metadata.json \
    extension.js \
    prefs.js \
    stylesheet.css \
    schemas/ \
    lib/ \
    icons/

echo "► Installing extension..."
gnome-extensions install --force "$ZIP_NAME"

echo "► Reloading extension in GNOME Shell..."
gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
sleep 1
gnome-extensions enable "$EXT_UUID" 2>/dev/null || true

echo "► Cleanup..."
rm -f "$ZIP_NAME"

echo ""
echo "✓ Done!"
echo ""
echo "  If you are on Wayland and changes don't appear, log out and back in."
echo "  To check logs: journalctl /usr/bin/gnome-shell --since='1 min ago' -f"
