# Separation models for DTX Web Player

The player separates a Guitar Pro song's recording **in the browser** with two
ONNX models made from
[Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training)
(MSST) checkpoints:

| Role | Purpose | Recommended model |
|---|---|---|
| `drums` (Drums extractor) | drum stem out of the full mix; the backing track is the rest | HTDemucs4 FT Drums |
| `drumsep` (Drum splitter) | drum stem → kick / snare / toms / hh / ride / crash | MDX23C DrumSep (aufr33 & jarredou, 6 stems) |

The model weights don't state a license, so the app does not ship them.
Convert them once on your computer with `export.py`, then import the
`.onnx` + `.json` pairs in **Settings → Drum separation models**. The app keeps
them in the browser's private storage (OPFS), so this happens once per browser.

## Quick way: one script

```sh
sh tools/msst-onnx/export-recommended.sh   # does steps 1-3 below; output in ~/Documents/msst-onnx/out/
```

Then continue with step 4. The steps below are the same thing by hand.

## 1. Set up (once)

Use Python 3.10–3.13, because torch has no wheels for newer versions yet.
**Don't** `pip install -r` MSST's `requirements.txt`: it includes GUI and
microphone packages (`wxpython`, `pyaudio`) that fail to build on macOS, and
the export doesn't need them.

```sh
git clone https://github.com/ZFTurbo/Music-Source-Separation-Training ~/src/MSST
python3.10 -m venv ~/msst-venv && source ~/msst-venv/bin/activate
pip install "torch==2.8.0" "numpy<2.3" ml_collections omegaconf pyyaml einops julius dora-search \
  librosa soundfile onnx onnxruntime onnxconverter-common beartype rotary_embedding_torch
pip install --no-deps "demucs==4.0.0"   # its pinned torchaudio is not needed

python export.py --selftest   # checks the STFT replacement against torch (no MSST needed)
```

## 2. Download the checkpoints

- **HTDemucs4 FT Drums**: weights
  `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/f7e0c4bc-ba3fe64a.th`,
  config `configs/config_musdb18_htdemucs.yaml` from the MSST checkout.
- **MDX23C DrumSep (6 stems)**, from
  `https://github.com/jarredou/models/releases/tag/aufr33-jarredou_MDX23C_DrumSep_model_v0.1`:
  `aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.ckpt` and the `.yaml` next to it.

## 3. Export

```sh
python export.py --msst ~/src/MSST --model-type htdemucs \
  --config ~/src/MSST/configs/config_musdb18_htdemucs.yaml \
  --checkpoint f7e0c4bc-ba3fe64a.th --role drums --out htdemucs-ft-drums \
  --audio some-song.wav

python export.py --msst ~/src/MSST --model-type mdx23c \
  --config aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.yaml \
  --checkpoint aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.ckpt \
  --role drumsep --out drumsep-mdx23c-6 --audio some-drum-stem.wav
```

Each run prints two parity figures (`patched torch vs original` and
`onnxruntime vs original`). Both should be well above 60 dB (above 30 dB with
`--fp16`). `--audio` is optional; without it the check uses noise.

`--fp16` halves the download and storage. Leave it off if the parity check
drops, or if separation on your GPU sounds wrong.

## 4. Import

In the app open **Settings → Drum separation models**. Then either:

- use **Import files…** and pick both `.onnx` files and both `.json` files, or
- use **From URL…** and give the URL of a `.json`. The `.onnx` with the same
  name must sit next to it, and the server must allow CORS. A Hugging Face
  repository works and is handy for iPad.

## How it works

- `export.py` swaps each model's `torch.stft` / `istft`, which produce complex
  tensors, for exact real-valued Conv1d / ConvTranspose1d DFT layers. The
  exported graph is plain audio in (`[1, 2, chunk]`) and stems out
  (`[1, S, 2, chunk]`), and it runs on onnxruntime-web's WebGPU backend.
- The `.json` manifest records the sample rate, chunk size, overlap, stem names
  and the chunking mode.
- `js/separate-core.js` reproduces MSST's `demix` chunking and overlap-add
  around the model.
- Only `mdx23c` and `htdemucs` are supported. Other MSST architectures
  (SCNet, Roformers) call `torch.stft` in their own ways and would need their
  own patch in `export.py`.
