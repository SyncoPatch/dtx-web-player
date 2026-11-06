#!/usr/bin/env python3
"""Export a Music-Source-Separation-Training (MSST) model to ONNX for the
DTX Web Player's in-browser drum separation.

The browser runtime (js/separate-core.js) only does chunking and
overlap-add, so the exported graph must map raw audio to raw audio:

    input  "mix"   float32 [1, 2, chunk]
    output "stems" float32 [1, S, 2, chunk]

torch.stft / istft produce complex tensors, which ONNX (and onnxruntime's
WebGPU backend) can't run, so the model's STFT is swapped for exact
real-valued equivalents built from Conv1d / ConvTranspose1d with DFT
kernels before export. Supported model types: mdx23c, htdemucs.

Writes <out>.onnx and <out>.json (the manifest the app reads), then checks
the ONNX output against the original PyTorch model on real audio (or noise)
and prints the SDR, which should be far above 60 dB.

Usage (from anywhere; --msst points at a checkout of
https://github.com/ZFTurbo/Music-Source-Separation-Training):

    python export.py --msst ~/src/MSST --model-type htdemucs \\
        --config ~/src/MSST/configs/config_musdb18_htdemucs.yaml \\
        --checkpoint f7e0c4bc-ba3fe64a.th --role drums --out htdemucs-ft-drums

    python export.py --msst ~/src/MSST --model-type mdx23c \\
        --config aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.yaml \\
        --checkpoint aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.ckpt \\
        --role drumsep --out drumsep-mdx23c-6

    python export.py --selftest    # STFT replacement vs torch, no MSST needed
"""
import argparse
import inspect
import json
import math
import os
import sys
import types

import numpy as np
import torch
import torch.nn.functional as F


# ---------------------------------------------------------------------------
# Real-valued STFT. Spectra are real tensors shaped (..., 2, freq, frames),
# i.e. the layout of view_as_real(z).movedim(-1, -3). With that layout the
# slicing and padding code in HTDemucs' _spec / _ispec works unchanged.
# ---------------------------------------------------------------------------

