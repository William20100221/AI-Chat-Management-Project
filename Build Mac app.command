#!/bin/bash
# Double-click to build the Mac app: dist/AI-Chat-Manager-<version>-mac-arm64.dmg and -x64.dmg (+ .zip)
# Needs Node.js (https://nodejs.org). The first build downloads about 300 MB.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Opening its download page: install the LTS version, then double-click this file again."
  open "https://nodejs.org/"
  read -r -p "Press Enter to close."
  exit 1
fi
echo "Getting what the build needs (first time only)..."
npm install --no-audit --no-fund || { read -r -p "The build failed (see above). Press Enter to close."; exit 1; }
echo "Building the app..."
npm run dist:mac || { read -r -p "The build failed (see above). Press Enter to close."; exit 1; }
echo
echo "Done: the app is in the dist folder."
open dist
read -r -p "Press Enter to close."
