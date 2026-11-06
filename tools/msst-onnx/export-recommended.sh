#!/bin/sh
# Converts the two recommended separation models to ONNX, end to end:
# Python venv, MSST checkout, checkpoint downloads (hash-checked), self-test,
# export with parity checks. Everything lives in one work folder outside the
# repo (default ~/Documents/msst-onnx, about 2-3 GB); results land in out/.
#
#   sh tools/msst-onnx/export-recommended.sh [work-dir]
#
# Re-running skips finished steps. Needs python3.10-3.13 (torch wheels).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${1:-"$HOME/Documents/msst-onnx"}
MSST_COMMIT=f0b527736e7da24eae5b561a2bb1efd0569ec757

DEMUCS_URL=https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/f7e0c4bc-ba3fe64a.th
DEMUCS_SHA=ba3fe64ae8ef66ac9a4857222ce48efbdc5eb3ad375cb79dd13debee5aaa4066
# The original release (github.com/jarredou/models) is gone; these are
# mirrors of the same files (MSST-WebUI and UVR resources on Hugging Face).
DRUMSEP_URL=https://huggingface.co/Sucial/MSST-WebUI/resolve/main/All_Models/multi_stem_models/aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.ckpt
DRUMSEP_SHA=d2a4aa53eb584d21eead358a4e66d1882ad182911be018f052b5da73be9096d0
DRUMSEP_YAML_URL=https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDX23C/config_drumsep_mdx23c.yaml

PY=""
for v in python3.10 python3.11 python3.12 python3.13; do
  if command -v "$v" >/dev/null 2>&1; then PY=$v; break; fi
done
[ -n "$PY" ] || { echo "Need python3.10-3.13 for torch wheels." >&2; exit 1; }

mkdir -p "$WORK/ckpt" "$WORK/out"
cd "$WORK"

if [ ! -x venv/bin/python ]; then
  echo "== venv ($PY)"
  "$PY" -m venv venv
fi
if [ ! -f venv/.deps-ok ]; then
  echo "== python packages"
  venv/bin/pip install -q --upgrade pip
  # torch 2.8 still defaults to the TorchScript ONNX exporter export.py uses.
  venv/bin/pip install -q "torch==2.8.0" "numpy<2.3" ml_collections omegaconf pyyaml einops \
    julius dora-search librosa soundfile onnx onnxruntime onnxconverter-common beartype \
    rotary_embedding_torch
  # demucs 4.0.0 pins an old torchaudio; only its model code is needed.
  venv/bin/pip install -q --no-deps "demucs==4.0.0"
  touch venv/.deps-ok
fi

if [ ! -d MSST/.git ]; then
  echo "== MSST checkout"
  git clone -q https://github.com/ZFTurbo/Music-Source-Separation-Training MSST
fi
git -C MSST checkout -q "$MSST_COMMIT"

fetch() { # url sha file
  if [ -f "$3" ] && [ "$(shasum -a 256 "$3" | cut -d' ' -f1)" = "$2" ]; then return; fi
  echo "== download $(basename "$3")"
  curl -fL --retry 3 -o "$3.part" "$1"
  got=$(shasum -a 256 "$3.part" | cut -d' ' -f1)
  [ "$got" = "$2" ] || { echo "SHA-256 mismatch for $3: $got" >&2; rm -f "$3.part"; exit 1; }
  mv "$3.part" "$3"
}
fetch "$DEMUCS_URL" "$DEMUCS_SHA" ckpt/f7e0c4bc-ba3fe64a.th
fetch "$DRUMSEP_URL" "$DRUMSEP_SHA" ckpt/drumsep-mdx23c-6.ckpt
[ -f ckpt/drumsep-mdx23c-6.yaml ] || curl -fsSL -o ckpt/drumsep-mdx23c-6.yaml "$DRUMSEP_YAML_URL"

echo "== self-test"
venv/bin/python "$HERE/export.py" --selftest

echo "== drums extractor"
venv/bin/python "$HERE/export.py" --msst MSST --model-type htdemucs \
  --config MSST/configs/config_musdb18_htdemucs.yaml \
  --checkpoint ckpt/f7e0c4bc-ba3fe64a.th --role drums --out out/htdemucs-ft-drums

echo "== drum splitter"
venv/bin/python "$HERE/export.py" --msst MSST --model-type mdx23c \
  --config ckpt/drumsep-mdx23c-6.yaml \
  --checkpoint ckpt/drumsep-mdx23c-6.ckpt --role drumsep --out out/drumsep-mdx23c-6

echo "== drum splitter (fp16)"
venv/bin/python "$HERE/export.py" --msst MSST --model-type mdx23c \
  --config ckpt/drumsep-mdx23c-6.yaml \
  --checkpoint ckpt/drumsep-mdx23c-6.ckpt --role drumsep --out out/drumsep-mdx23c-6-fp16 --fp16

ls -la out
echo "Done. Import the .onnx + .json pairs in the app: Settings → Separation models."
