#!/bin/bash
#SBATCH --job-name=wt-manifest
#SBATCH --cpus-per-task=1
#SBATCH --mem=2G
#SBATCH --time=00:20:00
#SBATCH --output=logs/%x.out
#SBATCH --error=logs/%x.err

set -euo pipefail
cd "${SLURM_SUBMIT_DIR:-$(dirname "$0")}"   # submit from this directory
WT_ROOT="${WT_ROOT:-$(cd .. && pwd)}"
export WT_ROOT
python3 -I 03_build_manifest.py
N=$(wc -l < variables_manifest.jsonl)
echo "manifest has $N units"

# chain: convert -> pyramid -> finalize
./submit_chain.sh
