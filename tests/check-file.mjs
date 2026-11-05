#!/usr/bin/env node
/**
 * tests/check-file.mjs —— `check --file` 外部图体检的离线回归
 *
 * 只读本地文件、只造临时文件，不联网、不花钱。
 * 跑法：node tests/check-file.mjs
 */
import { mkdtempSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const { checkFile } = await import(join(ROOT, 'scripts', 'check.mjs'))

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${name}${extra ? `  —— ${extra}` : ''}`) } else { fail += 1; console.log(`FAIL  ${name}${extra ? `  —— ${extra}` : ''}`) }
}
const codes = (r) => (r.issues || []).map((i) => i.code)

const tmp = mkdtempSync(join(tmpdir(), 'pf-checkfile-test-'))

/* ---------- 1. 真实 PNG（我们的示例图，Chrome 导出，未写 pHYs） ---------- */
const png = join(ROOT, 'examples', 'framework-overview.png')
if (existsSync(png)) {
  const r = await checkFile(png, { journal: 'nature' })
  ok('PNG：Nature 主图拒收位图', codes(r).includes('FILE_RASTER_FOR_VECTOR_JOURNAL'), codes(r).join(','))
  ok('PNG：格式不在接受清单里', codes(r).includes('FILE_FORMAT_NOT_ACCEPTED'))
  ok('PNG：没写 DPI 时如实说「查不到」而不是假装合格', codes(r).includes('FILE_DPI_UNDECLARED'))
  ok('PNG：不通过（pass=false）', r.pass === false)
  ok('PNG：报告里有「按 300dpi 折算」的参考尺寸', /按 300dpi 折算/.test(r.summary.text))
} else {
  console.log('SKIP  示例 PNG 不存在，跳过 PNG 用例')
}

/* ---------- 2. 真实 SVG：走完整深度检查 ---------- */
const svg = join(ROOT, 'examples', 'framework-overview.svg')
if (existsSync(svg)) {
  const r = await checkFile(svg, { journal: 'nature' })
  ok('SVG：深度检查通过且模式标为 file', r.pass === true && r.mode === 'file')
  ok('SVG：读到物理尺寸 183mm 左右', Math.abs((r.summary.stats.width_mm || 0) - 183) < 1.5, String(r.summary.stats.width_mm))
} else {
  console.log('SKIP  示例 SVG 不存在，跳过 SVG 用例')
}

/* ---------- 3. 造一个「单页、字体已嵌入」的 PDF ---------- */
const pdfOk = join(tmp, 'vector-a.pdf')
writeFileSync(pdfOk, [
  '%PDF-1.4',
  '1 0 obj << /Type /Page /MediaBox [0 0 252 169.92] /Resources << /Font << /F1 2 0 R >> >> >> endobj',
  '2 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Arial /FontDescriptor 3 0 R >> endobj',
  '3 0 obj << /Type /FontDescriptor /FontName /Arial /FontFile2 4 0 R >> endobj',
  '4 0 obj << /Length 10 >> stream\nxxxx\nendstream endobj',
  '5 0 obj << /Type /Pages /Kids [1 0 R] /Count 1 >> endobj',
  'trailer << /Root 5 0 R >>',
  '%%EOF'
].join('\n'))
{
  const r = await checkFile(pdfOk, { journal: 'nature' })
  ok('PDF：MediaBox 252×169.92pt → 89×60mm', Math.abs((r.summary.stats.width_mm || 0) - 89) < 1 && Math.abs((r.summary.stats.height_mm || 0) - 60) < 1,
    `${r.summary.stats.width_mm}×${r.summary.stats.height_mm}mm`)
  ok('PDF：单页、字体已嵌入时不报错', r.pass === true, codes(r).join(','))
}

/* ---------- 4. 造一个「文字没嵌字体」的 PDF ---------- */
const pdfBad = join(tmp, 'no-embed.pdf')
writeFileSync(pdfBad, [
  '%PDF-1.4',
  '1 0 obj << /Type /Page /MediaBox [0 0 252 169.92] /Resources << /Font << /F1 2 0 R >> >> >> endobj',
  '2 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >> endobj',
  '3 0 obj << /Type /Pages /Kids [1 0 R] /Count 1 >> endobj',
  'trailer << /Root 3 0 R >>',
  '%%EOF'
].join('\n'))
{
  const r = await checkFile(pdfBad, { journal: 'nature' })
  ok('PDF：有文字却没嵌字体 → error', codes(r).includes('FILE_PDF_FONT_NOT_EMBEDDED'))
}

/* ---------- 5. 多页 PDF ---------- */
const pdfMulti = join(tmp, 'multi.pdf')
writeFileSync(pdfMulti, [
  '%PDF-1.4',
  '1 0 obj << /Type /Page /MediaBox [0 0 252 169.92] >> endobj',
  '2 0 obj << /Type /Page /MediaBox [0 0 252 169.92] >> endobj',
  '3 0 obj << /Type /Pages /Kids [1 0 R 2 0 R] /Count 2 >> endobj',
  'trailer << /Root 3 0 R >>',
  '%%EOF'
].join('\n'))
{
  const r = await checkFile(pdfMulti, { journal: 'nature' })
  ok('PDF：多页会提醒「一图一文件」', codes(r).includes('FILE_PDF_MULTIPLE_PAGES'))
}

/* ---------- 6. 超栏宽的外部 SVG ---------- */
const wideSvg = join(tmp, 'too-wide.svg')
writeFileSync(wideSvg, '<svg xmlns="http://www.w3.org/2000/svg" width="240mm" height="60mm" viewBox="0 0 240 60"><text x="10" y="20" font-family="Arial" font-size="7" data-role="node-label">A</text></svg>')
{
  const r = await checkFile(wideSvg, { journal: 'nature' })
  ok('SVG：240mm 超双栏宽 → error', codes(r).includes('FIG_WIDTH_TOO_WIDE'), codes(r).join(','))
}

/* ---------- 7. AI 生成图被当数据图 ---------- */
if (existsSync(png)) {
  const aiPng = join(tmp, 'concept-1.png')
  copyFileSync(png, aiPng)
  writeFileSync(join(tmp, 'concept-1.ai-generated.json'), JSON.stringify({ model: 'gpt-image-2.5-1k', note: 'test' }))
  const r = await checkFile(aiPng, { journal: 'custom' })
  ok('AI 图：有 .ai-generated.json 标记 → error', codes(r).includes('AI_IMAGE_AS_DATA_FIGURE'))
}

/* ---------- 8. 找不到文件 ---------- */
{
  const r = await checkFile(join(tmp, 'nope.png'), { journal: 'nature' })
  ok('文件不存在 → FILE_NOT_FOUND 且不崩', codes(r).includes('FILE_NOT_FOUND'))
}

/* ---------- 9. 认不出的类型 ---------- */
{
  const weird = join(tmp, 'figure.fig')
  writeFileSync(weird, 'not a figure at all')
  const r = await checkFile(weird, { journal: 'nature' })
  ok('认不出的类型 → FILE_UNSUPPORTED', codes(r).includes('FILE_UNSUPPORTED'))
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
