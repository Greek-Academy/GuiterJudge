const pptxgen = require('pptxgenjs');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const Fi = require('react-icons/fi');
const sharp = require('sharp');

const OUT = require('path').join(__dirname, 'guitar_diagnosis_midterm_slides.pptx');
const JP = 'Hiragino Sans';
const C = { walnut: '3A2A21', amber: 'D9822B', ink: '2B2B2B', gray: '6E6E6E', light: 'F2F2F2', white: 'FFFFFF', green: '3F7D58', red: 'C0392B', paleAmber: 'F7E6D3', line: 'CFCFCF', dim: 'B9AEA6', blue: '3D6B9E', paleBlue: 'DCE6F2' };

async function icon(name, color) {
  let svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Fi[name], { size: 256 }));
  svg = svg.replace(/currentColor/g, '#' + color);
  const buf = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
  return 'image/png;base64,' + buf.toString('base64');
}
const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.author = 'yk'; pres.title = 'ギター上達診断アプリ 中間報告';
let pageNo = 0;
function base(dark = false) {
  const s = pres.addSlide(); pageNo++;
  s.background = { color: dark ? C.walnut : C.white };
  s.addText(String(pageNo), { x: 9.2, y: 5.2, w: 0.5, h: 0.3, fontSize: 9, color: dark ? C.dim : C.gray, align: 'right', fontFace: JP, isTextBox: true, margin: 0 });
  return s;
}
function header(s, title, sub) {
  s.addText(title, { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 26, bold: true, color: C.walnut, fontFace: JP, isTextBox: true, margin: 0 });
  if (sub) s.addText(sub, { x: 0.5, y: 0.9, w: 9, h: 0.35, fontSize: 12, color: C.gray, fontFace: JP, isTextBox: true, margin: 0 });
}
function iconCircle(s, x, y, d, img, fill = C.amber) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill, width: 0 } });
  const pad = d * 0.25; s.addImage({ data: img, x: x + pad, y: y + pad, w: d - 2 * pad, h: d - 2 * pad });
}
function card(s, x, y, w, h, fill = C.light) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: fill, width: 0 }, rectRadius: 0.08 });
}
function text(s, t, o) { s.addText(t, Object.assign({ fontFace: JP, isTextBox: true, margin: 0, color: C.ink, fontSize: 13, valign: 'top' }, o)); }
function bullets(s, items, o) {
  const arr = items.map((t, i) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: i < items.length - 1, paraSpaceAfter: 5 } }));
  s.addText(arr, Object.assign({ fontFace: JP, isTextBox: true, margin: 0, color: C.ink, fontSize: 12.5, valign: 'top' }, o));
}
function arrow(s, x1, y1, x2, y2, color = C.gray) {
  s.addShape(pres.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color, width: 1.5, endArrowType: 'triangle' } });
}
function staffLines(s, x, y, w, color, gap = 0.11) { for (let i = 0; i < 5; i++) s.addShape(pres.ShapeType.line, { x, y: y + i * gap, w, h: 0, line: { color, width: 0.75 } }); }
function stat(s, x, y, w, big, label, sub, col = C.amber) {
  card(s, x, y, w, 1.55);
  text(s, big, { x: x + 0.2, y: y + 0.1, w: w - 0.4, h: 0.7, fontSize: 30, bold: true, color: col });
  text(s, label, { x: x + 0.2, y: y + 0.8, w: w - 0.4, h: 0.3, fontSize: 12, bold: true, color: C.walnut });
  if (sub) text(s, sub, { x: x + 0.2, y: y + 1.1, w: w - 0.4, h: 0.4, fontSize: 9.5, color: C.gray });
}
const hdr = () => ({ bold: true, color: C.white, fill: { color: C.walnut }, fontFace: JP, fontSize: 11.5, align: 'center', valign: 'middle' });
const cell = (o = {}) => Object.assign({ color: C.ink, fontFace: JP, fontSize: 11.5, valign: 'middle', align: 'center' }, o);

