const pptxgen = require('pptxgenjs');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const Fi = require('react-icons/fi');
const sharp = require('sharp');

const OUT = require('path').join(__dirname, 'guitar_score_diagnosis_slides.pptx');
const JP = 'Hiragino Sans';
const C = {
  walnut: '3A2A21', amber: 'D9822B', ink: '2B2B2B', gray: '6E6E6E', light: 'F2F2F2',
  white: 'FFFFFF', green: '3F7D58', red: 'C0392B', paleAmber: 'F7E6D3', line: 'CFCFCF',
  staff: '8C7B70', dim: 'B9AEA6'
};

async function icon(name, color) {
  let svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Fi[name], { size: 256 }));
  svg = svg.replace(/currentColor/g, '#' + color);
  const buf = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
  return 'image/png;base64,' + buf.toString('base64');
}

const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9'; // 10 x 5.625
pres.author = 'yk';
pres.title = 'ギター楽譜照合診断アプリ';

let pageNo = 0;
function base(dark = false) {
  const s = pres.addSlide();
  pageNo++;
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
  const pad = d * 0.25;
  s.addImage({ data: img, x: x + pad, y: y + pad, w: d - 2 * pad, h: d - 2 * pad });
}
function card(s, x, y, w, h, fill = C.light) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: fill, width: 0 }, rectRadius: 0.08 });
}
function text(s, t, o) {
  s.addText(t, Object.assign({ fontFace: JP, isTextBox: true, margin: 0, color: C.ink, fontSize: 13, valign: 'top' }, o));
}
function bullets(s, items, o) {
  const arr = items.map((t, i) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: i < items.length - 1, paraSpaceAfter: 5 } }));
  s.addText(arr, Object.assign({ fontFace: JP, isTextBox: true, margin: 0, color: C.ink, fontSize: 12.5, valign: 'top' }, o));
}
function arrow(s, x1, y1, x2, y2, color = C.gray) {
  s.addShape(pres.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color, width: 1.5, endArrowType: 'triangle' } });
}
function staffLines(s, x, y, w, color, gap = 0.11) {
  for (let i = 0; i < 5; i++) s.addShape(pres.ShapeType.line, { x, y: y + i * gap, w, h: 0, line: { color, width: 0.75 } });
}

