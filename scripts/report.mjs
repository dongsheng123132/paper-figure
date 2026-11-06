/**
 * scripts/report.mjs —— 把 check / review 的结果导成「导师/合作者能读」的报告（v1.3）
 *
 * 设计取舍（来自 luna 的评审意见）：
 *   - 先做**自包含 HTML**：样式内联、图片内联（base64），报告文件移动到任何地方都不会丢资源；
 *   - 每条结论都带「级别 / code / 怎么改」，中文刊/学位论文的「待核」显式标出来，不装权威；
 *   - A4 打印样式 + 避免表格行跨页；PDF 是可选项（本机没 Chrome 就只给 HTML，并说清楚）。
 *
 * 接口：
 *   buildReport(workDir, opts) -> { ok, htmlPath, pdfPath?, stats }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSpec } from './spec.mjs'
import { checkFigure, resolvePreset } from './check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function toolVersion() {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '' } catch { return '' }
}

function dataUri(file) {
  try {
    const buf = readFileSync(file)
    if (buf.length > 6 * 1024 * 1024) return null // 太大就别内联，避免报告变几十兆
    const ext = file.toLowerCase().endsWith('.png') ? 'png' : file.toLowerCase().endsWith('.jpg') ? 'jpeg' : 'svg+xml'
    return `data:image/${ext};base64,${buf.toString('base64')}`
  } catch { return null }
}

/** 内联前清理 SVG：去掉脚本、事件属性、外链与 HTML 外壳（报告只该是「展示」） */
function sanitizeSvg(svg) {
  return String(svg)
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\s(?:xlink:href|href)\s*=\s*"(?:https?:|\/\/|javascript:|data:text\/html)[^"]*"/gi, '')
}

/** 把 out/ 里最新的 SVG 内联进报告（矢量、清晰、无外部依赖） */
function inlineFigure(outDir, spec) {
  try {
    const svgs = (spec && spec.name ? [`${spec.name}-diagram.svg`, `${spec.name}-chart.svg`, `${spec.name}.svg`] : [])
      .map((f) => join(outDir, f))
      .filter((f) => existsSync(f))
    if (svgs.length) {
      const cleaned = sanitizeSvg(readFileSync(svgs[0], 'utf8'))
      return { kind: 'svg', html: `<div class="figure">${cleaned}</div>`, file: basename(svgs[0]) }
    }
    const pngs = ['@300dpi.png', '.png'].map((s) => join(outDir, `${spec.name}${s}`)).filter((f) => existsSync(f))
    if (pngs.length) {
      const uri = dataUri(pngs[0])
      if (uri) return { kind: 'png', html: `<div class="figure"><img alt="figure" src="${uri}"></div>`, file: basename(pngs[0]) }
    }
  } catch { /* ignore */ }
  return { kind: 'none', html: '<p class="muted">（out/ 里还没有可展示的图；先跑 render 或 chart）</p>', file: null }
}

function issueRows(issues) {
  if (!issues || !issues.length) return '<tr><td colspan="4" class="muted">没有发现问题。</td></tr>'
  return issues
    .map(
      (i) => `<tr class="row ${i.level}">
  <td><span class="badge ${i.level}">${i.level === 'error' ? '必须改' : i.level === 'warn' ? '建议改' : '提示'}</span></td>
  <td class="code">${esc(i.code)}</td>
  <td>${esc(i.message)}</td>
  <td>${esc(i.fix || '')}</td>
</tr>`,
    )
    .join('\n')
}

