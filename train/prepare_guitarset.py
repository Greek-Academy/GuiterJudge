#!/usr/bin/env python
"""GuitarSet(スチール弦アコースティック、CC BY 4.0)を Basic Pitch の学習用 TFRecord に変換する。

GAPS だけで追加学習するとクラシックギターに寄りすぎてスチール弦で落ちる可能性があるので、
混ぜて学習する選択肢のために用意した(公式の学習データにも GuitarSet は入っている)。
正解の作り方は公式の GuitarSet アダプタと同じ(notes_all → notes / onsets、contours は multif0 の代わりに notes_all)。

    python train/prepare_guitarset.py --guitarset ~/dev/guitar-data/guitarset --out ~/dev/guitar-data/tfrecords

mirdata の GuitarSet ローダは audio_mono-mic/ というディレクトリ名を期待するので、
fetch-datasets.sh が作る audio/ へのシンボリックリンクを張っておく:
    ln -s ~/dev/guitar-data/guitarset/audio ~/dev/guitar-data/guitarset/audio_mono-mic

分割は奏者で切る(00〜03 train、04 validation、05 test)。同じ譜面を別の奏者が弾いた曲が split をまたぐが、
音源としては別演奏なので、曲単位のランダム分割より漏れが少ない。
"""
import argparse
import os
import sys

import mirdata
import numpy as np
import tensorflow as tf

from basic_pitch.constants import (
    ANNOTATION_HOP,
    AUDIO_SAMPLE_RATE,
    FREQ_BINS_CONTOURS,
    FREQ_BINS_NOTES,
    N_FREQ_BINS_CONTOURS,
    N_FREQ_BINS_NOTES,
)
from basic_pitch.data.tf_example_serialization import _to_transcription_tfex

from prepare_gaps import encode_wav, load_audio_22k_mono

SPLIT_BY_PLAYER = {"00": "train", "01": "train", "02": "train", "03": "train", "04": "validation", "05": "test"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--guitarset", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    gs = mirdata.initialize("guitarset", data_home=args.guitarset)
    gs.download(["index"])
    counts = {"train": 0, "validation": 0, "test": 0}
    for track_id in sorted(gs.track_ids):
        split = SPLIT_BY_PLAYER[track_id[:2]]
        if args.limit and counts[split] >= args.limit:
            continue
        out_dir = os.path.join(args.out, "guitarset", "splits", split)
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, f"{track_id}.tfrecord")
        if os.path.exists(out_path):
            counts[split] += 1
            continue
        t = gs.track(track_id)
        audio = load_audio_22k_mono(t.audio_mic_path)
        duration = len(audio) / AUDIO_SAMPLE_RATE
        time_scale = np.arange(0, duration + ANNOTATION_HOP, ANNOTATION_HOP)
        n_time_frames = len(time_scale)
        notes = t.notes_all
        note_indices, note_values = notes.to_sparse_index(time_scale, "s", FREQ_BINS_NOTES, "hz")
        onset_indices, onset_values = notes.to_sparse_index(time_scale, "s", FREQ_BINS_NOTES, "hz", onsets_only=True)
        contour_indices, contour_values = notes.to_sparse_index(time_scale, "s", FREQ_BINS_CONTOURS, "hz")
        ex = _to_transcription_tfex(
            track_id,
            "guitarset",
            encode_wav(audio),
            note_indices,
            note_values,
            onset_indices,
            onset_values,
            contour_indices,
            contour_values,
            (n_time_frames, N_FREQ_BINS_NOTES),
            (n_time_frames, N_FREQ_BINS_CONTOURS),
        )
        with tf.io.TFRecordWriter(out_path) as w:
            w.write(ex.SerializeToString())
        counts[split] += 1
        print(f"{split:10s} {track_id}", file=sys.stderr)
    print(counts)


if __name__ == "__main__":
    main()
