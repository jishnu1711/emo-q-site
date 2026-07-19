#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 18 or newer is required."; exit 1; }

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18 or newer is required; found $(node --version)."
  exit 1
fi

echo "Creating the UNO Q Python environment..."
python3 -m venv face_recognition/.venv
face_recognition/.venv/bin/python -m pip install --upgrade pip
face_recognition/.venv/bin/python -m pip install -r face_recognition/requirements.txt

if [ ! -f face_recognition/config.json ]; then
  cp face_recognition/config.example.json face_recognition/config.json
fi

echo "Running backend tests..."
npm test

echo "Running face-recognition tests..."
face_recognition/.venv/bin/python -m unittest discover -s tests/face_recognition -p 'test_*.py'

echo
echo "Setup complete. Connect the USB camera, then run: ./start.sh"
