#!/bin/sh
set -eu

if [ "$#" -gt 0 ]; then
    exec node /app/dist/cli.js "$@"
fi

set -- serve --workspace /projects --examples /home/node/examples --host 0.0.0.0 --port 4400
if [ -n "${SBD_NAME:-}" ]; then
    set -- "$@" --default-project "$SBD_NAME"
fi
exec node /app/dist/cli.js "$@"
