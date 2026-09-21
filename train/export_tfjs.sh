#!/usr/bin/env bash
# ファインチューニング済み SavedModel(finetune.py の <run>/export)を TF.js のグラフモデルに変換し、
# 出力名が @spotify/basic-pitch の期待(Identity=contour, Identity_1=note, Identity_2=onset)と一致するか確かめる。
# tensorflowjs は TensorFlow のバージョンを自分で固定するので、学習用とは別の venv に入れる。
#
#   bash train/export_tfjs.sh <run>/export <出力ディレクトリ>
#   例: bash train/export_tfjs.sh ~/dev/guitar-data/runs/gaps-ft/20260920-1200/export ~/dev/guitar-data/runs/gaps-ft/20260920-1200/tfjs
#
# 差し替え: cp <出力>/model.json <出力>/group1-shard1of1.bin app/public/model/  (元のモデルは git に残っているので戻せる)
set -euo pipefail
SRC="$1"; OUT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv-tfjs"
if [ ! -x "$VENV/bin/tensorflowjs_converter" ]; then
  /opt/homebrew/bin/python3.11 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q tensorflowjs
  # tensorflow_hub が pkg_resources を使う。setuptools 80 以降には無いので旧系を入れる
  "$VENV/bin/pip" install -q "setuptools<80"
fi
# tensorflowjs が連れてくる tensorflow_decision_forests は protobuf の世代不一致(gencode 6.x vs runtime 5.x)で
# import 時に落ちる。converter は無条件に import するが、決定木モデル以外の変換には使わないので、
# 中身の無いスタブに置き換えて import だけ通す
"$VENV/bin/pip" uninstall -q -y tensorflow_decision_forests 2>/dev/null || true
SITE="$("$VENV/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
mkdir -p "$SITE/tensorflow_decision_forests"
echo '# stub: tensorflowjs_converter の無条件 import を通すためだけの空パッケージ(train/export_tfjs.sh が作る)' > "$SITE/tensorflow_decision_forests/__init__.py"
mkdir -p "$OUT"
"$VENV/bin/tensorflowjs_converter" --input_format=tf_saved_model --output_format=tfjs_graph_model \
  --signature_name=serving_default --saved_model_tags=serve "$SRC" "$OUT"
python3 - "$OUT/model.json" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
sig = m.get("signature", {})
print("inputs :", {k: v["name"] for k, v in sig.get("inputs", {}).items()})
print("outputs:", {k: v["name"] for k, v in sig.get("outputs", {}).items()})
names = {v["name"].split(":")[0] for v in sig.get("outputs", {}).values()}
need = {"Identity", "Identity_1", "Identity_2"}
print("OK: 出力名は @spotify/basic-pitch の期待と一致" if need <= names else f"NG: 出力名が {need} と違う。inference.ts の OUTPUT_TO_TENSOR_NAME に合わせて要調整")
EOF
ls -la "$OUT"