(async () => {
  const ic = {};
  for (const n of ['FiMic', 'FiCpu', 'FiClock', 'FiTarget', 'FiTrendingUp', 'FiUser', 'FiCheckCircle', 'FiXCircle', 'FiFileText', 'FiAlertTriangle', 'FiMusic', 'FiLayers', 'FiEdit3', 'FiRepeat', 'FiActivity', 'FiMonitor']) {
    ic[n] = await icon(n, C.white);
  }
  const icGreen = await icon('FiCheckCircle', C.green);
  const icRed = await icon('FiXCircle', C.red);

  // ---------- 1. Title ----------
  {
    const s = base(true);
    staffLines(s, 5.6, 1.5, 4.4, '6B5545', 0.22);
    // notes on the staff
    [[6.0, 1.61], [6.7, 1.83], [7.4, 1.72], [8.1, 1.94], [8.9, 1.61]].forEach(([x, y]) => {
      s.addShape(pres.ShapeType.ellipse, { x, y: y - 0.09, w: 0.26, h: 0.18, fill: { color: C.amber }, line: { color: C.amber, width: 0 } });
      s.addShape(pres.ShapeType.line, { x: x + 0.25, y: y - 0.7, w: 0, h: 0.7, line: { color: C.amber, width: 1.5 } });
    });
    text(s, 'Alpha+ プロジェクト ｜ 中間報告後の方針転換案', { x: 0.6, y: 1.1, w: 6, h: 0.35, fontSize: 12, color: C.dim });
    text(s, 'ギター楽譜照合\n診断アプリ', { x: 0.6, y: 1.55, w: 6, h: 1.7, fontSize: 40, bold: true, color: C.white, lineSpacingMultiple: 1.05 });
    text(s, '自己比較から、楽譜を正解にした照合へ', { x: 0.6, y: 3.45, w: 7, h: 0.5, fontSize: 18, color: C.amber });
    text(s, '2026年9月18日', { x: 0.6, y: 4.6, w: 4, h: 0.3, fontSize: 12, color: C.dim });
    s.addNotes('前身の自己比較アプリで得た成果と限界を踏まえ、楽譜ファイルを正解にした照合へ方針を切り替える提案。残り3ヶ月の計画まで話す。');
  }

  // ---------- 2. What we built ----------
  {
    const s = base();
    header(s, '前身で作ったもの（2026年8月〜9月）', '「ギター上達診断アプリ」— 引っかかるフレーズを録音し、過去の自分と比較する PWA');
    const rows = [
      ['FiMic', 'スレッド単位で録音し、過去テイクと自己比較', '「引っかかるフレーズ」を1スレッドにして、テイクを積み重ねる'],
      ['FiCpu', 'ブラウザ内で音符起こし、サーバーなし', 'Basic Pitch（TensorFlow.js）を完全クライアントサイドで実行'],
      ['FiClock', 'メトロノーム格子で ms 単位のタイミング指標', '0〜100 の合成スコアを廃止し、単位のある指標に分解（9/9）'],
    ];
    rows.forEach(([i, t, d], k) => {
      const y = 1.5 + k * 1.15;
      iconCircle(s, 0.5, y, 0.6, ic[i]);
      text(s, t, { x: 1.3, y: y - 0.02, w: 4.6, h: 0.35, fontSize: 15, bold: true, color: C.walnut });
      text(s, d, { x: 1.3, y: y + 0.36, w: 4.6, h: 0.6, fontSize: 12, color: C.gray });
    });
    // core loop on the right
    card(s, 6.3, 1.45, 3.2, 3.5, C.paleAmber);
    text(s, '前身のコアループ', { x: 6.5, y: 1.6, w: 2.8, h: 0.3, fontSize: 12, bold: true, color: C.walnut });
    const steps = ['スレッドを作る', '弾いて録音する', '直前のテイクと比較', 'ズレとばらつきを見る', '安定したら「解決済み」'];
    steps.forEach((t, k) => {
      const y = 2.0 + k * 0.56;
      s.addShape(pres.ShapeType.ellipse, { x: 6.5, y: y + 0.03, w: 0.3, h: 0.3, fill: { color: C.amber }, line: { color: C.amber, width: 0 } });
      text(s, String(k + 1), { x: 6.5, y: y + 0.03, w: 0.3, h: 0.3, fontSize: 11, bold: true, color: C.white, align: 'center', valign: 'middle' });
      text(s, t, { x: 6.9, y: y + 0.02, w: 2.5, h: 0.35, fontSize: 12.5, valign: 'middle' });
      if (k < steps.length - 1) s.addShape(pres.ShapeType.line, { x: 6.65, y: y + 0.33, w: 0, h: 0.23, line: { color: C.amber, width: 1 } });
    });
    s.addNotes('8月14日に PRD、9月1日に動く MVP。9月9日に安定度スコアを ms 単位の指標に作り直した。');
  }

  // ---------- 3. Limits ----------
  {
    const s = base();
    header(s, '前身の実測で分かった限界', '合成音19テイク・実機テストで判明。いずれも作り込みでは解消できない');
    const cards = [
      ['正誤 ×', '正しさが判定できない', '自己比較は「一貫性」しか測れない。毎回同じ間違いをしても「安定」と診断される。構造的な限界'],
      ['0 点', 'ストローク和音が扱えない', '6音同時の撥弦を Basic Pitch が分解できず、テイクごとに検出がばらついて安定度が 0 に張り付いた'],
      ['25 %', '音の分割による過剰検出', '前の音が響く中で次を弾くと、鳴り続けている音にも新しいオンセットが立つ。検出440音のうち108音'],
    ];
    cards.forEach(([stat, t, d], k) => {
      const x = 0.5 + k * 3.05;
      card(s, x, 1.5, 2.9, 3.0);
      text(s, stat, { x: x + 0.25, y: 1.65, w: 2.4, h: 0.8, fontSize: 40, bold: true, color: C.amber });
      text(s, t, { x: x + 0.25, y: 2.55, w: 2.4, h: 0.4, fontSize: 14, bold: true, color: C.walnut });
      text(s, d, { x: x + 0.25, y: 3.0, w: 2.4, h: 1.4, fontSize: 11.5, color: C.ink });
    });
    text(s, '回避策の「お手本テイク」は、お手本を用意する手間が本体の価値を上回った。', { x: 0.5, y: 4.75, w: 9, h: 0.4, fontSize: 13, italic: true, color: C.gray });
    s.addNotes('最大の問題は1つ目。正解データを持たない限り、理論的に区別できない。2つ目・3つ目は音符起こしの精度問題で、正解があれば影響を抑えられる。');
  }

  // ---------- 4. Pivot ----------
  {
    const s = base();
    header(s, '転換：「正解」を持つ', '基準を「過去の自分」から「楽譜ファイル」に置き換える');
    card(s, 0.5, 1.5, 3.9, 2.9, C.light);
    text(s, '前身：自己比較', { x: 0.75, y: 1.65, w: 3.4, h: 0.4, fontSize: 16, bold: true, color: C.gray });
    bullets(s, ['基準＝過去の自分の録音', '問い＝「前回と同じように弾けたか」', '音符起こしの精度に全面依存', '和音は原理的に対象外'], { x: 0.75, y: 2.15, w: 3.4, h: 2.1, fontSize: 13 });
    arrow(s, 4.55, 2.95, 5.35, 2.95, C.amber);
    card(s, 5.5, 1.5, 4.0, 2.9, C.paleAmber);
    text(s, '本提案：楽譜照合', { x: 5.75, y: 1.65, w: 3.5, h: 0.4, fontSize: 16, bold: true, color: C.walnut });
    bullets(s, ['基準＝楽譜ファイル（MusicXML / Guitar Pro）', '問い＝「期待した音が、その時刻に鳴ったか」', '音符起こしを介さない照合方式も選べる', '和音は「構成音が全部鳴ったか」という検証可能な問いになる'], { x: 5.75, y: 2.15, w: 3.5, h: 2.1, fontSize: 13 });
    text(s, '「何の音か当てる」問題が「鳴ったかを確かめる」問題に変わる。前身の限界①は根本から消え、②③は影響を抑えられる。', { x: 0.5, y: 4.6, w: 9, h: 0.6, fontSize: 13, bold: true, color: C.walnut });
    s.addNotes('正解の音符列とその時刻が録音前に分かっているので、各音の周りに時間窓を置いて「鳴ったか」を見ればよい。前身の録音同士のアライメントは不要になる。');
  }

  // ---------- 5. Product overview ----------
  {
    const s = base();
    header(s, 'プロダクト概要', '手元の楽譜ファイルを正解にして、演奏を音符単位で照合する練習アプリ');
    const goals = [
      ['FiTarget', 'Goal 1（核）', 'どの小節のどの音が「間違い・欠落・遅れ」かを、演奏直後に音符単位で確認できる'],
      ['FiTrendingUp', 'Goal 2', '小節範囲とテンポを決めた「練習区間」ごとに履歴を残し、テンポを上げながら弾けるようになる過程が見える'],
    ];
    goals.forEach(([i, t, d], k) => {
      const y = 1.5 + k * 1.45;
      card(s, 0.5, y, 5.6, 1.25);
      iconCircle(s, 0.7, y + 0.3, 0.65, ic[i]);
      text(s, t, { x: 1.55, y: y + 0.15, w: 4.4, h: 0.35, fontSize: 14, bold: true, color: C.walnut });
      text(s, d, { x: 1.55, y: y + 0.5, w: 4.4, h: 0.7, fontSize: 12, color: C.ink });
    });
    card(s, 6.4, 1.5, 3.1, 2.7, C.paleAmber);
    iconCircle(s, 6.6, 1.7, 0.6, ic.FiUser, C.walnut);
    text(s, '想定ユーザー', { x: 7.35, y: 1.8, w: 2.0, h: 0.4, fontSize: 13, bold: true, color: C.walnut, valign: 'middle' });
    bullets(s, ['30代社会人、独学3年', '市販の楽譜集（五線譜）で練習', '弾けているつもりの箇所が本当に楽譜通りか分からない', '練習は PC の前。数小節を打ち込む手間は許容できる'], { x: 6.6, y: 2.45, w: 2.75, h: 1.7, fontSize: 11.5 });
    text(s, '前身と同じく完全クライアントサイド。楽譜も音声も端末から出さない。', { x: 0.5, y: 4.6, w: 9, h: 0.4, fontSize: 12, color: C.gray });
    s.addNotes('Goals は 2 つに絞った。v1 は照合の価値を確かめることに集中する。');
  }

  // ---------- 6. Competitors ----------
  {
    const s = base();
    header(s, '既存アプリとの違い', '「楽譜を持ち込む」と「演奏を判定する」の両方を持つものがない');
    const hdr = { bold: true, color: C.white, fill: { color: C.walnut }, fontFace: JP, fontSize: 12, align: 'center', valign: 'middle' };
    const cell = { color: C.ink, fontFace: JP, fontSize: 11.5, valign: 'middle' };
    const hi = Object.assign({}, cell, { fill: { color: C.paleAmber }, bold: true, color: C.walnut });
    const rows = [
      [{ text: '', options: hdr }, { text: 'Yousician / Rocksmith 系', options: hdr }, { text: 'Soundslice / Guitar Pro 系', options: hdr }, { text: '本アプリ', options: Object.assign({}, hdr, { fill: { color: C.amber } }) }],
      [{ text: '楽譜の出所', options: Object.assign({}, cell, { bold: true }) }, { text: 'アプリ内ライブラリ', options: cell }, { text: 'ユーザーの楽譜を表示・再生', options: cell }, { text: 'ユーザーの楽譜ファイル', options: hi }],
      [{ text: '演奏の判定', options: Object.assign({}, cell, { bold: true }) }, { text: 'あり（ライブラリ曲のみ）', options: cell }, { text: 'なし（再生・練習補助のみ）', options: cell }, { text: 'あり（取り込んだ楽譜なら何でも）', options: hi }],
      [{ text: 'フィードバック', options: Object.assign({}, cell, { bold: true }) }, { text: 'ゲーム的な正解率', options: cell }, { text: '—', options: cell }, { text: '小節×音符単位の正誤とズレ、履歴', options: hi }],
    ];
    s.addTable(rows, { x: 0.5, y: 1.5, w: 9, colW: [1.5, 2.4, 2.5, 2.6], rowH: [0.5, 0.65, 0.65, 0.65], border: { type: 'solid', color: C.white, pt: 2 }, fill: { color: C.light } });
    text(s, '本アプリはこの2つの接続部を作る。楽譜ライブラリを持たず、判定だけに集中する。', { x: 0.5, y: 4.4, w: 9, h: 0.4, fontSize: 13, color: C.walnut, bold: true });
    s.addNotes('Soundslice は紙のスキャンも同期再生も持つが判定はしない。Yousician は判定するがライブラリ内の曲だけ。');
  }

  // ---------- 7. Core loop ----------
  {
    const s = base();
    header(s, 'コアループ（Key Scenarios）', '楽譜ファイルを取り込んでから、テンポを上げてクリアするまで');
    const steps = [
      ['FiFileText', '楽譜を取り込む', 'MusicXML / Guitar Pro。紙の曲は練習区間だけ MuseScore で打ち込む'],
      ['FiLayers', '練習区間を作る', '楽譜上で小節範囲を選び、テンポ（BPM）を決める'],
      ['FiMic', 'クリック付きで録音', 'カウントイン → クリックに合わせて弾く。時間軸が楽譜と結びつく'],
      ['FiActivity', '音符単位の結果', '楽譜上に正誤（一致・音高違い・欠落・余分）とズレ（ms）を重ねる'],
      ['FiRepeat', 'テンポを上げる', 'テンポ別・日付別の履歴。安定したら区間を「クリア」に'],
    ];
    steps.forEach(([i, t, d], k) => {
      const x = 0.5 + k * 1.84;
      iconCircle(s, x + 0.47, 1.55, 0.7, ic[i]);
      if (k < steps.length - 1) arrow(s, x + 1.3, 1.9, x + 1.84 + 0.35, 1.9, C.line);
      text(s, String(k + 1), { x, y: 2.4, w: 1.65, h: 0.3, fontSize: 11, bold: true, color: C.amber, align: 'center' });
      text(s, t, { x, y: 2.7, w: 1.65, h: 0.6, fontSize: 13, bold: true, color: C.walnut, align: 'center' });
      text(s, d, { x, y: 3.35, w: 1.65, h: 1.4, fontSize: 10.5, color: C.gray, align: 'center' });
    });
    s.addNotes('曲全体を入れる必要はない。引っかかる数小節だけ打ち込めば使える。');
  }

  // ---------- 8. Scope ----------
  {
    const s = base();
    header(s, 'v1 の割り切り', '残り約3ヶ月で「照合の価値」を確かめることに集中する');
    card(s, 0.5, 1.5, 4.4, 2.9, C.light);
    s.addImage({ data: icGreen, x: 0.75, y: 1.65, w: 0.4, h: 0.4 });
    text(s, 'やる', { x: 1.25, y: 1.65, w: 3, h: 0.4, fontSize: 16, bold: true, color: C.green, valign: 'middle' });
    bullets(s, ['MusicXML / Guitar Pro の取り込みと楽譜表示', '音高とタイミングの判定（音符単位）', '単音・分散和音は確実に。ストロークは検証次第', '練習区間ごとの履歴とクリア', 'PC ブラウザの PWA、完全クライアントサイド'], { x: 0.75, y: 2.2, w: 3.9, h: 2.1, fontSize: 12.5 });
    card(s, 5.1, 1.5, 4.4, 2.9, C.light);
    s.addImage({ data: icRed, x: 5.35, y: 1.65, w: 0.4, h: 0.4 });
    text(s, 'やらない', { x: 5.85, y: 1.65, w: 3, h: 0.4, fontSize: 16, bold: true, color: C.red, valign: 'middle' });
    bullets(s, ['PDF・紙の楽譜の認識（OMR）→ 余裕があれば試す', '弦・フレットの判定、テクニック（ベンド等）の判定', 'リアルタイム（演奏中）のフィードバック', 'バックエンド、アカウント、外部 API', '曲ライブラリ、ソーシャル、通知'], { x: 5.35, y: 2.2, w: 3.9, h: 2.1, fontSize: 12.5 });
    text(s, 'OMR を外した理由：ブラウザで動く実用的なライブラリがなく、認識ミスの修正 UI まで含めると本体に匹敵する規模になる。紙の曲は数小節を打ち込む方が早い。', { x: 0.5, y: 4.55, w: 9, h: 0.6, fontSize: 11.5, color: C.gray });
    s.addNotes('PDF・紙が自分の主な楽譜なのは事実だが、練習区間は短いので打ち込みで賄う。OMR は照合の価値が確認できてから入口を広げる判断にする。');
  }

  // ---------- 9. Architecture ----------
  {
    const s = base();
    header(s, 'アーキテクチャ', '楽譜側は alphaTab に任せ、照合エンジンだけ差し替え可能に作る');
    const box = (x, y, w, h, t, sub, fill, tc = C.ink) => {
      s.addShape(pres.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: fill, width: 0 }, rectRadius: 0.06 });
      text(s, t, { x: x + 0.1, y: y + 0.08, w: w - 0.2, h: 0.3, fontSize: 12, bold: true, color: tc, align: 'center' });
      if (sub) text(s, sub, { x: x + 0.1, y: y + 0.4, w: w - 0.2, h: h - 0.45, fontSize: 9.5, color: tc === C.white ? C.dim : C.gray, align: 'center' });
    };
    // row 1: score path
    text(s, '楽譜側', { x: 0.5, y: 1.4, w: 1, h: 0.3, fontSize: 11, bold: true, color: C.amber });
    box(0.5, 1.7, 1.9, 0.95, '楽譜ファイル', 'MusicXML / Guitar Pro', C.paleAmber);
    arrow(s, 2.45, 2.17, 2.85, 2.17);
    box(2.9, 1.7, 2.4, 0.95, 'alphaTab', '表示・MIDI 生成・座標参照', C.paleAmber);
    arrow(s, 5.35, 2.17, 5.75, 2.17);
    box(5.8, 1.7, 3.7, 0.95, '期待音符列', 'リピート展開 → 区間 BPM で秒 / オクターブ補正 / 同時音スロット', C.paleAmber);
    // row 2: audio path
    text(s, '演奏側', { x: 0.5, y: 2.85, w: 1, h: 0.3, fontSize: 11, bold: true, color: C.gray });
    box(0.5, 3.15, 1.9, 0.95, 'クリック付き録音', 'メトロノーム・カウントイン（前身流用）', C.light);
    arrow(s, 2.45, 3.62, 2.85, 3.62);
    box(2.9, 3.15, 1.5, 0.95, '前処理', '22050Hz・トリム・正規化', C.light);
    arrow(s, 4.45, 3.62, 4.85, 3.62);
    box(4.9, 3.15, 1.9, 0.95, '照合エンジン A/B/C', '同じインターフェース', C.walnut, C.white);
    arrow(s, 6.85, 3.62, 7.25, 3.62);
    box(7.3, 3.15, 2.2, 0.95, 'Scorer', '許容ルール → 正誤・ms・集計', C.light);
    // expected -> engine
    s.addShape(pres.ShapeType.line, { x: 5.85, y: 2.65, w: 0.01, h: 0.5, line: { color: C.amber, width: 2, endArrowType: 'triangle' } });
    // bottom: output + storage
    box(0.5, 4.35, 4.3, 0.8, '楽譜上に可視化・同期再生・履歴', 'alphaTab の座標参照の上に SVG を重ねる', C.light);
    box(5.0, 4.35, 4.5, 0.8, 'Dexie（IndexedDB）', 'scores / sections / takes / matchResults', C.light);
    s.addShape(pres.ShapeType.line, { x: 8.4, y: 4.1, w: 0.01, h: 0.25, line: { color: C.gray, width: 2, endArrowType: 'triangle' } });
    s.addNotes('前身との違いは期待音符列が入力にあること。録音同士のアライメントは、格子から外れた時の保険に降格する。重い処理は Web Worker へ。');
  }

  // ---------- 10. Engines ----------
  {
    const s = base();
    header(s, '照合エンジンは3案を並べて検証する', '前身は Basic Pitch 一択だった。同じインターフェースの裏に置き、M-A で既定を決める');
    const eng = [
      ['A', 'Basic Pitch ＋ 吸着', '前身の資産。期待音の時間窓の中に、その音高の検出があるかを見る', '弱点：ストローク和音、16分音符級の速さ（前身で実測）', C.light],
      ['B', '単音ピッチトラッカー', 'YIN 系を TypeScript で小さく実装。窓内の基本周波数の中央値で判定', '対象：単旋律の区間のみ。軽くて速い', C.light],
      ['C', '楽譜情報を使ったスペクトル照合', '音符起こしを介さない。期待音の周波数帯域にエネルギーの立ち上がりがあるかを見る', '和音・ストローク向き。倍音衝突の偽陽性が課題', C.paleAmber],
    ];
    eng.forEach(([id, t, d, n, fill], k) => {
      const x = 0.5 + k * 3.05;
      card(s, x, 1.5, 2.9, 3.0, fill);
      s.addShape(pres.ShapeType.ellipse, { x: x + 0.25, y: 1.7, w: 0.6, h: 0.6, fill: { color: C.walnut }, line: { color: C.walnut, width: 0 } });
      text(s, id, { x: x + 0.25, y: 1.7, w: 0.6, h: 0.6, fontSize: 20, bold: true, color: C.white, align: 'center', valign: 'middle' });
      text(s, t, { x: x + 0.25, y: 2.4, w: 2.4, h: 0.55, fontSize: 14, bold: true, color: C.walnut });
      text(s, d, { x: x + 0.25, y: 3.0, w: 2.4, h: 0.85, fontSize: 11.5, color: C.ink });
      text(s, n, { x: x + 0.25, y: 3.85, w: 2.4, h: 0.6, fontSize: 10.5, color: C.gray, italic: true });
    });
    text(s, '仮説：単音の区間は B、和音を含む区間は C を既定にし、A は比較用に残す。合成音への誤り注入と自分の実録音で、検出率と誤警報率を測って決める。', { x: 0.5, y: 4.65, w: 9, h: 0.55, fontSize: 12, color: C.walnut, bold: true });
    s.addNotes('C が成立すれば、前身で原理的に扱えなかったストロークを「構成音が全部鳴ったか」で初めて測れる。押さえ損ねた弦が隣の弦の倍音で埋まる偽陽性を M-A で確かめる。');
  }

  // ---------- 11. Result view ----------
  {
    const s = base();
    header(s, '結果の見せ方', '一致した音は描かない。音高違い・欠落・遅れ・余分だけを楽譜の上に重ねる');
    // staff mock
    card(s, 0.5, 1.5, 5.9, 2.6, C.white);
    s.addShape(pres.ShapeType.roundRect, { x: 0.5, y: 1.5, w: 5.9, h: 2.6, fill: { color: C.white }, line: { color: C.line, width: 1 }, rectRadius: 0.06 });
    const sy = 2.2; const gap = 0.14;
    staffLines(s, 0.8, sy, 5.3, C.staff, gap);
    // bar lines
    [0.8, 2.55, 4.3, 6.1].forEach(x => s.addShape(pres.ShapeType.line, { x, y: sy, w: 0, h: gap * 4, line: { color: C.staff, width: 1 } }));
    const note = (x, y, o = {}) => {
      s.addShape(pres.ShapeType.ellipse, Object.assign({ x, y: y - 0.07, w: 0.2, h: 0.14, fill: { color: C.ink }, line: { color: C.ink, width: 0 } }, o));
      s.addShape(pres.ShapeType.line, { x: x + 0.19, y: y - 0.6, w: 0, h: 0.6, line: { color: o.stem || C.ink, width: 1 } });
    };
    // measure 1: all matched
    note(1.0, sy + gap * 3); note(1.4, sy + gap * 2.5); note(1.8, sy + gap * 2); note(2.2, sy + gap * 1.5);
    // measure 2: wrongPitch at 2nd, late at 4th
    note(2.75, sy + gap * 2);
    note(3.15, sy + gap * 1.5);
    s.addShape(pres.ShapeType.roundRect, { x: 3.08, y: sy + gap * 1.5 - 0.16, w: 0.34, h: 0.32, fill: { color: C.white, transparency: 100 }, line: { color: C.red, width: 1.5 }, rectRadius: 0.04 });
    text(s, 'F♯', { x: 3.0, y: sy - 0.72, w: 0.5, h: 0.25, fontSize: 10, bold: true, color: C.red, align: 'center' });
    note(3.55, sy + gap * 1);
    note(3.95, sy + gap * 0.5);
    arrow(s, 4.0, sy + gap * 4 + 0.15, 4.35, sy + gap * 4 + 0.15, C.amber);
    text(s, '+62ms', { x: 3.8, y: sy + gap * 4 + 0.22, w: 0.8, h: 0.22, fontSize: 9, color: C.amber, align: 'center' });
    // measure 3: missing at 2nd (dashed), extra
    note(4.5, sy + gap * 3);
    s.addShape(pres.ShapeType.ellipse, { x: 4.9, y: sy + gap * 2.5 - 0.07, w: 0.2, h: 0.14, fill: { color: C.white }, line: { color: C.gray, width: 1.25, dashType: 'dash' } });
    s.addShape(pres.ShapeType.line, { x: 5.09, y: sy + gap * 2.5 - 0.6, w: 0, h: 0.6, line: { color: C.gray, width: 1, dashType: 'dash' } });
    note(5.3, sy + gap * 2); note(5.7, sy + gap * 1.5);
    text(s, '+', { x: 5.45, y: sy + gap * 4 + 0.12, w: 0.3, h: 0.3, fontSize: 14, bold: true, color: C.amber, align: 'center' });
    // heatmap band under staff
    text(s, '小節ごとの集計（欠落＋音高違いの割合）', { x: 0.8, y: 3.35, w: 4, h: 0.25, fontSize: 9.5, color: C.gray });
    [['1', 'E8E8E8', '0%'], ['2', 'F3C9A6', '25%'], ['3', 'E9A57A', '33%']].forEach(([m, col, p], k) => {
      const x = 0.8 + k * 1.77;
      s.addShape(pres.ShapeType.rect, { x, y: 3.62, w: 1.72, h: 0.3, fill: { color: col }, line: { color: C.white, width: 1 } });
      text(s, `小節 ${m}　${p}`, { x, y: 3.62, w: 1.72, h: 0.3, fontSize: 9.5, color: C.ink, align: 'center', valign: 'middle' });
    });
    // legend
    const leg = [
      ['音高違い', '赤枠と検出音名', C.red],
      ['欠落', '灰色の破線', C.gray],
      ['遅れ / 走り', '80ms 超だけ矢印と ms', C.amber],
      ['余分な音', '五線の下に「+」', C.amber],
      ['一致', '何も描かない', C.green],
    ];
    leg.forEach(([t, d, col], k) => {
      const y = 1.55 + k * 0.52;
      s.addShape(pres.ShapeType.ellipse, { x: 6.7, y: y + 0.08, w: 0.22, h: 0.22, fill: { color: col }, line: { color: col, width: 0 } });
      text(s, t, { x: 7.05, y, w: 2.4, h: 0.25, fontSize: 12, bold: true, color: C.walnut });
      text(s, d, { x: 7.05, y: y + 0.24, w: 2.4, h: 0.25, fontSize: 10, color: C.gray });
    });
    text(s, '録音を聴き返すと、楽譜上のカーソルが録音に同期して動く。履歴はテンポ別に一致率とばらつき（ms）を並べる。', { x: 0.5, y: 4.45, w: 9, h: 0.6, fontSize: 12, color: C.walnut });
    s.addNotes('緑で埋めると楽譜が読めなくなるので、一致は描かない。alphaTab の座標参照から音符の位置を取り、SVG を重ねる。');
  }

  // ---------- 12. Risks ----------
  {
    const s = base();
    header(s, 'リスクと対策', '前身から引き継ぐものと、本提案で新たに生じるもの');
    const rows = [
      ['FiEdit3', '手入力の手間が続くか', '区間1つの打ち込みが 20 分を超え続けるなら、入口（OMR）の見直しを判断する。M-A で所要時間を記録'],
      ['FiMic', '実録音での精度が未計測（前身から）', '合成音は実機より素直。M-A で自分の実録音を必ず通し、「正しく弾いたのに欠落と出る」割合を最重要の数字にする'],
      ['FiAlertTriangle', 'エンジン C の倍音衝突', '1音抜きのストロークを合成して検出できるか確認。無理なら v1 の和音判定は「過半数が鳴ったか」の粗さに落とす'],
      ['FiMusic', '記譜オクターブの慣習', 'ギター譜は実音より1オクターブ高く書く。取り込み時にプレビューで確認し、全音が ±12 ずれたら警告する'],
    ];
    rows.forEach(([i, t, d], k) => {
      const y = 1.42 + k * 0.88;
      iconCircle(s, 0.5, y + 0.05, 0.55, ic[i], k === 2 ? C.red : C.walnut);
      text(s, t, { x: 1.25, y, w: 8.2, h: 0.3, fontSize: 14, bold: true, color: C.walnut });
      text(s, d, { x: 1.25, y: y + 0.32, w: 8.2, h: 0.55, fontSize: 11.5, color: C.ink });
    });
    text(s, 'いずれも M-A（3週）の中で数字を取って判断できる。被験者が事実上1人に留まる点は前身と同じ。', { x: 0.5, y: 5.0, w: 8.6, h: 0.3, fontSize: 11, color: C.gray, italic: true });
    s.addNotes('残り期間のリスク：前身と本提案の両方は進められない。最後のスライドで判断を仰ぐ。');
  }

  // ---------- 13. Plan ----------
  {
    const s = base();
    header(s, '残り約3ヶ月の計画', '週数は 12 週を前提。6ヶ月枠を取り直す場合は M-B 以降を倍に伸ばす');
    const total = 12; const x0 = 0.5; const wAll = 9.0;
    const ms = [
      ['M-A', 3, '技術検証', ['alphaTab のタイムライン・オクターブ補正・同時音スロット', 'エンジン A/B/C を合成音＋実録音で比較', '自分の区間を 2〜3 個打ち込み、所要時間を記録'], C.amber],
      ['M-B', 5, 'MVP', ['取り込み → 区間 → クリック録音 → 音符単位の結果 → 履歴', 'Dexie スキーマ、楽譜上のオーバーレイ'], C.walnut],
      ['M-C', 2, '調整', ['許容ルール、同期再生、クリア判定', '余裕があれば OMR 経路を試す'], '8C7B70'],
      ['M-D', 2, 'まとめ', ['実録音で再計測、Android で動作確認', '成果まとめ'], C.gray],
    ];
    let x = x0;
    ms.forEach(([id, w, t, items, col]) => {
      const bw = wAll * w / total;
      s.addShape(pres.ShapeType.rect, { x, y: 1.5, w: bw - 0.04, h: 0.6, fill: { color: col }, line: { color: col, width: 0 } });
      text(s, `${id} ${t}\n${w}週`, { x: x + 0.1, y: 1.5, w: bw - 0.24, h: 0.6, fontSize: 11, bold: true, color: C.white, valign: 'middle' });
      bullets(s, items, { x: x + 0.05, y: 2.25, w: bw - 0.15, h: 2.2, fontSize: 10.5 });
      x += bw;
    });
    text(s, '最初の1週間で alphaTab の API（tick ルックアップ、トランスポーズの反映、同期点）を確定させる。ここが想定と違えば設計の該当箇所を直す。', { x: 0.5, y: 4.6, w: 9, h: 0.55, fontSize: 12, color: C.walnut, bold: true });
    s.addNotes('前身の資産（録音・前処理・拍格子・アライメント・履歴 UI・合成音基盤・PWA シェル）を持ち越すので、M-B は5週で見込める。');
  }

  // ---------- 14. Summary ----------
  {
    const s = base(true);
    staffLines(s, 5.6, 0.3, 4.4, '6B5545', 0.22);
    text(s, 'まとめ', { x: 0.6, y: 0.5, w: 4, h: 0.6, fontSize: 28, bold: true, color: C.white });
    bullets(s, ['自己比較は「正しさ」を測れない。楽譜ファイルを正解にすれば根本から解消できる', '正解があると問題が「鳴ったかを確かめる」に変わり、和音も検証可能になる', 'v1 は入口をファイルに絞り、照合の価値を3ヶ月で確かめる。前身の資産は持ち越す'], { x: 0.6, y: 1.3, w: 8.8, h: 1.8, fontSize: 14, color: C.white });
    card(s, 0.6, 3.3, 8.8, 1.7, '4E3A2E');
    text(s, '判断をお願いしたいこと', { x: 0.85, y: 3.45, w: 5, h: 0.35, fontSize: 14, bold: true, color: C.amber });
    bullets(s, ['前身（自己比較アプリ）を中間報告の成果として凍結し、本提案に切り替えてよいか', '期間：残り3ヶ月で v1 まで進めるか、6ヶ月枠を取り直すか'], { x: 0.85, y: 3.85, w: 8.3, h: 1.0, fontSize: 13, color: C.white });
    s.addNotes('切り替えの判断と期間の判断を仰ぐ。');
  }

  await pres.writeFile({ fileName: OUT });
  console.log('written', OUT);
})().catch(e => { console.error(e); process.exit(1); });
