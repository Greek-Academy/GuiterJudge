# Basic Pitch のファインチューニング(クラシックギター向け)

アプリの音符起こしは Spotify の Basic Pitch(ICASSP 2022 公開重み、TF.js)を使っている。
GAPS(クラシックギター独奏の実演奏 + 音符アラインメント)で測ったところ、音符レベル F1 は 80%、
取りこぼしは低音弦・速いパッセージ・短い音価に集中していた(SPEC.md 10 節)。
このディレクトリは、その公開重みを GAPS で追加学習し、TF.js に変換してアプリのモデルを差し替えるための一式。

Basic Pitch 公式の学習コード(Apache 2.0)を使う。公式の `train.py` は毎回モデルを新規に作るので、
公開重みを読んで学習を続ける `finetune.py` を別に置いた。データ変換は公式の Apache Beam + sox 経路を使わず、
同じ TFRecord 形式を直接組み立てる(`prepare_gaps.py`)。

## 環境

Apple Silicon の Mac、Python 3.11(Homebrew)。TensorFlow 2.15 + Metal。

```sh
cd train
/opt/homebrew/bin/python3.11 -m venv .venv && . .venv/bin/activate
pip install "tensorflow==2.15.1" "tensorflow-metal==1.1.0" "basic-pitch==0.4.0" mirdata pretty_midi soundfile resampy sox "setuptools<80"
```

- `setuptools<80`: resampy と tensorflow_hub が `pkg_resources` を使うため
- `sox`(Python パッケージ): basic_pitch の serialization モジュールが import するだけ。sox 本体は要らない
- TF.js 変換は `export_tfjs.sh` が別の venv(`.venv-tfjs`)を自動で作る。tensorflowjs は TensorFlow の版を自分で固定するので学習用と混ぜない

## データ

`app/eval/fetch-datasets.sh gaps-all` で `~/dev/guitar/data/gaps/` に音声 404 本と MIDI。

```sh
python prepare_gaps.py --gaps ~/dev/guitar/data/gaps --out ~/dev/guitar/data/tfrecords
```

- GAPS の train split(270 曲)から曲 ID のハッシュで 20 曲を validation に切り出す。test split(30 曲)は学習にも early stopping にも使わない
- 未割り当ての 101 曲は使わない
- 正解は公式の MAESTRO アダプタと同じ作り方(MIDI のノートから notes / onsets、contours もノートで代用)
- 音声は 22050Hz モノラルに落として WAV バイト列のまま TFRecord に入れる(公式ローダがその場でデコードする)
- 1 曲 1 ファイル。`--limit N` で動作確認

## 学習

```sh
python finetune.py --data ~/dev/guitar/data/tfrecords --out ~/dev/guitar/data/runs/gaps-ft \
    --epochs 60 --steps-per-epoch 200 --batch-size 16 --lr 1e-4
```

- 公開重み(`basic_pitch/saved_models/icassp_2022/nmp`)を Keras モデルとして読み、公式と同じ損失(BCE、ラベルスムージング 0.2)
- onset 損失だけ差し替えられる(`--onset-neighbor-frames N`: 正解の前後 N フレームを損失から外す、`--onset-pos-weight`: 正例の重み、`--onset-smoothing`)。
  既定値では公式と一致する。run A で onset の確率が全体に下がった対策(下記「判断の記録」)
- 学習率は公式既定 1e-3 の 1/10。ReduceLROnPlateau と EarlyStopping(patience 10、最良の重みに戻す)
- 学習前の検証損失を `baseline.txt` に残す(= 公開重みそのままの値)。これより下がらなければ差し替えない
- 出力: `<out>/<timestamp>/model.best`(Keras SavedModel)、`export`(TF.js 変換用に出力名を揃えた SavedModel)、`history.csv`、TensorBoard ログ

## TF.js への変換と差し替え

```sh
bash export_tfjs.sh ~/dev/guitar/data/runs/gaps-ft/<timestamp>/export ~/dev/guitar/data/runs/gaps-ft/<timestamp>/tfjs
```

`@spotify/basic-pitch` は出力テンソルを名前で読む(`Identity` = contour、`Identity_1` = note、`Identity_2` = onset)。
スクリプトが変換後の `model.json` の署名を確認して一致を表示する。

差し替えは `tfjs/model.json` と `tfjs/group1-shard1of1.bin` を `app/public/model/` にコピーするだけ。
元のモデルは git に残っているので `git checkout app/public/model` で戻せる。

## 評価

学習前後を同じ土俵で比べる。`app/eval/gaps-harness.ts` の手順でヘッドレス Chrome に本番の `transcribe()` を載せ、
`model` を差し替えて GAPS test 30 曲を回し、`gaps-notes.mjs` で採点する。

疎通確認(2026-09-21): test 3 曲を短時間学習した重みで一巡させたところ、変換後の TF.js モデルは元と同じ音符数・同じ F1 を出した
(重みがほぼ動いていないので一致するのが正しい)。出力名の対応も一致。

## 公開モデルをそのまま使う(リモート推論、暫定)

GAPS 論文の著者が公開している学習済みモデル(`guitar-gaps.pth`、MIT)は GAPS test で F1 94.7%、GuitarSet test で 90.4%(Basic Pitch は 81 / 82%)。
99 MB の CRNN でブラウザには載らないので、Mac の Python で動かし、アプリから音声を送って使う。