function reviewBlock(review) {
  if (!review) {
    return '<p class="muted">这次没有跑多 AI 会审（<code>node scripts/fig.mjs review &lt;dir&gt;</code>）；报告只包含确定性检查结论。</p>'
  }
  const fixes = Array.isArray(review.fixes) ? review.fixes : []
  const scores = review.scores && typeof review.scores === 'object' ? review.scores : null
  const sections = review.sections && typeof review.sections === 'object' ? review.sections : null
  const lines = []
  if (review.verdict) lines.push(`<p class="verdict">${esc(review.verdict)}</p>`)
  if (fixes.length) {
    lines.push('<h3>会审给的修改清单（先做这些）</h3><ol class="fixes">')
    for (const f of fixes) {
      const where = f.where || f.dimension || ''
      const action = f.action || f.fix || (typeof f === 'string' ? f : JSON.stringify(f))
      lines.push(`<li>${where ? `<b>${esc(where)}</b>：` : ''}${esc(action)}${f.why ? `<span class="muted">（${esc(f.why)}）</span>` : ''}</li>`)
    }
    lines.push('</ol>')
  }
  if (scores) {
    lines.push('<h3>三维打分<span class="muted">（只用于横向比较两版，不当作验收标准）</span></h3><ul class="scores">')
    for (const [k, v] of Object.entries(scores)) lines.push(`<li>${esc(k)}：<b>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</b></li>`)
    lines.push('</ul>')
  }
  if (sections) {
    for (const [k, v] of Object.entries(sections)) {
      if (!v) continue
      lines.push(`<h3>${esc(k)}</h3><pre class="section">${esc(typeof v === 'string' ? v : JSON.stringify(v, null, 2))}</pre>`)
    }
  }
  return lines.join('\n')
}

const CSS = `
:root { --ink:#1a1a1a; --muted:#666; --line:#dcdcdc; --bg:#fff; --red:#c0392b; --amber:#9a6700; --blue:#0b62a4; }
* { box-sizing: border-box; }
body { margin:0; padding:24px 32px; color:var(--ink); background:var(--bg);
  font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif;
  font-size:13px; line-height:1.65; }
h1 { font-size:20px; margin:0 0 4px; }
h2 { font-size:15px; margin:24px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--line); }
h3 { font-size:13.5px; margin:16px 0 6px; }
.muted { color:var(--muted); }
.meta { display:flex; flex-wrap:wrap; gap:6px 18px; color:var(--muted); font-size:12px; margin-bottom:6px; }
.verdict { padding:10px 12px; border-left:3px solid var(--blue); background:#f5f9fd; margin:8px 0; }
.verdict .big { font-size:15px; font-weight:600; }
table { width:100%; border-collapse:collapse; font-size:12px; }
th, td { text-align:left; vertical-align:top; padding:6px 8px; border-bottom:1px solid var(--line); }
th { color:var(--muted); font-weight:500; }
tr.row { page-break-inside:avoid; break-inside:avoid; }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px; white-space:nowrap; }
.badge { display:inline-block; padding:0 6px; border-radius:9px; font-size:11px; white-space:nowrap; }
.badge.error { background:#fdecea; color:var(--red); }
.badge.warn { background:#fff7e0; color:var(--amber); }
.badge.info { background:#eef4fb; color:var(--blue); }
.figure svg, .figure img { max-width:100%; height:auto; border:1px solid var(--line); }
ol.fixes li { margin:4px 0; page-break-inside:avoid; }
pre.section { white-space:pre-wrap; background:#fafafa; border:1px solid var(--line); padding:8px; font-size:11.5px; }
footer { margin-top:28px; padding-top:10px; border-top:1px solid var(--line); color:var(--muted); font-size:11.5px; }
@page { size: A4; margin: 14mm 12mm; }
@media print { body { padding:0; font-size:11.5px; } h2 { page-break-after:avoid; } .figure { page-break-inside:avoid; } }
`

/**
 * 生成报告。
 * @param {string} workDir
 * @param {{pdf?:boolean, out?:string, timeoutMs?:number, write?:boolean}} opts
 */
