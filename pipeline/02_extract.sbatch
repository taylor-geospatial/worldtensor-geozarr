#!/bin/bash
#SBATCH --job-name=wt-extract
#SBATCH --cpus-per-task=2
#SBATCH --mem=4G
#SBATCH --time=04:00:00
#SBATCH --array=0-13
#SBATCH --output=logs/%x_%a.out
#SBATCH --error=logs/%x_%a.err

set -euo pipefail

cd "${SLURM_SUBMIT_DIR:-$(dirname "$0")}"   # submit from this directory
WT_ROOT="${WT_ROOT:-$(cd .. && pwd)}"
MANIFEST=manifest.tsv

LINE=$(sed -n "$((SLURM_ARRAY_TASK_ID + 1))p" "$MANIFEST")
FNAME=$(echo "$LINE" | cut -f1)
DOMAIN=$(basename "$FNAME" .zip | sed 's/^worldtensor_//')

ZIP="$WT_ROOT/raw/zips/$FNAME"
DEST="$WT_ROOT/raw/netcdf"
STAGE="$DEST/.stage_$DOMAIN"
DONE="$DEST/.done_$DOMAIN"

if [ -f "$DONE" ]; then
    echo "$DOMAIN already extracted, skipping"
    exit 0
fi

rm -rf "$STAGE"
mkdir -p "$STAGE"
echo "Extracting $FNAME into $STAGE"
unzip -q -o "$ZIP" -d "$STAGE"

# zips nest under a top-level dir matching the domain name; flatten that away
NESTED="$STAGE/$DOMAIN"
if [ -d "$NESTED" ]; then
    mv "$NESTED" "$DEST/$DOMAIN"
else
    mv "$STAGE" "$DEST/$DOMAIN"
fi
rm -rf "$STAGE"

touch "$DONE"
echo "Done extracting $DOMAIN: $(find "$DEST/$DOMAIN" -name '*.nc' | wc -l) nc files"
