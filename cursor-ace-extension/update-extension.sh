#!/bin/bash
# Quick script to rebuild and update the installed ACE extension

set -e

echo "🔨 Building extension..."
npm run build

echo "📦 Updating installed extension..."
INSTALLED_PATH="$HOME/.cursor/extensions/ce-dot-net.cursor-ace-extension-0.1.0"

if [ ! -d "$INSTALLED_PATH" ]; then
    echo "❌ Extension not found at $INSTALLED_PATH"
    echo "   Install it first via VSIX or F5"
    exit 1
fi

echo "   Copying dist files..."
cp -r dist/* "$INSTALLED_PATH/dist/"

echo "   Updating package.json..."
cp package.json "$INSTALLED_PATH/"

echo "✅ Extension updated!"
echo ""
echo "📝 Next step: Reload Cursor window"
echo "   Cmd/Ctrl+Shift+P → 'Developer: Reload Window'"



