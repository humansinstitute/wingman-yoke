#!/usr/bin/env bash
set -euo pipefail

# Wingman-Yoke installer
# Usage: curl -fsSL https://raw.githubusercontent.com/humansinstitute/wingman-yoke/main/install.sh | bash

REPO="humansinstitute/wingman-yoke"
INSTALL_DIR="${WINGMAN_YOKE_INSTALL_DIR:-$HOME/.wingman-yoke}"
BIN_LINK="/usr/local/bin/wingman-yoke"

echo "Installing Wingman-Yoke..."

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "Error: Node.js >= 20 is required. Install from https://nodejs.org"; exit 1; }

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js >= 20 required (found v$(node -v))"
  exit 1
fi

command -v npm >/dev/null 2>&1 || { echo "Error: npm is required"; exit 1; }

# Clean previous install
if [ -d "$INSTALL_DIR" ]; then
  echo "Removing previous install at $INSTALL_DIR..."
  rm -rf "$INSTALL_DIR"
fi

# Clone and install
echo "Cloning from github.com/$REPO..."
git clone --depth 1 "https://github.com/$REPO.git" "$INSTALL_DIR" 2>&1 | tail -1

echo "Installing dependencies (this compiles better-sqlite3)..."
cd "$INSTALL_DIR"
npm install --production 2>&1 | tail -3

# Create symlink
if [ -w "$(dirname "$BIN_LINK")" ]; then
  ln -sf "$INSTALL_DIR/src/cli.js" "$BIN_LINK"
  echo "Linked: $BIN_LINK -> $INSTALL_DIR/src/cli.js"
else
  echo "Creating symlink requires sudo..."
  sudo ln -sf "$INSTALL_DIR/src/cli.js" "$BIN_LINK"
  echo "Linked: $BIN_LINK -> $INSTALL_DIR/src/cli.js"
fi

# Make CLI executable
chmod +x "$INSTALL_DIR/src/cli.js"

echo ""
echo "Wingman-Yoke installed successfully!"
echo "  Location: $INSTALL_DIR"
echo "  Command:  wingman-yoke --help"
echo ""
echo "Quick start:"
echo "  export WINGMAN_YOKE_NSEC=<your-nsec>"
echo "  wingman-yoke init --token <connection_token>"
echo "  wingman-yoke sync"
