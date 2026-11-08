#!/bin/bash
#SBATCH --job-name=wt-pyramid
#SBATCH --cpus-per-task=2
#SBATCH --mem=4G
#SBATCH --time=00:30:00
#SBATCH --output=logs/%x_%a.out
#SBATCH --error=logs/%x_%a.err

set -euo pipefail
cd "${SLURM_SUBMIT_DIR:-$(dirname "$0")}"   # submit from this directory
WT_ROOT="${WT_ROOT:-$(cd .. && pwd)}"
export WT_ROOT
MANIFEST=variables_manifest.jsonl
# retry: 64 concurrent tasks can race on the shared uv cache (EBUSY);
# the scripts are idempotent (mode="w") so a rerun is safe
for attempt in 1 2 3; do
    uv run --with xarray --with zarr --with numpy --with netCDF4 \
        python3 -I 05_multiscale.py "$MANIFEST" "$SLURM_ARRAY_TASK_ID" && exit 0
    echo "attempt $attempt failed" >&2; sleep $((RANDOM % 20 + 5))
done
exit 1