(async () => {
  const ic = {};
  for (const n of ['FiMic', 'FiCpu', 'FiClock', 'FiTarget', 'FiTrendingUp', 'FiUser', 'FiCheckCircle', 'FiXCircle', 'FiAlertTriangle', 'FiMusic', 'FiLayers', 'FiActivity', 'FiMonitor', 'FiSearch', 'FiGitBranch', 'FiFlag']) ic[n] = await icon(n, C.white);
  const icGreen = await icon('FiCheckCircle', C.green);
  const icRed = await icon('FiXCircle', C.red);

  // 1 Title
  { const s = base(true);
    staffLines(s, 5.6, 1.5, 4.4, '6B5545', 0.22);
    [[6.0, 1.61], [6.7, 1.83], [7.4, 1.72], [8.1, 1.94], [8.9, 1.61]].forEach(([x, y]) => {
      s.addShape(pres.ShapeType.ellipse, { x, y: y - 0.09, w: 0.26, h: 0.18, fill: { color: C.amber }, line: { color: C.amber, width: 0 } });
      s.addShape(pres.ShapeType.line, { x: x + 0.25, y: y - 0.7, w: 0, h: 0.7, line: { color: C.amber, width: 1.5 } });
    });
    text(s, 'Alpha+ プロジェクト ｜ 中間報告（3ヶ月の成果）', { x: 0.6, y: 1.1, w: 6, h: 0.35, fontSize: 12, color: C.dim });
    text(s, 'ギター上達診断\nアプリ', { x: 0.6, y: 1.55, w: 6, h: 1.7, fontSize: 40, bold: true, color: C.white, lineSpacingMultiple: 1.05 });
    text(s, '過去の自分と比較して、練習の停滞と伸びを可視化する', { x: 0.6, y: 3.45, w: 7, h: 0.5, fontSize: 18, color: C.amber });
    text(s, '2026年9月', { x: 0.6, y: 4.6, w: 4, h: 0.3, fontSize: 12, color: C.dim });
    s.addNotes('評価してほしいのは機能数ではなく「リスクを特定 → 実測 → 判断」の筋。'); }

  // 2 Problem & approach
  { const s = base();
    header(s, '課題と狙い', '独学で伸び悩む社会人ギタリストのための、診断ファーストの練習伴走アプリ');
    card(s, 0.5, 1.5, 4.3, 3.3, C.light);
    text(s, '課題', { x: 0.75, y: 1.65, w: 3.8, h: 0.4, fontSize: 16, bold: true, color: C.gray });
    bullets(s, ['一人で練習しても、自分の演奏の良し悪しが客観視できない', '何を練習すべきか設計できず、なんとなく弾いて終わる', '上達の実感がなく、練習が途切れる'], { x: 0.75, y: 2.15, w: 3.8, h: 2.5, fontSize: 13 });
    card(s, 5.2, 1.5, 4.3, 3.3, C.paleAmber);
    text(s, '狙い', { x: 5.45, y: 1.65, w: 3.8, h: 0.4, fontSize: 16, bold: true, color: C.walnut });
    bullets(s, ['引っかかるフレーズを「スレッド」にして録音を重ねる', '過去の自分の演奏と比較し、どこが伸びてどこが停滞しているかを具体的に見せる', '曲・基礎練・ソロを問わず、外部の「正解データ」なしで使える'], { x: 5.45, y: 2.15, w: 3.8, h: 2.5, fontSize: 13 });
    text(s, '想定ユーザー：30代社会人、ギター歴3年、独学。弾きたい曲は弾けるが上達が頭打ち。', { x: 0.5, y: 4.95, w: 9, h: 0.3, fontSize: 11.5, color: C.gray });
    s.addNotes('PRD は 8/14。既存アプリはカリキュラム消化型で、練習中の「何にでも」は使えない。'); }

  // 3 vs existing
  { const s = base();
    header(s, '既存アプリとの違い', 'カリキュラムを消化するのではなく、自分の弱点をその場で診断する');
    const rows = [
      [{ text: '', options: hdr() }, { text: '既存アプリ（Yousician 等）', options: hdr() }, { text: '本アプリ', options: Object.assign(hdr(), { fill: { color: C.amber } }) }],
      [{ text: 'アプローチ', options: cell({ bold: true }) }, { text: '用意されたカリキュラムを消化', options: cell() }, { text: '自分の弱点をその場で診断', options: cell({ fill: { color: C.paleAmber }, bold: true, color: C.walnut }) }],
      [{ text: '対象', options: cell({ bold: true }) }, { text: 'アプリのライブラリ内の曲', options: cell() }, { text: '練習中の何にでも対応', options: cell({ fill: { color: C.paleAmber }, bold: true, color: C.walnut }) }],
      [{ text: '進捗の見え方', options: cell({ bold: true }) }, { text: 'ゲーム内スコア・正解率', options: cell() }, { text: '自分の過去の演奏との比較', options: cell({ fill: { color: C.paleAmber }, bold: true, color: C.walnut }) }],
      [{ text: '必要なデータ', options: cell({ bold: true }) }, { text: '曲 DB・タブ譜・コード進行', options: cell() }, { text: '自分の録音だけ', options: cell({ fill: { color: C.paleAmber }, bold: true, color: C.walnut }) }],
    ];
    s.addTable(rows, { x: 0.5, y: 1.5, w: 9, colW: [1.8, 3.6, 3.6], rowH: [0.5, 0.6, 0.6, 0.6, 0.6], border: { type: 'solid', color: C.white, pt: 2 }, fill: { color: C.light } });
    text(s, '完全クライアントサイド。バックエンドもアカウントもなく、音声は端末から出ない。', { x: 0.5, y: 4.6, w: 9, h: 0.4, fontSize: 13, bold: true, color: C.walnut });
    s.addNotes(''); }

  // 4 What we built
  { const s = base();
    header(s, '作ったもの：動く MVP（PWA）', 'React + TypeScript + Vite / Basic Pitch（TensorFlow.js）/ Dexie（IndexedDB）。約1,700行');
    const screens = [
      ['FiLayers', 'スレッド一覧', 'アクティブ／解決済み／曲通し。デモデータ投入、バックアップの書き出しと読み込み'],
      ['FiMic', 'スレッド詳細', '録音の開始・停止で解析と診断まで自動実行。メトロノーム録音、お手本の設定、指標の推移グラフ'],
      ['FiActivity', '診断結果', '比較モード（直前／ベスト／お手本）。指標6種と、ピアノロールで「どの音がどうズレたか」'],
      ['FiSearch', '音符起こし検証（開発用）', '実録音の検証用。閾値の 36 通り総当たり、期待音符列との照合、倍音候補の印'],
    ];
    screens.forEach(([i, t, d], k) => {
      const x = 0.5 + (k % 2) * 4.6, y = 1.5 + Math.floor(k / 2) * 1.6;
      card(s, x, y, 4.4, 1.4);
      iconCircle(s, x + 0.2, y + 0.3, 0.6, ic[i]);
      text(s, t, { x: x + 1.0, y: y + 0.15, w: 3.2, h: 0.35, fontSize: 14, bold: true, color: C.walnut });
      text(s, d, { x: x + 1.0, y: y + 0.52, w: 3.2, h: 0.85, fontSize: 11, color: C.ink });
    });
    text(s, 'マイク録音のほか、音声・動画ファイルの取り込みに対応。OS のダイアログは使わず、プロジェクタ投影を想定した画面内 UI。', { x: 0.5, y: 4.8, w: 9, h: 0.4, fontSize: 11.5, color: C.gray });
    s.addNotes('デモは合成音の19テイクをブラウザで実際に解析して作っている。スコアを埋め込んでいるのではない。'); }

  // 4b Architecture
  { const s = base();
    header(s, '仕組み①：構成', 'すべてブラウザの中で完結する PWA。サーバーもアカウントもなく、音声は端末から出ない');
    const fx = 0.5, fy = 1.45, fw = 6.9, fh = 3.55;
    s.addShape(pres.ShapeType.roundRect, { x: fx, y: fy, w: fw, h: fh, fill: { color: C.white }, line: { color: C.walnut, width: 1.5 }, rectRadius: 0.08 });
    text(s, 'ブラウザ（PWA）', { x: fx + 0.2, y: fy + 0.08, w: 3, h: 0.3, fontSize: 12, bold: true, color: C.walnut });
    const band = (y, h, label, tech, boxes, fill) => {
      text(s, label, { x: fx + 0.2, y: y + 0.05, w: 1.35, h: 0.3, fontSize: 12, bold: true, color: C.walnut });
      text(s, tech, { x: fx + 0.2, y: y + 0.35, w: 1.35, h: h - 0.4, fontSize: 9, color: C.gray });
      const bx = fx + 1.65, bw = fw - 1.85, g = 0.08, w = (bw - g * (boxes.length - 1)) / boxes.length;
      boxes.forEach(([t, sub, dark], k) => {
        const x = bx + k * (w + g), f = dark ? C.walnut : fill;
        s.addShape(pres.ShapeType.roundRect, { x, y, w, h, fill: { color: f }, line: { color: f, width: 0 }, rectRadius: 0.05 });
        text(s, t, { x: x + 0.05, y: y + 0.06, w: w - 0.1, h: 0.3, fontSize: 10, bold: true, color: dark ? C.white : C.ink, align: 'center' });
        if (sub) text(s, sub, { x: x + 0.05, y: y + 0.36, w: w - 0.1, h: h - 0.4, fontSize: 8, color: dark ? C.dim : C.gray, align: 'center' });
      });
    };
    band(fy + 0.45, 0.8, '画面', 'React + TypeScript\n4 画面', [
      ['スレッド一覧', 'アクティブ／解決済み\nデモ投入'], ['スレッド詳細', '録音・メトロノーム\n指標の推移'], ['診断結果', '比較モード\nピアノロール'], ['音符起こし検証', '開発用']], C.light);
    arrow(s, fx + 4.0, fy + 1.25, fx + 4.0, fy + 1.4, C.gray);
    band(fy + 1.4, 1.1, '処理', 'TypeScript\nUI スレッド上で実行', [
      ['録音', 'MediaRecorder\nWeb Audio'], ['前処理', '22050Hz 化\nトリム・正規化'], ['音符起こし', 'Basic Pitch\n(TensorFlow.js)\nモデル同梱', true], ['後処理', '分割統合\n倍音除外'], ['比較・診断', 'アライメント\nms 指標・格子']], C.paleBlue);
    arrow(s, fx + 4.0, fy + 2.5, fx + 4.0, fy + 2.65, C.gray);
    band(fy + 2.65, 0.75, '保存', 'IndexedDB（Dexie）\n端末内のみ', [
      ['スレッド', '課題フレーズ単位'], ['テイク', '音声 + 音符列'], ['診断結果', '指標・対応付け'], ['バックアップ', 'JSON 書き出し']], C.light);
    // right column
    card(s, 7.7, 1.45, 1.8, 1.5, C.light);
    text(s, '配信', { x: 7.85, y: 1.55, w: 1.5, h: 0.3, fontSize: 12, bold: true, color: C.walnut });
    text(s, 'Vite でビルドした静的ファイル。Service Worker が推論モデルごとオフラインにキャッシュ', { x: 7.85, y: 1.88, w: 1.5, h: 1.0, fontSize: 9, color: C.ink });
    s.addShape(pres.ShapeType.roundRect, { x: 7.7, y: 3.15, w: 1.8, h: 1.85, fill: { color: C.white }, line: { color: C.red, width: 1.5, dashType: 'dash' }, rectRadius: 0.08 });
    text(s, 'サーバー', { x: 7.85, y: 3.25, w: 1.5, h: 0.3, fontSize: 12, bold: true, color: C.red });
    text(s, 'なし', { x: 7.85, y: 3.55, w: 1.5, h: 0.5, fontSize: 24, bold: true, color: C.red });
    text(s, '録音も推論も端末内。外部通信は初回のアプリ配信だけ', { x: 7.85, y: 4.1, w: 1.5, h: 0.85, fontSize: 9, color: C.ink });
    s.addNotes('約 1,700 行。音符起こしの認識技術は自作せず、Spotify の学習済みモデルをブラウザで動かしている。Web Worker は使っておらず、初回推論のコストはウォームアップで隠している。'); }

  // 5 Pipeline
  { const s = base();
    header(s, '仕組み②：録音から診断まで', 'すべてブラウザ内。音符起こしは Spotify の学習済みモデル Basic Pitch を使い、認識技術を自作しない');
    const box = (x, y, w, t, sub, fill, tc = C.ink) => {
      s.addShape(pres.ShapeType.roundRect, { x, y, w, h: 1.05, fill: { color: fill }, line: { color: fill, width: 0 }, rectRadius: 0.06 });
      text(s, t, { x: x + 0.08, y: y + 0.08, w: w - 0.16, h: 0.3, fontSize: 11.5, bold: true, color: tc, align: 'center' });
      text(s, sub, { x: x + 0.08, y: y + 0.4, w: w - 0.16, h: 0.6, fontSize: 9, color: tc === C.white ? C.dim : C.gray, align: 'center' });
    };
    const y = 1.6; const items = [
      ['録音', 'MediaRecorder\nメトロノーム・カウントイン', C.light], ['前処理', '22050Hz モノラル\n無音トリム・正規化', C.light],
      ['音符起こし', 'Basic Pitch\n閾値 0.7 / 0.5、音域 E2〜E6', C.walnut], ['分割統合', '同音高 150ms 以内の\n再オンセットを畳む', C.light],
      ['アライメント', '編集距離ベースで\n音符同士を対応付け', C.light], ['指標・可視化', 'ms 単位の分解指標\nピアノロール・推移', C.paleAmber],
    ];
    const w = 1.42, g = 0.096; items.forEach(([t, sub, fill], k) => { const x = 0.5 + k * (w + g); box(x, y, w, t, sub, fill, fill === C.walnut ? C.white : C.ink); if (k < items.length - 1) arrow(s, x + w, y + 0.52, x + w + g, y + 0.52, C.gray); });
    card(s, 0.5, 3.0, 9.0, 1.9, C.light);
    text(s, '出す指標（作り直し後）', { x: 0.75, y: 3.12, w: 5, h: 0.3, fontSize: 12.5, bold: true, color: C.walnut });
    bullets(s, ['相対（比較対象あり）：音符一致率、出だしのばらつき（ms）、弾き忘れ／余分な音、テンポ差（%）', '絶対（メトロノーム録音）：拍の格子に対するばらつき（ms）、テンポの流れ（%）、格子との一致度', '比較モード：直前のテイク／ばらつき最小のテイク／お手本（任意）'], { x: 0.75, y: 3.5, w: 8.5, h: 1.35, fontSize: 11.5 });
    s.addNotes('0〜100 の合成スコアは廃止し、単位のある量に分解した（後述）。'); }

  // 6 Approach: identify -> measure -> decide
  { const s = base();
    header(s, '進め方：リスクを特定 → 実測 → 判断', '最初に最大リスクを1つ決め、実測の結果で設計を変えてきた。3ヶ月の中身はこの3段');
    const cols = [
      ['FiTarget', '特定', '8月前半', C.walnut, ['PRD・Design Doc で、最大リスクを「自己比較の精度」と定めた', '機能を積む前に、この1点を最初に検証すると決めた']],
      ['FiActivity', '実測', '8月後半〜9月', C.blue, ['合成音と実録音で Basic Pitch を検証。閾値調整の必要性、22050Hz 必須、倍音・分割による過剰検出を発見', '動く MVP と合成音19テイクのデモ基盤を作り、指標のふるまいを数値で確認']],
      ['FiGitBranch', '判断', '9月', C.amber, ['守備範囲を単音・分散和音・音間隔 300ms 以上に限定', '0〜100 の合成スコアを廃止し、ms 単位の指標に分解', '自己比較の構造的限界を認め、楽譜照合への転換を検討']],
    ];
    cols.forEach(([i, t, period, col, items], k) => {
      const x = 0.5 + k * 3.05, y = 1.5, w = 2.9;
      card(s, x, y, w, 3.0, k === 2 ? C.paleAmber : C.light);
      iconCircle(s, x + 0.2, y + 0.2, 0.55, ic[i], col);
      text(s, t, { x: x + 0.9, y: y + 0.18, w: 1.9, h: 0.35, fontSize: 17, bold: true, color: C.walnut });
      text(s, period, { x: x + 0.9, y: y + 0.52, w: 1.9, h: 0.25, fontSize: 10.5, color: C.gray });
      bullets(s, items, { x: x + 0.2, y: y + 0.95, w: w - 0.4, h: 1.95, fontSize: 11 });
      if (k < 2) arrow(s, x + w, y + 0.47, x + w + 0.15, y + 0.47, C.gray);
    });
    text(s, '以下の4枚は、「実測」で分かったことと、それに基づく「判断」。', { x: 0.5, y: 4.65, w: 9, h: 0.35, fontSize: 12.5, bold: true, color: C.walnut });
    s.addNotes('日付の詳細（聞かれたら）：8/14 PRD・Design Doc、8/15 Python 予備検証、8/26 ブラウザ本検証（実録音・実機）、9/1 MVP・デモ基盤・ローカル git 化、9/9 安定度指標の作り直し、9/13 精度改善（倍音除外）。コミット 11 件。'); }

  // 7 Finding 1
  { const s = base();
    header(s, '実測①：系統的な間違いを音符単位で検出できる', 'PRD の Risks に書いた「構造的限界」を合成音で再現し、お手本比較で検出できることを確認');
    // left: table of detections
    text(s, '仕込み：B♭ コードの3度 D4 を、毎回 C♯4 に半音低く押さえる', { x: 0.5, y: 1.45, w: 5.4, h: 0.3, fontSize: 12, bold: true, color: C.walnut });
    const rows = [
      [{ text: 'テイク', options: hdr() }, { text: 'C♯4 の検出数', options: hdr() }, { text: 'D4 の検出数', options: hdr() }],
      [{ text: '通常テイク 1〜5', options: cell() }, { text: '5〜6', options: cell({ bold: true, color: C.red }) }, { text: '0', options: cell({ bold: true }) }],
      [{ text: 'お手本テイク', options: cell() }, { text: '0', options: cell({ bold: true }) }, { text: '6', options: cell({ bold: true, color: C.green }) }],
    ];
    s.addTable(rows, { x: 0.5, y: 1.85, w: 5.4, colW: [2.0, 1.7, 1.7], rowH: [0.45, 0.5, 0.5], border: { type: 'solid', color: C.white, pt: 2 }, fill: { color: C.light } });
    text(s, '→ Basic Pitch は仕込んだ系統誤差を完全に分離して検出した', { x: 0.5, y: 3.4, w: 5.4, h: 0.3, fontSize: 12, color: C.ink });
    // right: self vs reference
    card(s, 6.2, 1.45, 3.3, 1.3, C.light);
    text(s, '自己比較（直前のテイクと）', { x: 6.4, y: 1.55, w: 3.0, h: 0.3, fontSize: 11.5, bold: true, color: C.gray });
    text(s, '100%', { x: 6.4, y: 1.85, w: 1.6, h: 0.6, fontSize: 30, bold: true, color: C.gray });
    text(s, '音符一致率\n「前回と一音も違わない」', { x: 8.0, y: 1.95, w: 1.4, h: 0.6, fontSize: 9.5, color: C.gray });
    card(s, 6.2, 2.9, 3.3, 1.3, C.paleAmber);
    text(s, 'お手本比較', { x: 6.4, y: 3.0, w: 3.0, h: 0.3, fontSize: 11.5, bold: true, color: C.walnut });
    text(s, '80%', { x: 6.4, y: 3.3, w: 1.6, h: 0.6, fontSize: 30, bold: true, color: C.red });
    text(s, '音符一致率\n赤の「音高違い」が3か所に', { x: 8.0, y: 3.4, w: 1.4, h: 0.6, fontSize: 9.5, color: C.walnut });
    text(s, '3週間ずっと同じ間違いを、安定して弾いていた。自己比較はこれを「安定している」としか言えない。限界を認識し、お手本比較・自己確認ステップ・UI 文言の3段で緩和策を実装済み。', { x: 0.5, y: 4.4, w: 9, h: 0.7, fontSize: 12.5, bold: true, color: C.walnut });
    s.addNotes('デモの山場。3か所なのにピアノロールに6本出るのは「音の分割」（実測③）。'); }

  // 8 Finding 2: scope
  { const s = base();
    header(s, '実測②：現状のエンジンで扱える範囲', '合成音とデモデータ19テイクで計測。守備範囲が実測で決まった');
    const rows = [
      [{ text: '素材', options: hdr() }, { text: '音の間隔', options: hdr() }, { text: '検出', options: hdr() }, { text: '判定', options: hdr() }],
      [{ text: '単音フレーズ', options: cell() }, { text: '約 310ms', options: cell() }, { text: '安定（意図 24 音に対し 26〜28）', options: cell() }, { text: '◯ 対応', options: cell({ bold: true, color: C.green }) }],
      [{ text: 'アルペジオ（分散和音）', options: cell() }, { text: '約 310ms', options: cell() }, { text: '安定（32〜33 音、テイク間で一定）', options: cell() }, { text: '◯ 対応', options: cell({ bold: true, color: C.green }) }],
      [{ text: '単音フレーズ（16分）', options: cell() }, { text: '約 178ms', options: cell() }, { text: '取りこぼしが増える', options: cell() }, { text: '△ 目安 300ms 以上', options: cell({ bold: true, color: C.amber }) }],
      [{ text: 'ストローク（6音同時）', options: cell() }, { text: '同時', options: cell() }, { text: 'テイクごとに検出がばらつく', options: cell() }, { text: '✕ 対象外', options: cell({ bold: true, color: C.red }) }],
    ];
    s.addTable(rows, { x: 0.5, y: 1.5, w: 9, colW: [2.2, 1.4, 3.4, 2.0], rowH: [0.45, 0.55, 0.55, 0.55, 0.55], border: { type: 'solid', color: C.white, pt: 2 }, fill: { color: C.light } });
    text(s, 'ストローク和音は Basic Pitch が安定して分解できない。和音をスコープから外し、単音・分散和音・音間隔 300ms 以上を v1 の守備範囲と定めた。', { x: 0.5, y: 4.45, w: 9, h: 0.6, fontSize: 12.5, bold: true, color: C.walnut });
    s.addNotes('音域は MIDI 40（E2）〜88（E6）。変則チューニング・カポは未対応。'); }

  // 9 Finding 3: over-detection
  { const s = base();
    header(s, '実測③：過剰検出の正体は「音の分割」', 'デモデータ19テイク・検出440音を分類。初期の実録音検証で見た倍音問題とは別の現象');
    stat(s, 0.5, 1.5, 2.9, '25%', '1つの音が2つに割れた', '直前1.2秒以内に同じ音高が再検出。108音', C.amber);
    stat(s, 3.55, 1.5, 2.9, '0.2%', '倍音関係で説明できるもの', '+12/+19/+24/+28 半音。440音中わずか1音', C.gray);
    stat(s, 6.6, 1.5, 2.9, '75%', '意図した音', '331音', C.green);
    card(s, 0.5, 3.25, 9.0, 1.75, C.light);
    text(s, '切り分けで分かったこと', { x: 0.75, y: 3.37, w: 5, h: 0.3, fontSize: 12.5, bold: true, color: C.walnut });
    bullets(s, ['分割の再検出は「次の音が鳴った時刻ちょうど」に立つ。前の音が響く中で次を撥弦すると、鳴り続けている音にも新しいオンセットが立つ', '合成方式を変えても消えず、音の重なりを無くすと 0 になる。原因は「重なり」そのもので、実際のギターでも同じ条件が揃う', '対策として「同音高 150ms 以内の再オンセットを畳む」分割統合を診断の入力側に入れた。窓幅は実録音で未検証'], { x: 0.75, y: 3.72, w: 8.5, h: 1.25, fontSize: 11 });
    s.addNotes('8 月下旬の実録音検証で見た「3〜4割の倍音誤検出」は別現象。当時は倍音しか分類していないので、分割が混ざっていた可能性があり、再分類が残課題。'); }

  // 10 Finding 4: score redesign
  { const s = base();
    header(s, '実測④：安定度スコアを作り直した', '「定量的に測れている感じがしない」という実機テストの指摘を、合成音で検証して確認');
    card(s, 0.5, 1.5, 4.3, 3.0, C.light);
    s.addImage({ data: icRed, x: 0.75, y: 1.65, w: 0.35, h: 0.35 });
    text(s, '旧：0〜100 の合成スコア', { x: 1.2, y: 1.65, w: 3.4, h: 0.35, fontSize: 14, bold: true, color: C.gray, valign: 'middle' });
    bullets(s, ['演奏が一切変わらない12テイクで 62〜78 の間で振れた（振幅16点）。原因は分割のゆらぎだけ', '全体を 150ms 一律シフト、テンポ +5% で最大減点。不安定さと無関係な量で下がる', '本来測りたいばらつき（σ=10ms→98、σ=80ms→87）にはほとんど反応しない'], { x: 0.75, y: 2.15, w: 3.8, h: 2.3, fontSize: 11.5 });
    card(s, 5.2, 1.5, 4.3, 3.0, C.paleAmber);
    s.addImage({ data: icGreen, x: 5.45, y: 1.65, w: 0.35, h: 0.35 });
    text(s, '新：単位のある指標に分解', { x: 5.9, y: 1.65, w: 3.4, h: 0.35, fontSize: 14, bold: true, color: C.walnut, valign: 'middle' });
    bullets(s, ['出だしのばらつき（ms）：オフセットとテンポ差を直線フィットで除いた残差の SD。σ=10/20/40/80ms を 9.5/20.5/37/78ms と推定', 'テンポ差（%）と出だしの差（ms）は別の量として出す', 'メトロノーム録音では、拍の格子に対する絶対指標。比較対象なしに単体で測れ、日をまたいでも同じ物差し'], { x: 5.45, y: 2.15, w: 3.8, h: 2.3, fontSize: 11.5 });
    text(s, '式で吸収しても信号対雑音比は変わらない。分割統合を入力側に入れ、合成値をやめて分解した。保存済みの診断は再計算した。', { x: 0.5, y: 4.65, w: 9, h: 0.5, fontSize: 12, bold: true, color: C.walnut });
    s.addNotes('デモ手順書と Design Doc の一部の数値は旧スコアのまま。発表ではばらつき（ms）で語る。'); }

  // 11 Performance
  { const s = base();
    header(s, '性能（実測）', 'ブラウザ完結で実用的な速度に収まった。初回コストはウォームアップで隠す');
    stat(s, 0.5, 1.5, 2.9, '1.4 MB', 'JS バンドル（gzip 371KB）', '大半が TensorFlow.js。モデル本体は数百 KB');
    stat(s, 3.55, 1.5, 2.9, '数百 ms', '8秒の音声1件の解析', 'ウォームアップ後。閾値変更は再推論なし');
    stat(s, 6.6, 1.5, 2.9, '約 18 秒', '初回コスト', 'ライブラリ 7.5 + モデル 1.9 + 初回推論 8.2 秒');
    card(s, 0.5, 3.25, 9.0, 1.75, C.light);
    bullets(s, ['初回推論の約 8 秒は、起動直後のアイドル時間に微小信号で「捨て推論」を1回走らせて隠した。ユーザーには見えない', 'デモデータ19テイクの投入は 58〜66 秒（アイドル時）。CPU が他の処理で埋まっていると数分かかる', 'Basic Pitch（TensorFlow.js 版）は 22050Hz モノラル入力が必須。README の記述と異なり内部でリサンプルしないため、OfflineAudioContext で変換して解決', 'スマホ実機での速度・メモリは未計測'], { x: 0.75, y: 3.4, w: 8.5, h: 1.55, fontSize: 11.5 });
    s.addNotes(''); }

  // 12 Can / cannot say
  { const s = base();
    header(s, '3ヶ月で言えること・言えないこと', '発表で聞かれたら正直に答える前提で整理');
    card(s, 0.5, 1.5, 4.4, 3.3, C.light);
    s.addImage({ data: icGreen, x: 0.75, y: 1.65, w: 0.4, h: 0.4 });
    text(s, '言えること', { x: 1.25, y: 1.65, w: 3, h: 0.4, fontSize: 16, bold: true, color: C.green, valign: 'middle' });
    bullets(s, ['ブラウザ内で録音 → 音符起こし → 自己比較診断まで動く（サーバーなし）', '時間をまたいだ指標の推移が可視化できる', '自己比較の構造的限界を再現でき、お手本比較で検出できる', '単音・分散和音なら、系統的な押さえ間違いを音符単位で特定できる'], { x: 0.75, y: 2.2, w: 3.9, h: 2.5, fontSize: 12 });
    card(s, 5.1, 1.5, 4.4, 3.3, C.light);
    s.addImage({ data: icRed, x: 5.35, y: 1.65, w: 0.4, h: 0.4 });
    text(s, '言えないこと', { x: 5.85, y: 1.65, w: 3, h: 0.4, fontSize: 16, bold: true, color: C.red, valign: 'middle' });
    bullets(s, ['ストローク和音は扱えない', '実録音での精度は数値化できていない。「期待する音符列」を入れた本測定が未実施', '合成音は本物より素直で、実録音ではもっと悪くなる', 'スマホ実機の速度・メモリは未計測', '被験者は事実上開発者1人。UX の妥当性は未検証'], { x: 5.35, y: 2.2, w: 3.9, h: 2.5, fontSize: 12 });
    s.addNotes(''); }

  // 13 Remaining & next
  { const s = base();
    header(s, '残る課題と、次の判断', '残り3ヶ月の使い方は、構造的限界にどう向き合うかで決まる');
    const rows = [
      ['FiFlag', '未実装', 'スレッドの削除・並び替え、アクティブスレッド数の上限、お手本の音符編集 UI、分割統合の窓幅（150ms）の実録音での検証'],
      ['FiSearch', '未検証', '実録音での音符起こし精度の本測定。初期検証の実録音データを「分割」基準で再分類。スマホ実機'],
      ['FiAlertTriangle', '構造的限界（解消不能）', '自己比較は一貫性しか測れず、正誤を判定できない。外部の正解データなしには理論的に区別できない'],
      ['FiGitBranch', '検討中の次の一手', '「楽譜ファイルを正解にして照合する」アプローチへの転換。正誤が判定でき、和音も検証可能な問いになる。PRD・設計を別途作成済み'],
    ];
    rows.forEach(([i, t, d], k) => {
      const y = 1.45 + k * 0.9;
      iconCircle(s, 0.5, y + 0.05, 0.55, ic[i], k === 2 ? C.red : k === 3 ? C.amber : C.walnut);
      text(s, t, { x: 1.25, y, w: 8.2, h: 0.3, fontSize: 14, bold: true, color: C.walnut });
      text(s, d, { x: 1.25, y: y + 0.32, w: 8.2, h: 0.55, fontSize: 11.5, color: C.ink });
    });
    s.addNotes('転換案の詳細は別資料（guitar_score_diagnosis_slides.pptx）。'); }

  // 14 Summary
  { const s = base(true);
    staffLines(s, 5.6, 0.3, 4.4, '6B5545', 0.22);
    text(s, 'まとめ', { x: 0.6, y: 0.5, w: 4, h: 0.6, fontSize: 28, bold: true, color: C.white });
    bullets(s, ['3ヶ月で、ブラウザ完結の自己比較診断アプリを動くところまで作った', '最大リスク「自己比較の精度」を最初に実測し、結果で設計を変えた。守備範囲（単音・分散和音・300ms 以上）とスコアの作り直しはその成果', '「一貫しているが間違っている」演奏を自己比較は見抜けない。この限界を再現・実装で緩和し、根本解消には正解データが要ると分かった'], { x: 0.6, y: 1.3, w: 8.8, h: 2.0, fontSize: 14, color: C.white });
    card(s, 0.6, 3.45, 8.8, 1.55, '4E3A2E');
    text(s, '持ち越せる資産', { x: 0.85, y: 3.58, w: 5, h: 0.35, fontSize: 14, bold: true, color: C.amber });
    text(s, '録音・前処理・メトロノーム格子・分割統合・アライメント・履歴 UI・合成音デモ基盤・PWA シェル。次のアプローチに切り替えても、そのまま使える。', { x: 0.85, y: 3.95, w: 8.3, h: 0.9, fontSize: 13, color: C.white });
    s.addNotes(''); }

  await pres.writeFile({ fileName: OUT });
  console.log('written', OUT);
})().catch(e => { console.error(e); process.exit(1); });
