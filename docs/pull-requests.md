# PR を出す

PR の大きさ・タイトル・本文・確かめることの決まり。本文の形は [.github/pull_request_template.md](../.github/pull_request_template.md) にある。GitHub の画面と、本文を指定しない `gh pr create` では自動で入る。`gh pr create --body` / `-F` で本文を渡すときは入らないので、同じ見出しと確認の項目に揃えて書く。

もとにしている考え方:
- [Google eng-practices](https://google.github.io/eng-practices/review/developer/) の「Small CLs」「Writing good CL descriptions」— 1 つの PR には目的を 1 つ。1 行目で何が変わるかが分かり、本文で理由が分かるように書く
- [Conventional Commits](https://www.conventionalcommits.org/ja/v1.0.0/) — タイトルの先頭に変更の種類を付ける(後ろは日本語)

## 流れ

1. Issue を立てる(小さな修正で要らなければ省く)
2. ブランチ `<種類>/<topic>` を切る(main で直接作業しない。同じリポジトリで別の作業が動いているなら worktree を分ける)
3. 実装し、下の「確かめること」を通す
4. PR を出す(下の決まり)
5. セルフレビュー(自分で差分を読み直す。Claude Code を使うなら `/code-review high`)。直したら「セルフレビュー対応」のコミットを足し、本文の「確認」を更新する
6. マージ(`gh pr merge --merge`)し、worktree とブランチを消す

## 大きさ

- 目的は 1 つ。「ついでの整理」は別の PR にする
- 差分の目安は 400 行以下(テスト・生成物・docs・学習の記録を除く)。超えるときは、分けられないか考え、分けないなら本文の「背景」に理由を書く

## タイトル

`<種類>: <何がどう変わるか>`。後ろは日本語で、1 行で読み切れる長さにする。

| 種類 | 使うとき | ブランチ |
|---|---|---|
| `feat` | 機能の追加・仕様の変更(使う人から見て変わる) | `feat/` |
| `fix` | 不具合の修正 | `fix/` |
| `refactor` | 動きを変えない整理 | `refactor/` |
| `test` | テストだけの追加・修正 | `test/` |
| `docs` | ドキュメントだけ | `docs/` |
| `chore` | ビルド・依存・train/ のスクリプトなど | `chore/` |

例: `feat: MusicXML の繰り返し記号を展開して採点する`

種類で PR を絞り込める(`gh pr list --state merged -L 1000 --json title -q '.[].title | select(startswith("feat:"))'`)。この決まりより前の PR(#1 など)には種類が付いていないので出てこない。

## 本文

テンプレートの 3 つの見出しを埋める。

- **背景**: なぜ変えるか。見た症状と日付、原因。決めたことの理由(ほかの案をやめた理由)もここに書く
- **変更**: 何を変えたか、箇条書きで。動きが変わる所・変えなかった所を書く
- **確認**: 下の表のうち当てはまるものと、その結果。まだのものは「これから」と書く

最後に `Closes #<Issue>`(閉じない関連 Issue は `Refs #<Issue>`)。

## 変更の種類ごとに確かめること

| 変更 | 確かめること |
|---|---|
| app/ | `cd app && npm run build`(tsc を含む)・`npm run lint` の結果 |
| 楽譜まわり(app/src/score) | `cd app && npm run test:score`(.ts をそのまま動かすので Node 22.18 以降) |
| 画面 | ブラウザのスクリーンショットを見せて OK をもらってからマージ |
| 採譜のモデル・学習や評価の処理(パスの直しなど結果が変わらないものは除く) | 評価の数字(GAPS・GuitarSet の F1)を変更前と並べる |
| すべて | セルフレビューの結果(何件中何件対応、対応しなかったものと理由) |
