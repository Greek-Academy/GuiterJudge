#!/usr/bin/env python
"""GAPS(クラシックギター独奏 + 演奏に合わせた MIDI)を Basic Pitch の学習用 TFRecord に変換する。

Basic Pitch 公式の data パイプラインは Apache Beam + mirdata + sox 前提で、GAPS のアダプタも無い。
ここでは Beam と sox を使わず、公式と同じ tf.train.Example の形(tf_example_serialization._to_transcription_tfex)を
直接組み立てる。出力レイアウトも公式の loader(tf_example_deserialization)がそのまま読める形にする:

    <out>/gaps/splits/{train,validation,test}/<track_id>.tfrecord

正解の作り方は公式の MAESTRO アダプタと同じ(MIDI のノートから notes / onsets、contours もノートで代用)。

    python train/prepare_gaps.py --gaps ~/dev/guitar/data/gaps --out ~/dev/guitar/data/tfrecords [--splits train,validation,test]

validation は GAPS の train split から曲 ID のハッシュで決定的に切り出す(既定 20 曲)。
test は GAPS の test split そのまま(評価にだけ使い、学習・early stopping には触れさせない)。
"""
import argparse
import csv
import hashlib
import io
import os
import sys

import numpy as np
import pretty_midi
import soundfile as sf
import tensorflow as tf
from mirdata.annotations import NoteData

from basic_pitch.constants import (
    ANNOTATION_HOP,
    AUDIO_SAMPLE_RATE,
    FREQ_BINS_CONTOURS,
    FREQ_BINS_NOTES,
    N_FREQ_BINS_CONTOURS,
    N_FREQ_BINS_NOTES,
)
from basic_pitch.data.tf_example_serialization import _to_transcription_tfex

N_VALIDATION = 20


def load_audio_22k_mono(path: str) -> np.ndarray:
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != AUDIO_SAMPLE_RATE:
        import resampy

        audio = resampy.resample(audio, sr, AUDIO_SAMPLE_RATE)
    return audio.astype(np.float32)


def encode_wav(audio: np.ndarray) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, AUDIO_SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def midi_notes(path: str) -> NoteData:
    pm = pretty_midi.PrettyMIDI(path)
    intervals = []
    pitches = []
    for inst in pm.instruments:
        for n in inst.notes:
            if n.end <= n.start:
                continue
            intervals.append([n.start, n.end])
            pitches.append(pretty_midi.note_number_to_hz(n.pitch))
    intervals = np.array(intervals, dtype=float).reshape(-1, 2)
    pitches = np.array(pitches, dtype=float)
    return NoteData(intervals, "s", pitches, "hz")


def to_example(track_id: str, wav_path: str, midi_path: str) -> tf.train.Example:
    audio = load_audio_22k_mono(wav_path)
    duration = len(audio) / AUDIO_SAMPLE_RATE
    notes = midi_notes(midi_path)
    # MIDI が音声より長いぶんは捨てる(公式と同じく time_scale は音声の長さで切る)
    time_scale = np.arange(0, duration + ANNOTATION_HOP, ANNOTATION_HOP)
    n_time_frames = len(time_scale)
    note_indices, note_values = notes.to_sparse_index(time_scale, "s", FREQ_BINS_NOTES, "hz")
    onset_indices, onset_values = notes.to_sparse_index(time_scale, "s", FREQ_BINS_NOTES, "hz", onsets_only=True)
    contour_indices, contour_values = notes.to_sparse_index(time_scale, "s", FREQ_BINS_CONTOURS, "hz")
    return _to_transcription_tfex(
        track_id,
        "gaps",
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


def assign_split(row: dict) -> str:
    if row["split"] == "test":
        return "test"
    if row["split"] != "train":
        return ""  # 未割り当ての 101 曲は使わない
    h = int(hashlib.sha1(row["id"].encode()).hexdigest(), 16)
    return "validation" if h % 270 < N_VALIDATION else "train"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gaps", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--splits", default="train,validation,test")
    ap.add_argument("--limit", type=int, default=0, help="動作確認用。split ごとの曲数上限")
    args = ap.parse_args()

    wanted = set(args.splits.split(","))
    rows = list(csv.DictReader(open(os.path.join(args.gaps, "gaps_metadata_with_splits.csv"), encoding="utf-8")))
    counts = {"train": 0, "validation": 0, "test": 0, "skipped_no_audio": 0}
    per_split_done = {"train": 0, "validation": 0, "test": 0}
    for row in rows:
        split = assign_split(row)
        if split not in wanted:
            continue
        if args.limit and per_split_done[split] >= args.limit:
            continue
        wav = os.path.join(args.gaps, row["audio_path"])
        mid = os.path.join(args.gaps, row["midi_path"])
        if not (os.path.exists(wav) and os.path.exists(mid)):
            counts["skipped_no_audio"] += 1
            continue
        out_dir = os.path.join(args.out, "gaps", "splits", split)
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, f"{row['id']}.tfrecord")
        if os.path.exists(out_path):
            per_split_done[split] += 1
            counts[split] += 1
            continue
        try:
            ex = to_example(row["id"], wav, mid)
        except Exception as e:  # noqa: BLE001  ダウンロード途中の wav 等。1曲で全体を止めない
            print(f"skip {row['id']}: {e}", file=sys.stderr)
            counts["skipped_no_audio"] += 1
            continue
        with tf.io.TFRecordWriter(out_path) as w:
            w.write(ex.SerializeToString())
        per_split_done[split] += 1
        counts[split] += 1
        print(f"{split:10s} {row['id']}  {row['title'][:40]}", file=sys.stderr)
    print(counts)


if __name__ == "__main__":
    main()
