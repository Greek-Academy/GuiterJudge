// ONNX Runtime Web の WASM(14 MB)を node_modules から public/ort/ にコピーする。リポジトリには入れない(postinstall で実行)。
// 生徒モデル(src/student/studentTranscribe.ts)が ort.env.wasm.wasmPaths = BASE_URL + 'ort/' から読む
import fs from 'node:fs'
import path from 'node:path'
const src = path.resolve('node_modules/onnxruntime-web/dist'), dst = path.resolve('public/ort')
fs.mkdirSync(dst, { recursive: true })
for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) fs.copyFileSync(path.join(src, f), path.join(dst, f))
console.log('copied ONNX Runtime WASM to public/ort/')
