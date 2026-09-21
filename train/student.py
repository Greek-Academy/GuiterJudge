"""蒸留の生徒モデル。教師(Kong et al. の Regress_onset_offset_frame_velocity_CRNN)と同じ骨格を 1 本にしたもの。

  log-mel(16 kHz、n_fft 2048、hop 160 = 100 fps、229 bin、教師と同一設定)
  → mel 軸で BatchNorm → ConvBlock × 4(周波数方向だけ 1/2 プーリング)→ FC → BiGRU → onset / frame の 2 ヘッド(sigmoid)

教師は同じトランクを frame / onset / offset / velocity に 4 本持つ(264 GFLOP / 10 秒)。生徒は 1 本 + 2 ヘッド。
プリセットのブラウザ内速度(ORT Web WASM、Mac、10 秒あたり): s 0.11 s / m 0.29 s / l 1.08 s(FINETUNE_NOTES.md 12.2)。

ONNX には mel 入力の本体だけを出す(フロントエンドはブラウザ側の FFT で計算する。同じ log-mel を作れば一致する)。
"""
import torch, torch.nn as nn, torch.nn.functional as F
from torchlibrosa.stft import Spectrogram, LogmelFilterBank

SR, N_FFT, HOP, MEL, FMIN, FMAX, FPS = 16000, 2048, 160, 229, 30, 8000, 100
PRESETS = {
    "s": dict(ch=[16, 16, 32, 32], fc=256, hid=96),
    "m": dict(ch=[24, 32, 48, 64], fc=384, hid=128),
    "l": dict(ch=[48, 64, 96, 128], fc=768, hid=256),
}


class Frontend(nn.Module):
    """波形 (B, samples) → log-mel (B, T, MEL)。教師と同じパラメータ(center=True, reflect, ref=1, amin=1e-10, top_db=None)"""

    def __init__(self):
        super().__init__()
        self.spec = Spectrogram(n_fft=N_FFT, hop_length=HOP, win_length=N_FFT, window="hann", center=True, pad_mode="reflect", freeze_parameters=True)
        self.mel = LogmelFilterBank(sr=SR, n_fft=N_FFT, n_mels=MEL, fmin=FMIN, fmax=FMAX, ref=1.0, amin=1e-10, top_db=None, freeze_parameters=True)

    def forward(self, wav):
        return self.mel(self.spec(wav))[:, 0]  # (B, 1, T, MEL) → (B, T, MEL)


class ConvBlock(nn.Module):
    def __init__(self, i, o, momentum=0.01):
        super().__init__()
        self.c1 = nn.Conv2d(i, o, 3, padding=1, bias=False); self.b1 = nn.BatchNorm2d(o, momentum=momentum)
        self.c2 = nn.Conv2d(o, o, 3, padding=1, bias=False); self.b2 = nn.BatchNorm2d(o, momentum=momentum)

    def forward(self, x):
        x = F.relu_(self.b1(self.c1(x))); x = F.relu_(self.b2(self.c2(x)))
        return F.avg_pool2d(x, kernel_size=(1, 2))


class Student(nn.Module):
    def __init__(self, ch, fc, hid, mel=MEL, dropout=0.2, momentum=0.01):
        super().__init__()
        self.bn0 = nn.BatchNorm2d(mel, momentum=momentum)
        self.blocks = nn.ModuleList([ConvBlock(i, o, momentum) for i, o in zip([1] + ch[:-1], ch)])
        self.fc = nn.Linear(ch[-1] * (mel // 16), fc, bias=False); self.bnf = nn.BatchNorm1d(fc, momentum=momentum)
        self.gru = nn.GRU(fc, hid, batch_first=True, bidirectional=True)
        self.onset = nn.Linear(2 * hid, 88); self.frame = nn.Linear(2 * hid, 88)
        self.dropout = dropout

    def forward(self, mel):  # (B, T, MEL) → onset, frame (B, T, 88)、いずれも確率
        x = mel.unsqueeze(1).transpose(1, 3); x = self.bn0(x).transpose(1, 3)  # 教師と同じく mel 軸で BN
        for b in self.blocks:
            x = F.dropout(b(x), p=self.dropout, training=self.training)
        B, C, T, Fq = x.shape
        x = x.transpose(1, 2).reshape(B, T, C * Fq)
        x = F.relu_(self.bnf(self.fc(x).transpose(1, 2)).transpose(1, 2))
        x = F.dropout(x, p=self.dropout, training=self.training)
        x, _ = self.gru(x)
        x = F.dropout(x, p=self.dropout, training=self.training)
        return torch.sigmoid(self.onset(x)), torch.sigmoid(self.frame(x))


def build(preset: str) -> Student:
    return Student(**PRESETS[preset])
