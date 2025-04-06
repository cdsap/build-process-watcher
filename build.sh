#!/bin/bash

set -xe  # Exit immediately on error, print commands as they run

# Clean and recreate dist directory
rm -rf dist
mkdir -p dist

# Build src/index.ts -> dist/index.js
echo "Building src/index.ts..."
npx ncc build src/index.ts -o dist || { echo "❌ Failed to build src/index.ts"; exit 1; }

# Build src/cleanup.ts -> dist/cleanup.js
echo "Building src/cleanup.ts..."
npx ncc build src/cleanup.ts -o dist-tmp || { echo "❌ Failed to build src/cleanup.ts"; exit 1; }

mv dist-tmp/index.js dist/cleanup.js || { echo "❌ dist-tmp/index.js not found"; exit 1; }
rm -rf dist-tmp

# Copy monitor.sh and make it executable
cp monitor.sh dist/
chmod +x dist/monitor.sh

# Final directory listing
echo "✅ Final contents of dist directory:"
ls -la dist/

# Sanity checks
[ -f "dist/index.js" ]     || { echo "❌ ERROR: dist/index.js is missing!"; exit 1; }
[ -f "dist/cleanup.js" ]   || { echo "❌ ERROR: dist/cleanup.js is missing!"; exit 1; }
[ -f "dist/monitor.sh" ]   || { echo "❌ ERROR: dist/monitor.sh is missing!"; exit 1; }

echo "✅ Build completed successfully."
