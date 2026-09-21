#!/usr/bin/env python
"""Basic Pitch(ICASSP 2022 の公開重み)を GAPS でファインチューニングする。

公式の train.py は毎回モデルを新規に作る(重みを読まない)ので、ここでは公開済みの SavedModel
(basic_pitch/saved_models/icassp_2022/nmp)を Keras モデルとして読み、同じ損失・同じデータローダで学習を続ける。
データは prepare_gaps.py が作った TFRecord(<data>/gaps/splits/{train,validation}/)。

    python train/finetune.py --data ~/dev/guitar-data/tfrecords --out ~/dev/guitar-data/runs/gaps-ft \
        --epochs 60 --steps-per-epoch 200 --batch-size 16 --lr 1e-4

学習後は <out>/<timestamp>/model.best(SavedModel)と <out>/<timestamp>/export(TF.js 変換用に出力名を揃えた SavedModel)ができる。
"""
import argparse
import logging
import os
from datetime import datetime, timezone

import numpy as np
import tensorflow as tf

import basic_pitch
from basic_pitch import models
from basic_pitch.data import tf_example_deserialization

logging.basicConfig(level=logging.INFO)

PRETRAINED = os.path.join(os.path.dirname(basic_pitch.__file__), "saved_models", "icassp_2022", "nmp")


def load_pretrained() -> tf.keras.Model:
    """公開重みを Keras モデルとして読む。読めない場合は公式のアーキテクチャを組んで重みだけ写す"""
    try:
        model = tf.keras.models.load_model(PRETRAINED, compile=False)
        logging.info("loaded pretrained keras model from %s", PRETRAINED)
        return model
    except Exception as e:  # noqa: BLE001
        logging.warning("keras load failed (%s); rebuilding architecture and copying weights", e)
        fresh = models.model()
        loaded = tf.saved_model.load(PRETRAINED)
        fresh.set_weights([v.numpy() for v in loaded.variables])
        return fresh


def export_for_tfjs(model: tf.keras.Model, path: str) -> None:
    """TF.js 側(@spotify/basic-pitch)は出力を Identity / Identity_1 / Identity_2 の名前で
    contour / note / onset として読む。この順番で出力する tf.function を serving_default にして保存する。"""

    @tf.function(input_signature=[tf.TensorSpec([None, model.input_shape[1], 1], tf.float32, name="input_2")])
    def serve(x):
        out = model(x, training=False)
        if isinstance(out, dict):
            return {"contour": out["contour"], "note": out["note"], "onset": out["onset"]}
        return {"contour": out[0], "note": out[1], "onset": out[2]}

    tf.saved_model.save(model, path, signatures={"serving_default": serve})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--steps-per-epoch", type=int, default=200)
    ap.add_argument("--validation-steps", type=int, default=20)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--shuffle-size", type=int, default=100)
    ap.add_argument("--lr", type=float, default=1e-4, help="ファインチューニングなので公式既定 1e-3 より一桁小さく")
    ap.add_argument("--patience", type=int, default=10)
    ap.add_argument("--datasets", default="gaps", help="使う TFRecord データセット名(カンマ区切り)。例: gaps,guitarset")
    ap.add_argument("--weights", default="", help="データセットのサンプリング比(カンマ区切り、省略時は均等)。例: 0.7,0.3")
    ap.add_argument("--export-only", default="", help="学習せず、この SavedModel を TF.js 用に再保存するだけ")
    args = ap.parse_args()

    if args.export_only:
        model = tf.keras.models.load_model(args.export_only, compile=False)
        export_for_tfjs(model, os.path.join(os.path.dirname(args.export_only.rstrip("/")), "export"))
        return

    model = load_pretrained()
    model.summary(print_fn=logging.info)
    logging.info("outputs: %s", [o.name for o in model.outputs])

    datasets = args.datasets.split(",")
    weights = np.array([float(w) for w in args.weights.split(",")]) if args.weights else np.ones(len(datasets))
    weights = weights / weights.sum()
    logging.info("datasets %s weights %s", datasets, weights)
    train_ds, val_ds = tf_example_deserialization.prepare_datasets(
        args.data, args.shuffle_size, args.batch_size, args.validation_steps, datasets, weights
    )

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    run_dir = os.path.join(args.out, stamp)
    os.makedirs(run_dir, exist_ok=True)
    callbacks = [
        tf.keras.callbacks.TensorBoard(log_dir=os.path.join(run_dir, "tensorboard")),
        tf.keras.callbacks.EarlyStopping(patience=args.patience, verbose=1, restore_best_weights=True),
        tf.keras.callbacks.ReduceLROnPlateau(verbose=1, patience=max(3, args.patience // 2), factor=0.5),
        tf.keras.callbacks.ModelCheckpoint(filepath=os.path.join(run_dir, "model.best"), save_best_only=True),
        tf.keras.callbacks.CSVLogger(os.path.join(run_dir, "history.csv")),
    ]
    model.compile(
        loss=models.loss(),
        optimizer=tf.keras.optimizers.Adam(args.lr),
        sample_weight_mode={"contour": None, "note": None, "onset": None},
    )
    # 学習前の検証損失(= 公開重みそのままの値)を基準として残す
    base = model.evaluate(val_ds, steps=args.validation_steps, verbose=0, return_dict=True)
    logging.info("baseline (pretrained) validation: %s", base)
    with open(os.path.join(run_dir, "baseline.txt"), "w") as f:
        f.write(str(base) + "\n")
    with open(os.path.join(run_dir, "args.txt"), "w") as f:
        f.write(str(vars(args)) + "\n")

    model.fit(
        train_ds,
        epochs=args.epochs,
        steps_per_epoch=args.steps_per_epoch,
        validation_data=val_ds,
        validation_steps=args.validation_steps,
        callbacks=callbacks,
    )
    export_for_tfjs(model, os.path.join(run_dir, "export"))
    logging.info("done: %s", run_dir)


if __name__ == "__main__":
    main()