class ConvSTFT(torch.nn.Module):
    """torch.stft(center=True, pad_mode='reflect', periodic Hann window,
    onesided) and its inverse torch.istft(center=True)."""

    def __init__(self, n_fft, hop, normalized=False):
        super().__init__()
        self.n_fft, self.hop, self.normalized = n_fft, hop, normalized
        n = torch.arange(n_fft, dtype=torch.float64)
        k = torch.arange(n_fft // 2 + 1, dtype=torch.float64)
        ang = 2 * math.pi * k[:, None] * n[None, :] / n_fft
        win = torch.hann_window(n_fft, periodic=True, dtype=torch.float64)
        fwd = torch.cat([torch.cos(ang) * win, -torch.sin(ang) * win], 0)
        if normalized:
            fwd = fwd / math.sqrt(n_fft)
        # irfft weights: DC and Nyquist count once, the rest twice.
        c = torch.full((n_fft // 2 + 1,), 2.0, dtype=torch.float64)
        c[0] = 1
        if n_fft % 2 == 0:
            c[-1] = 1
        inv = torch.cat([torch.cos(ang) * c[:, None], -torch.sin(ang) * c[:, None]], 0) / n_fft
        inv = inv * win
        if normalized:
            inv = inv * math.sqrt(n_fft)
        # Persistent buffers of a registered submodule become ONNX initializers
        # with known shapes; the exporter rejects convolutions whose kernel
        # shape it can't see.
        self.register_buffer('fwd', fwd.float()[:, None, :])
        self.register_buffer('inv', inv.float()[:, None, :])
        self.register_buffer('win2', (win ** 2).float()[None, None, :])

    def forward(self, x):
        """x: (..., time) -> (..., 2, freq, frames)."""
        lead = x.shape[:-1]
        x = x.reshape(-1, 1, x.shape[-1])
        p = self.n_fft // 2
        x = F.pad(x, (p, p), mode='reflect')
        y = F.conv1d(x, self.fwd, stride=self.hop)  # (M, 2F, frames)
        nf = self.n_fft // 2 + 1
        return y.reshape(*lead, 2, nf, y.shape[-1])

    def inverse(self, z, length=None):
        """z: (..., 2, freq, frames) -> (..., time)."""
        lead = z.shape[:-3]
        nf, frames = z.shape[-2], z.shape[-1]
        z = z.reshape(-1, 2 * nf, frames)
        y = F.conv_transpose1d(z, self.inv, stride=self.hop)  # (M, 1, (frames-1)*hop + n_fft)
        env = F.conv_transpose1d(torch.ones(1, 1, frames, dtype=z.dtype, device=z.device),
                                 self.win2, stride=self.hop)
        p = self.n_fft // 2
        if length is None:
            length = self.hop * (frames - 1)
        end = min(p + length, y.shape[-1])
        y = y[..., p:end] / env[..., p:end].clamp_min(1e-11)
        if end - p < length:
            y = F.pad(y, (0, length - (end - p)))
        return y.reshape(*lead, length)


# ---------------------------------------------------------------------------
# Per-architecture patches.
# ---------------------------------------------------------------------------

class MDXRealSTFT:
    """Drop-in for MDX23C's STFT helper (models/mdx23c_tfc_tdf_v3.py)."""

    def __init__(self, n_fft, hop, dim_f):
        self.conv = ConvSTFT(n_fft, hop)
        self.n_fft, self.hop_length, self.dim_f = n_fft, hop, dim_f

    def to(self, device):
        self.conv.to(device)
        return self

    def __call__(self, x):
        batch_dims = x.shape[:-2]
        c, t = x.shape[-2:]
        z = self.conv(x.reshape(-1, t))  # (M, 2, F, T)
        z = z.reshape(*batch_dims, c * 2, z.shape[-2], z.shape[-1])
        return z[..., :self.dim_f, :]

    def inverse(self, x):
        batch_dims = x.shape[:-3]
        c, f, t = x.shape[-3:]
        n = self.n_fft // 2 + 1
        pad = torch.zeros(*batch_dims, c, n - f, t, dtype=x.dtype, device=x.device)
        x = torch.cat([x, pad], -2)
        x = x.reshape(-1, 2, n, t)
        y = self.conv.inverse(x)
        return y.reshape(*batch_dims, 2, -1)


def patch_mdx23c(model, config):
    a = config.audio
    model.stft = MDXRealSTFT(a.n_fft, a.hop_length, a.dim_f)
    model.add_module('real_stft', model.stft.conv)  # see ConvSTFT buffers


def patch_htdemucs(model, config):
    mod = sys.modules[type(model).__module__]
    for name in ('spectro', 'ispectro'):
        if not hasattr(mod, name):
            raise SystemExit(f'{mod.__name__} has no {name}(); this MSST version is not supported')
    # Registered on the model up front (see ConvSTFT buffers); other sizes
    # would be created on demand but HTDemucs only uses its own nfft / hop.
    main = ConvSTFT(model.nfft, model.hop_length, normalized=True)
    model.add_module('real_stft', main)
    stfts = {(model.nfft, model.hop_length): main}

    def get(n_fft, hop, device):
        key = (n_fft, hop)
        if key not in stfts:
            stfts[key] = ConvSTFT(n_fft, hop, normalized=True).to(device)
        return stfts[key]

    def spectro(x, n_fft=512, hop_length=None, pad=0):
        assert pad == 0
        return get(n_fft, hop_length or n_fft // 4, x.device)(x)

    def ispectro(z, hop_length=None, length=None, pad=0):
        assert pad == 0
        n_fft = 2 * (z.shape[-2] - 1)
        return get(n_fft, hop_length or n_fft // 4, z.device).inverse(z, length)

    def _magnitude(self, z):
        if not self.cac:
            raise SystemExit('htdemucs with cac=False is not supported')
        B, C, _, Fr, T = z.shape
        return z.reshape(B, C * 2, Fr, T)

    def _mask(self, z, m):
        B, S, C, Fr, T = m.shape
        return m.view(B, S, -1, 2, Fr, T)

    mod.spectro, mod.ispectro = spectro, ispectro
    model._magnitude = types.MethodType(_magnitude, model)
    model._mask = types.MethodType(_mask, model)


PATCHES = {'mdx23c': patch_mdx23c, 'htdemucs': patch_htdemucs}


# ---------------------------------------------------------------------------

class Wrapper(torch.nn.Module):
    def __init__(self, model, chunk):
        super().__init__()
        self.model, self.chunk = model, chunk

    def forward(self, mix):
        y = self.model(mix)
        return y.reshape(1, -1, 2, self.chunk)


def stub_diffq():
    """demucs imports diffq (model quantization) at module load, but only
    uses it for quantized checkpoints. diffq has no wheels and needs a C
    compiler, so stand in a stub that fails loudly if it is ever used."""
    try:
        import diffq  # noqa: F401
        return
    except ImportError:
        pass

    def unavailable(*args, **kwargs):
        raise SystemExit('This checkpoint is quantized and needs the real diffq package (pip install diffq).')

    stub = types.ModuleType('diffq')
    stub.DiffQuantizer = stub.UniformQuantizer = unavailable
    stub.restore_quantized_state = unavailable
    sys.modules['diffq'] = stub


def load_msst(msst, model_type, config_path, checkpoint):
    stub_diffq()
    sys.path.insert(0, os.path.abspath(os.path.expanduser(msst)))
    try:
        from utils.settings import get_model_from_config
    except ImportError:
        from utils import get_model_from_config
    model, config = get_model_from_config(model_type, config_path)
    state = torch.load(checkpoint, map_location='cpu', weights_only=False)
    for key in ('state', 'state_dict', 'model_state_dict'):
        if isinstance(state, dict) and key in state:
            state = state[key]
    model.load_state_dict(state)
    return model.eval(), config


def sdr(ref, est):
    ref, est = np.asarray(ref, np.float64), np.asarray(est, np.float64)
    return 10 * math.log10((np.sum(ref ** 2) + 1e-12) / (np.sum((ref - est) ** 2) + 1e-20))


def test_audio(path, chunk, sr):
    if path:
        import librosa
        y, _ = librosa.load(path, sr=sr, mono=False)
        if y.ndim == 1:
            y = np.stack([y, y])
        start = max(0, y.shape[1] // 2 - chunk // 2)
        y = y[:, start:start + chunk]
        if y.shape[1] < chunk:
            y = np.pad(y, ((0, 0), (0, chunk - y.shape[1])))
        return torch.from_numpy(np.ascontiguousarray(y[None], dtype=np.float32))
    g = torch.Generator().manual_seed(0)
    return 0.1 * torch.randn(1, 2, chunk, generator=g)


def export(args):
    model, config = load_msst(args.msst, args.model_type, args.config, args.checkpoint)
    if args.model_type not in PATCHES:
        raise SystemExit(f'model type {args.model_type!r} is not supported (supported: {", ".join(PATCHES)})')

    if args.model_type == 'htdemucs':
        sr = int(config.training.samplerate)
        chunk = int(config.training.segment * sr)
        mode = 'demucs'
    else:
        sr = int(config.audio.get('sample_rate', 44100))
        chunk = int(config.audio.chunk_size)
        mode = 'generic'
    overlap = int(config.inference.get('num_overlap', 2))
    normalize = bool(config.inference.get('normalize', False))
    instruments = list(config.training.instruments)
    target = config.training.get('target_instrument')

    x = test_audio(args.audio, chunk, sr)
    with torch.no_grad():
        ref = model(x).reshape(1, -1, 2, chunk).numpy()
    n_stems = ref.shape[1]
    stems = instruments if n_stems == len(instruments) else [target] if n_stems == 1 and target else None
    if not stems:
        raise SystemExit(f'model outputs {n_stems} stems; cannot name them from {instruments} / {target}')
    stems = [str(s).lower() for s in stems]
    if args.role == 'drums' and 'drums' not in stems:
        raise SystemExit(f'--role drums needs a "drums" stem, model has {stems}')

    PATCHES[args.model_type](model, config)
    wrapper = Wrapper(model, chunk).eval()
    with torch.no_grad():
        patched = wrapper(x).numpy()
    print(f'patched torch vs original: SDR {sdr(ref, patched):.1f} dB')

    onnx_path = args.out + '.onnx'
    kw = {}
    if 'dynamo' in inspect.signature(torch.onnx.export).parameters:
        kw['dynamo'] = False
    torch.onnx.export(wrapper, (x,), onnx_path, opset_version=17,
                      input_names=['mix'], output_names=['stems'], do_constant_folding=True, **kw)

    if args.fp16:
        import onnx
        from onnxconverter_common import float16
        m = onnx.load(onnx_path)
        m = float16.convert_float_to_float16(m, keep_io_types=True)
        onnx.save(m, onnx_path)

    import onnxruntime as ort
    sess = ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
    out = sess.run(None, {'mix': x.numpy()})[0]
    check = sdr(ref, out)
    print(f'onnxruntime vs original:  SDR {check:.1f} dB' + ('' if check > (30 if args.fp16 else 60) else '  <-- TOO LOW'))

    manifest = {
        'format': 1,
        'name': os.path.basename(args.out),
        'role': args.role,
        'modelType': args.model_type,
        'sampleRate': sr,
        'chunk': chunk,
        'overlap': overlap,
        'mode': mode,
        'stems': stems,
        'normalize': normalize,
        'fp16': bool(args.fp16),
        'check': {'sdr': round(check, 1), 'audio': bool(args.audio)},
        'source': {'config': os.path.basename(args.config), 'checkpoint': os.path.basename(args.checkpoint)},
    }
    with open(args.out + '.json', 'w') as f:
        json.dump(manifest, f, indent=2)
    mb = os.path.getsize(onnx_path) / 1e6
    print(f'wrote {onnx_path} ({mb:.0f} MB) and {args.out}.json; stems {stems}')


def selftest():
    torch.manual_seed(0)
    worst = 0.0
    for n_fft, hop, normalized in [(2048, 512, False), (4096, 1024, True), (1024, 256, True)]:
        st = ConvSTFT(n_fft, hop, normalized)
        win = torch.hann_window(n_fft)
        x = torch.randn(3, 2, 44100)
        ref = torch.stft(x.reshape(-1, x.shape[-1]), n_fft, hop, window=win, center=True,
                         normalized=normalized, pad_mode='reflect', return_complex=True)
        ref = torch.view_as_real(ref).movedim(-1, -3).reshape(3, 2, 2, n_fft // 2 + 1, -1)
        got = st(x)
        e1 = sdr(ref.numpy(), got.numpy())
        back = torch.istft(torch.view_as_complex(ref.movedim(-3, -1).reshape(6, n_fft // 2 + 1, -1, 2).contiguous()),
                           n_fft, hop, window=win, center=True, normalized=normalized, length=44100)
        got_back = st.inverse(got, 44100)
        e2 = sdr(back.reshape(3, 2, -1).numpy(), got_back.numpy())
        e3 = sdr(x.numpy(), got_back.numpy())
        print(f'n_fft {n_fft} hop {hop} normalized {normalized}: stft {e1:.1f} dB, istft {e2:.1f} dB, roundtrip {e3:.1f} dB')
        worst = min(worst or 1e9, e1, e2, e3)
    print('OK' if worst > 80 else 'FAIL')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--msst', help='path to a Music-Source-Separation-Training checkout')
    p.add_argument('--model-type', choices=sorted(PATCHES))
    p.add_argument('--config')
    p.add_argument('--checkpoint')
    p.add_argument('--role', choices=['drums', 'drumsep'],
                   help='drums: extracts the drum stem from a full mix; drumsep: splits a drum stem')
    p.add_argument('--out', help='output path without extension')
    p.add_argument('--audio', help='optional audio file for the parity check (needs librosa)')
    p.add_argument('--fp16', action='store_true', help='store weights as float16 (half the size)')
    p.add_argument('--selftest', action='store_true')
    args = p.parse_args()
    if args.selftest:
        selftest()
        return
    missing = [k for k in ('msst', 'model_type', 'config', 'checkpoint', 'role', 'out') if not getattr(args, k)]
    if missing:
        p.error('missing ' + ', '.join('--' + m.replace('_', '-') for m in missing))
    export(args)


if __name__ == '__main__':
    main()