```sh
/opt/homebrew/bin/python3.11 -m venv .venv-hfmt && .venv-hfmt/bin/pip install "git+https://github.com/xavriley/hf_midi_transcription" soxr mido onnx onnxruntime
.venv-hfmt/bin/midi_transcription some.wav out.mid --instrument guitar     # 初回に重みを ~/.cache/huggingface に落とす
.venv-hfmt/bin/python serve_transcribe.py --port 8770                     # 0.0.0.0 で待つ。--device mps も可(速さは CPU と同程度)
```

アプリの「音符起こし検証」画面の「0. 推論エンジン」に `http://<Mac の LAN IP>:8770` を入れると、その端末では本番の録音→診断もこのサーバを使う(設定は localStorage)。
空にすれば Basic Pitch に戻る。スマホから使うときは、アプリ側を LAN で開けるようにする(`vite --host`)必要がある。マイクは安全なコンテキストでしか使えないので、
http の LAN アドレスではスマホの録音が動かない。`@vitejs/plugin-basic-ssl` で https にするか、Mac で録音したファイルを読み込む形で試す。

評価と比較は `eval_hfmt.py`(GAPS / GuitarSet test を MIDI に書き出す)と `app/eval/midi-score.mjs`。ONNX 変換とブラウザ内推論の実測、蒸留の計画は `FINETUNE_NOTES.md` 11〜12 節。

## 蒸留(公開モデル → ブラウザで動く 4 MB の生徒)

```sh
.venv-hfmt/bin/python distill_labels.py --shifts 0,-2,2                 # 段階 1: 教師のソフトラベル(~/dev/guitar/data/distill/、8.7 GB、単独で約 4 時間)
.venv-hfmt/bin/python distill.py --preset m --steps 350 --epochs 30      # 段階 2: 学習(MPS、約 8 時間)。出力 ~/dev/guitar/data/runs/distill/<timestamp>/
.venv-hfmt/bin/python eval_student.py <run-dir> --ckpt model.last.pt    # GAPS / GuitarSet test を広い閾値グリッドで採点し ONNX を書く
cp <run-dir>/model.last.onnx ../app/public/student/model.onnx           # アプリに載せる(ブラウザ側は app/src/student/)
```

- 生徒は `student.py`(教師と同じ骨格 1 本 + onset 精密化 GRU、プリセット s / m / l)。v2 = m で GAPS test F1 90.1 / GuitarSet 88.2(教師 94.7 / 90.4、Basic Pitch 81 / 82)
- 後処理は onset 0.3 / frame ゲート 0.8(`app/src/student/postprocess.ts` と同じ)。経緯は `FINETUNE_NOTES.md` 12〜18 節
- 既存の重みから追加学習: `distill.py --init <run-dir>/model.last.pt --lr 2.5e-4 --sched cosine --lr-min 1e-5 --pos-weight-onset 1 --pos-weight-frame 1 --pos-weight-anneal 0`(v3、`FINETUNE_NOTES.md` 19 節)。重みだけ読み、学習前に一度評価して `init:` 行に出す

### 段階 1 の詳細

```sh
.venv-hfmt/bin/python distill_labels.py --shifts 0,-2,2      # ~/dev/guitar/data/distill/<dataset>/<split>/<id>_s<shift>.npz
```

GAPS train(tfrecords の validation 9 曲は validation)と GuitarSet 奏者 00〜03(04 は validation)に教師をかけ、onset / frame(100 fps × 88、uint8)、
シフト済みの正解音符列、16 kHz 音声(int16)を保存する。ピッチシフトはリサンプリングによる速度変更(音高と時間が同時に変わる、安価)。
教師は実時間の約 0.045 倍なので 15.5 時間 × 3 シフトで約 2 時間。途中で止めても再実行で続きから。

## 判断の記録

成果の整理と差し替え判断の材料は `FINETUNE_NOTES.md`(リポジトリのルート)。

- run A(GAPS 単独、公式の損失、lr 1e-4、45 エポック): 検証損失は 1.030 → 1.011 と下がったが、GAPS test で既定閾値(onset 0.7 / frame 0.5)の F1 は 80.2 → 61.8%。
  閾値スイープ(`app/eval/gaps-sweep.mjs`)で onset の確率が全体に下がっていることが分かった(onset 閾値 0.4 以上で結果が変わらない)。
  最良閾値同士でも 元 81.1%(0.7/0.4)vs ft 79.8%(0.2/0.4)で差し替えなし。
  原因の見立て: GAPS の MIDI アラインメントには数フレームのずれが残り、正解の隣のフレームを負例として罰されるとピークを立てられなくなる。
  run B は onset 損失を「隣接フレームを無視、正例を重く」に変えて同条件で学習する。評価は毎回スイープの最良同士で比べる
- run B / C-1(onset 損失差し替え、GAPS 単独)/ C-2(GuitarSet 3 割混合): GAPS では元を 0.6〜1.1 pt 上回るが、GuitarSet test 60 クリップでは 3〜7 pt 下回る(ストロークの再現率低下が主)。
  **差し替えは見送り、元モデルを維持**(2026-09-21)。詳細は `FINETUNE_NOTES.md` 10 節

- 一から学習しない: モデルはすでに GuitarSet などで学習済みで、GAPS の 14.8 時間はそれを上書きするには少なく、寄せるには十分
- GAPS は CC BY-NC-SA 4.0(Zenodo 版)。商用化の予定が無いことを確認した上で学習に使っている。データはリポジトリに入れない
