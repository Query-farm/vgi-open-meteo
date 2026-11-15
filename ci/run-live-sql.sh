#!/usr/bin/env bash
# Run the live-API SQL suite on a GitHub-hosted runner.
#
# Open-Meteo throttles the shared runner IPs by letting connections hang (no
# 429), so a run can fail through no fault of the worker. The worker reports
# that case as "Open-Meteo did not respond within ..." (src/open-meteo.ts).
# This wrapper fails the job on any other failure, and turns a run whose every
# failure is that upstream timeout into a warning annotation.
#
# Usage: ci/run-live-sql.sh <make target> [make args...]
set -uo pipefail

LOG="$(mktemp)"
make "$@" 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
[ "$status" -eq 0 ] && exit 0

# The runner prints each failure as "N. test/sql/x.test:LINE" followed by its
# error text (again in the summary when several files ran). Group the log into
# those blocks and classify each distinct failure location: it is an upstream
# timeout only if one of its blocks carries the worker's timeout message.
read -r failures timeouts < <(awk '
  /^[0-9]+\. test\/sql\// { loc = $2; seen[loc] = 1; next }
  loc != "" && /Open-Meteo did not respond within/ { timeout[loc] = 1 }
  END { f = 0; t = 0; for (l in seen) { f++; if (l in timeout) t++ }; print f, t }
' "$LOG")

if [ "$failures" -gt 0 ] && [ "$failures" -eq "$timeouts" ]; then
  echo "::warning title=Open-Meteo unreachable from this runner::${failures} quer$( [ "$failures" -eq 1 ] && echo y || echo ies) timed out upstream (GitHub runner IP throttled); no worker failure. Run the suite locally to verify."
  exit 0
fi
echo "::error::${failures} SQL failure(s), ${timeouts} of them upstream timeouts — at least one is a real failure."
exit "$status"
