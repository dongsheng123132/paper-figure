#!/usr/bin/env node
/**
 * tests/report.mjs —— 报告导出（v1.3）离线回归
 *
 * 覆盖：
 *   - buildReport 生成自包含 HTML（无外链、样式内联、图内联）
 *   - 有 review.json 时把「修改清单」放在分数前面
 *   - 没有 review 时明确写「这次没跑会审」
 *   - 可选：PF_TEST_PDF=1 时跑一次真实 PDF（需要 Chrome，慢）
 * 不联网、不花钱。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const { buildReport } = await import(join(ROOT, 'scripts', 'report.mjs'))
const { checkFigure } = await import(join(ROOT, 'scripts', 'check.mjs'))
const { createWorkspaceFromBlueprint } = await import(join(ROOT, 'scripts', 'blueprints.mjs'))
const { renderFigure } = await import(join(ROOT, 'scripts', 'render.mjs'))

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${name}${extra ? `  —— ${extra}` : ''}`) } else { fail += 1; console.log(`FAIL  ${name}${extra ? `  —— ${extra}` : ''}`) }
}

const tmp = mkdtempSync(join(tmpdir(), 'pf-report-'))
const dir = join(tmp, 'fig')
createWorkspaceFromBlueprint(dir, 'rag-pipeline', { journal: 'nature' })
await renderFigure(dir)
await checkFigure(dir, { write: true })

const r1 = await buildReport(dir, {})
ok('buildReport 返回 ok 且写出 HTML', r1.ok && existsSync(r1.htmlPath), r1.htmlPath)
const html1 = readFileSync(r1.htmlPath, 'utf8')
ok('HTML 标题正确', html1.includes('投稿前体检报告'))
ok('样式内联（<style>）', html1.includes('<style>'))
ok('没有外链资源（src/href 指向 http）', !/(src|href)="https?:\/\//.test(html1))
ok('图是内联的（svg 或 data URI）', /<svg/.test(html1) || /data:image\//.test(html1))
ok('写了目标期刊', html1.includes('Nature'))
ok('没有会审时明说', html1.includes('没有跑多 AI 会审') || html1.includes('未跑会审'))
ok('列了规则来源', html1.includes('规则来源'))
ok('报告少于 2MB（可邮件发送）', statSync(r1.htmlPath).size < 2 * 1024 * 1024, `${Math.round(statSync(r1.htmlPath).size / 1024)}KB`)

// 造一份 review.json：修改清单应排在分数前面
writeFileSync(join(dir, 'out', 'review.json'), JSON.stringify({
  verdict: '图能投，但字号偏小、图注缺英文版。',
  fixes: [
    { where: '字号', action: '把 font_size_pt 从 7 改到 8，再跑一次 check', why: '缩到栏宽后只剩 6pt' },
    { where: '图注', action: '补一句英文图注 caption_en', why: '学位论文/多数中文刊要求中英双语' },
  ],
  scores: { 视觉: 7, 信息: 8, 合规: 6 },
  sections: { 共识: '成员一致认为图能投；分歧在字号。' },
}, null, 2))

const r2 = await buildReport(dir, {})
const html2 = readFileSync(r2.htmlPath, 'utf8')
const idxFixes = html2.indexOf('会审给的修改清单')
const idxScores = html2.indexOf('三维打分')
ok('会审修改清单出现在报告里', idxFixes > 0)
ok('清单排在分数前面（卖清单不卖分数）', idxFixes > 0 && idxScores > idxFixes, `fixes@${idxFixes} scores@${idxScores}`)
ok('分数带「只用于横向比较」说明', html2.includes('只用于横向比较'))
ok('判词与独到意见都在', html2.includes('图能投') && html2.includes('共识'))

// 6) 内联 SVG 必须被清理：脚本/事件属性不能进报告
const svgPath = join(dir, 'out', 'rag-pipeline-diagram.svg')
const original = readFileSync(svgPath, 'utf8')
writeFileSync(svgPath, original.replace('</svg>', '<script>alert(1)</script><rect onload="alert(2)" x="0" y="0" width="1" height="1"/></svg>'))
const r4 = await buildReport(dir, {})
const html4 = readFileSync(r4.htmlPath, 'utf8')
ok('SVG 内联前被清理（script 不进报告）', !html4.includes('<script>alert(1)</script>'))
ok('SVG 内联前被清理（事件属性 onload 不进报告）', !/onload\s*=/i.test(html4))
writeFileSync(svgPath, original)

if (process.env.PF_TEST_PDF === '1') {
  const r3 = await buildReport(dir, { pdf: true, timeoutMs: 120000 })
  ok('PDF 出了且页数 ≥1', Boolean(r3.pdfPath) && existsSync(r3.pdfPath) && (r3.stats.pdfPages || 0) >= 1, r3.pdfPath ? `${r3.stats.pdfPages} 页` : (r3.notes || []).join(';'))
} else {
  console.log('SKIP  PDF 用例（设 PF_TEST_PDF=1 才跑，需要 Chrome）')
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
