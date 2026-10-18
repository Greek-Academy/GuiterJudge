"""データの置き場所(データセット・学習の成果物・評価結果)。リポジトリの外に置く。

既定は ~/dev/guitar/data。環境変数 GUITAR_DATA_DIR で変えられる。
移動前の ~/dev/guitar-data しかなければ、そちらを使う。
"""
import os


def data_dir():
    env = os.environ.get("GUITAR_DATA_DIR")
    if env:
        return os.path.expanduser(env)
    new = os.path.expanduser("~/dev/guitar/data")
    old = os.path.expanduser("~/dev/guitar-data")
    return old if not os.path.isdir(new) and os.path.isdir(old) else new