export async function buildReport(workDir, opts = {}) {
  const wd = resolve(workDir || '.')
  const outDir = join(wd, 'out')
  const spec = readSpec(wd)
  const preset = await resolvePreset(spec.journal || 'custom')
  const p = preset.preset || preset

  // 报告必须反映「现在的图」：每次重跑 checkFigure（本地、免费、毫秒级），
  // 不直接吃 out/check.json —— 否则图改了、报告还是旧的。
  let check = null
  let checkFresh = true
  try {
    const r = await checkFigure(wd, { write: true })
    check = readJson(join(outDir, 'check.json')) || r
  } catch (e) {
    check = readJson(join(outDir, 'check.json'))
    checkFresh = false
  }
  const review = readJson(join(outDir, 'review.json'))
  const fig = inlineFigure(outDir, spec)
  const version = toolVersion()
  const now = new Date()

  const errors = (check && Number(check.errors)) || 0
  const warns = (check && Number(check.warns)) || 0
  const pass = Boolean(check && check.pass)
  const verdictClass = pass ? 'ok' : 'bad'
  const verdictText = pass ? '确定性检查通过（没有必须改的问题）' : `有 ${errors} 个必须改的问题`

  const issues = (check && check.issues) || []
  const stats = (check && check.stats) || {}
  const dims = [stats.width_mm && `${stats.width_mm}mm 宽`, stats.height_mm && `${stats.height_mm}mm 高`].filter(Boolean).join(' × ')

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.name || 'figure')} · 投稿前体检报告</title>
<style>${CSS}</style>
</head><body>
<h1>${esc(spec.name || 'figure')} · 投稿前体检报告</h1>
<div class="meta">
  <span>目标期刊：<b>${esc(p.label || p.id || '')}</b>${p.verified === '待核' ? '（规格待核）' : p.verified ? `（核实于 ${esc(p.verified)}）` : ''}</span>
  ${dims ? `<span>图尺寸：${esc(dims)}</span>` : ''}
  <span>生成时间：${now.toISOString().replace('T', ' ').slice(0, 16)}</span>
  <span>工具：paper-figure v${esc(version)}</span>
</div>

<div class="verdict ${verdictClass}">
  <div class="big">${esc(verdictText)}</div>
  <div class="muted">必须改 ${errors} 条 · 建议看 ${warns} 条${review ? ' · 含多 AI 会审' : ' · 未跑会审'}</div>
</div>

<h2>图</h2>
${fig.html}

<h2>确定性检查（本地跑，不花钱）</h2>
<table><thead><tr><th style="width:64px">级别</th><th style="width:210px">code</th><th>问题</th><th style="width:34%">怎么改</th></tr></thead>
<tbody>
${issueRows(issues)}
</tbody></table>

<h2>多 AI 会审</h2>
${reviewBlock(review)}

<footer>
  <p>规则来源：${esc(p.source || '见 references/journal-specs.md')}${p.unverified_fields && p.unverified_fields.length ? `；以下字段仍是「待核」，别当法条用：${esc(p.unverified_fields.join('、'))}` : ''}</p>
  <p>这份报告只对「期刊作者指南里公开写明的规格」负责，不承诺过审。图注内容、数据真实性、统计正确性需要作者本人负责。</p>
</footer>
</body></html>`

  const htmlPath = opts.out ? resolve(wd, opts.out) : join(outDir, 'report.html')
  if (opts.write !== false) {
    mkdirSync(dirname(htmlPath), { recursive: true })
    writeFileSync(htmlPath, html, 'utf8')
  }

  const result = {
    ok: true,
    htmlPath,
    journal: { id: p.id, label: p.label, verified: p.verified || null },
    stats: { errors, warns, pass, issues: issues.length, hasReview: Boolean(review), figure: fig.file, figureKind: fig.kind, checkFresh },
    notes: [],
  }

  if (opts.pdf) {
    const { htmlToPdf } = await import('./export.mjs')
    let pdfSource = htmlPath
    let tmpHtml = null
    if (opts.write === false) {
      // 没落盘就没有 HTML 可打印：先写一份临时文件，打完删掉
      const { mkdtempSync, rmSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const tmp = mkdtempSync(join(tmpdir(), 'pf-report-html-'))
      tmpHtml = join(tmp, 'report.html')
      writeFileSync(tmpHtml, html, 'utf8')
      pdfSource = tmpHtml
    }
    const pdfPath = htmlPath.replace(/\.html?$/i, '') + '.pdf'
    const r = await htmlToPdf({ htmlPath: pdfSource, pdfPath, timeoutMs: opts.timeoutMs })
    if (tmpHtml) {
      try {
        const { rmSync } = await import('node:fs')
        rmSync(tmpHtml, { force: true })
      } catch { /* ignore */ }
    }
    if (r.ok) {
      result.pdfPath = pdfPath
      result.stats.pdfPages = r.pages
      result.stats.pdfBytes = existsSync(pdfPath) ? statSync(pdfPath).size : null
    } else {
      result.notes.push(r.reason || 'PDF 导出失败，HTML 仍然可用。')
    }
  }

  return result
}

export default buildReport
