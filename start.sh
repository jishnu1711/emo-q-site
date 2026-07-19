#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [ ! -x face_recognition/.venv/bin/python ]; then
  echo "The Python environment is missing. Run ./setup.sh first."
  exit 1
fi

exec npm start
