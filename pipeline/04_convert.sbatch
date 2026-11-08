#!/bin/bash
#SBATCH --job-name=wt-convert
#SBATCH --cpus-per-task=2
#SBATCH --mem=3G
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
    uv run --with xarray --with netCDF4 --with zarr --with pandas --with numpy \
        python3 -I 04_convert.py "$MANIFEST" "$SLURM_ARRAY_TASK_ID" && exit 0
    echo "attempt $attempt failed" >&2; sleep $((RANDOM % 20 + 5))
done
exit 1
