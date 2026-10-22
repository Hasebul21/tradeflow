#!/bin/sh
# Looks for the values of the keys and passwords in .env in every commit of the current branch.
# They have no published prefix, so the pattern scans can't see them. Prints names and commits, never a value.
# Run from the repo root: sh .githooks/scan-history.sh (exit 1 on a hit).
if [ ! -f .env ]; then
  echo "scan-history: no .env, so no values to compare"
  exit 0
fi

found=0
for name in METERLESS_API_KEY METERLESS_RUNTIME_TOKEN NVIDIA_API_KEY MODEL_API_KEY ZETARIS_API_KEY ZETARIS_PASSWORD ZETARIS_DB_PASSWORD PGPASS; do
  value=$(sed -n "s/^$name=//p" .env | head -1)
  [ -n "$value" ] || continue
  # A value shorter than 12 characters would match ordinary text, so it is skipped, with a warning that names the variable.
  if [ "${#value}" -lt 12 ]; then
    echo "scan-history: $name in .env is shorter than 12 characters, so its value is not checked." >&2
    continue
  fi
  commits=$(git log --format=%h -S"$value" | paste -sd ' ' -)
  if [ -n "$commits" ]; then
    echo "scan-history: the value of $name from .env is in commits: $commits" >&2
    found=1
  fi
done

if [ "$found" -eq 0 ]; then
  echo "scan-history: no .env value found in history"
fi
exit "$found"
