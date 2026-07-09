#!/bin/zsh
# FrameCull Lightroom rating exporter - macOS launcher
# Tk renders a blank/white window on some macOS setups (deprecated system Tk).
# To guarantee a working experience, this launcher uses the native macOS
# dialog flow (no custom window, so it can never show a blank screen).

cd "$(dirname "$0")"

if [ -x "./run-mac.command" ]; then
  exec /bin/zsh "./run-mac.command"
else
  echo "run-mac.command not found next to this launcher."
  echo "Press Enter to close."
  read
fi