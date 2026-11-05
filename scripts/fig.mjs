#!/usr/bin/env node
// scripts/fig.mjs —— paper-figure 命令行入口（唯一分发点）
//
// 用法：node scripts/fig.mjs <命令> [工作区] [--参数 值]
//
// 约定（跟 BRIEF §5.1 一致）：
//   · stdout 只出 JSON：成功 {ok:true,...}，失败 {ok:false,error,fix}；
//   · stderr 出人话进度，脚本里可以随便 log 而不会污染 JSON；
//   · 退出码：0 成功 / 1 失败 / 2「模块未就绪」（platform-tools 的模块还没落地）。
//
// 本文件只做参数解析与分发，渲染逻辑在 render.mjs / chart.mjs，检查导出在 platform-tools 的模块里。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PFError } from './lib/util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const HELP = {
  name: 'paper-figure',
  version: readVersion(),
  usage: 'node scripts/fig.mjs <命令> [工作区] [--参数 值]',
  commands: [
    { cmd: 'init <dir>', what: '建工作区：brief.md / figure.json / data/main.csv / out/', cost: '免费' },
    { cmd: 'templates', what: '列结构图模板：Transformer/编码器-解码器/CNN/GNN/RAG/Agent/训练流程/注意力/消融对比', cost: '免费' },
    { cmd: 'new <dir> --template <id>', what: '从模板建工作区（figure.json + brief.md + data/ + out/）', cost: '免费' },
    { cmd: 'spec <dir>', what: 'brief.md → figure.json（本地规则解析，加 --ai 才调模型）', cost: '免费' },
    { cmd: 'render <dir>', what: 'figure.json → out/<name>.svg（流程/架构/机制/对比/概念/目录图）', cost: '免费' },
    { cmd: 'chart <dir>', what: 'data/*.csv → 期刊风格图表 SVG（bar/line/scatter/grouped-bar/errorbar）', cost: '免费' },
    { cmd: 'check <dir>', what: '确定性合规检查 → out/check.json + 人话报告', cost: '免费' },
    { cmd: 'check --file <图>', what: '体检任意一张图（PNG/JPEG/TIFF/PDF/SVG/EPS）：能不能投这本刊', cost: '免费' },
    { cmd: 'export <dir>', what: '按期刊规格导出 png/pdf/tif', cost: '免费' },
    { cmd: 'concept <dir>', what: 'AI 概念示意图（gpt-image-2.5-1k）', cost: '约 ¥0.03/张' },
    { cmd: 'review <dir>', what: '多 AI 会审 → out/review.json', cost: '约 ¥0.01–0.07/轮' },
    { cmd: 'wallet', what: '看密钥来源 + 余额（只读）', cost: '免费' },
  ],
  common_flags: {
    '--journal <id>': '覆盖期刊：nature/science/cell/ieee/elsevier/springer/acm/plos/thesis-cn/custom',
    '--width <single|double|毫米>': '覆盖图宽',
    '--height <mm>': '覆盖图高',
    '--out <path>': '指定输出文件（相对工作区）',
    '--quiet': 'stderr 不出进度',
    '--help': '看这份说明',
  },
  examples: [
    'node scripts/fig.mjs init my-paper',
    'node scripts/fig.mjs spec my-paper',
    'node scripts/fig.mjs render my-paper --journal ieee --width single',
    'node scripts/fig.mjs chart my-paper',
  ],
}

// ================================================================ 参数解析

/**
 * 支持 `--flag value` / `--flag=value` / 布尔 `--flag` / 重复位置参数。
 * @returns {{_:string[], flags:Record<string,string|number|boolean>}}
 */
export function parseArgs(argv = []) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--') {
      out._.push(...argv.slice(i + 1).map(String))
      break
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=')
      if (eq > -1) {
        out.flags[a.slice(2, eq)] = coerce(a.slice(eq + 1))
      } else {
        const key = a.slice(2)
        const next = argv[i + 1]
        if (next === undefined || (String(next).startsWith('--') && String(next) !== '--')) {
          out.flags[key] = true
        } else {
          out.flags[key] = coerce(next)
          i++
        }
      }
    } else if (a.startsWith('-') && a.length === 2 && !/^-\d/.test(a)) {
      // 短参数 -j nature
      const key = a.slice(1)
      const next = argv[i + 1]
      if (next === undefined || String(next).startsWith('-')) out.flags[key] = true
      else {
        out.flags[key] = coerce(next)
        i++
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

function coerce(v) {
  const s = String(v)
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d+\.\d+$/.test(s)) return Number(s)
  return s
}

// ================================================================ 输出与日志

let QUIET = false
function log(...parts) {
  if (QUIET) return
  process.stderr.write(`[paper-figure] ${parts.join(' ')}\n`)
}

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    return pkg.version || '1.0.0'
  } catch {
    return '1.0.0'
  }
}

class ModuleNotReady extends Error {
  constructor(name, detail) {
    super(`模块未就绪：scripts/${name}.mjs`)
    this.name = 'ModuleNotReady'
    this.moduleName = name
    this.detail = detail
  }
}

async function loadTool(name, exportName) {
  let mod
  try {
    mod = await import(new URL(`./${name}.mjs`, import.meta.url).href)
  } catch (e) {
    throw new ModuleNotReady(name, e?.message || String(e))
  }
  const fn = mod[exportName]
  if (typeof fn !== 'function') throw new ModuleNotReady(name, `没有导出 ${exportName}()`)
  return mod
}

// ================================================================ 命令

async function cmdInit(args) {
  const { initWorkspace } = await import('./spec.mjs')
  const target = args._[0] || args.flags.dir || '.'
  const dir = resolve(String(target))
  log(`建工作区 ${dir}`)
  const r = initWorkspace(dir, { force: Boolean(args.flags.force) })
  log(`写完 ${r.files.length} 个文件，下一步：node scripts/fig.mjs spec ${target}`)
  return {
    ok: true,
    workDir: r.workDir,
    files: r.files,
    next: [`node scripts/fig.mjs spec ${target}`, `node scripts/fig.mjs render ${target}`],
  }
}

async function cmdSpec(args) {
  const { buildSpec } = await import('./spec.mjs')
  const dir = resolve(args._[0] || '.')
  log(`解析 brief.md → figure.json`)
  const r = await buildSpec(dir, {
    brief: typeof args.flags.brief === 'string' ? args.flags.brief : undefined,
    out: typeof args.flags.out === 'string' ? args.flags.out : undefined,
    ai: Boolean(args.flags.ai),
  })
  for (const w of r.warnings || []) log(`注意：${w.message}${w.fix ? ` → ${w.fix}` : ''}`)
  const nodeCount = (r.spec.panels || []).reduce((s, p) => s + (p.nodes?.length || 0), 0)
  log(`解析完成：${r.spec.type} · ${(r.spec.panels || []).length} 个面板 · ${nodeCount} 个节点`)
  return {
    ok: true,
    specPath: r.specPath,
    name: r.spec.name,
    type: r.spec.type,
    journal: r.spec.journal,
    width: r.spec.width,
    panels: (r.spec.panels || []).length,
    nodes: nodeCount,
    edges: (r.spec.edges || []).length,
    warnings: r.warnings || [],
  }
}

async function cmdRender(args) {
  const { renderFigure } = await import('./render.mjs')
  const dir = resolve(args._[0] || '.')
  log('渲染 SVG…')
  const r = await renderFigure(dir, {
    journal: pickStr(args.flags.journal),
    width: pickWidth(args.flags.width),
    height_mm: pickNum(args.flags.height ?? args.flags.height_mm),
    font_size_pt: pickNum(args.flags['font-size'] ?? args.flags.font_size_pt),
    out: pickStr(args.flags.out),
  })
  for (const w of r.warnings || []) log(`注意：${w.message}${w.fix ? ` → ${w.fix}` : ''}`)
  log(`出图：${r.svgPath}（${r.widthMm}×${r.heightMm}mm）`)
  return {
    ok: true,
    svgPath: r.svgPath,
    widthMm: r.widthMm,
    heightMm: r.heightMm,
    warnings: r.warnings || [],
    next: 'node scripts/fig.mjs check 或 export 走合规检查和导出',
  }
}

async function cmdChart(args) {
  const { renderChart } = await import('./chart.mjs')
  const dir = resolve(args._[0] || '.')
  log('画数据图…')
  const r = await renderChart(dir, {
    journal: pickStr(args.flags.journal),
    width: pickWidth(args.flags.width),
    height_mm: pickNum(args.flags.height ?? args.flags.height_mm),
    out: pickStr(args.flags.out),
  })
  for (const w of r.warnings || []) log(`注意：${w.message}${w.fix ? ` → ${w.fix}` : ''}`)
  log(`出图：${r.svgPath}（${r.widthMm}×${r.heightMm}mm）`)
  return { ok: true, svgPath: r.svgPath, widthMm: r.widthMm, heightMm: r.heightMm, warnings: r.warnings || [], stats: r.stats }
}


/**
 * 找「这次该检查/导出哪张 SVG」：
 *   --svg 指定 > out/<name>-diagram.svg > out/<name>.svg > out/<name>-chart.svg > out/ 里最新的
 * 这样 render/chart 各写各的文件也不会检查错。
 */
function pickSvgPath(dir, flags) {
  if (typeof flags.svg === 'string' && flags.svg) {
    return isAbsolute(flags.svg) ? flags.svg : resolve(dir, flags.svg)
  }
  let name = 'figure'
  try {
    const spec = JSON.parse(readFileSync(join(dir, 'figure.json'), 'utf8'))
    if (spec && typeof spec.name === 'string' && spec.name) name = spec.name
  } catch {
    /* 没有 figure.json 就按默认名找 */
  }
  const outDir = join(dir, 'out')
  for (const cand of [`${name}-diagram.svg`, `${name}.svg`, `${name}-chart.svg`]) {
    const p = join(outDir, cand)
    if (existsSync(p)) return p
  }
  try {
    const files = readdirSync(outDir).filter((f) => f.toLowerCase().endsWith('.svg'))
    let best = null
    for (const f of files) {
      const p = join(outDir, f)
      try {
        const m = statSync(p).mtimeMs
        if (!best || m > best.m) best = { p, m }
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
    return best ? best.p : null
  } catch {
    return null
  }
}

async function cmdCheck(args) {
  // `check --file <路径>`：体检任意一张图（别人的 / 别的工具导的 / AI 出的），不需要工作区
  const fileArg = pickStr(args.flags.file)
  if (fileArg) {
    const mod = await loadTool('check', 'checkFile')
    log(`体检文件 ${fileArg}…`)
    const r = await mod.checkFile(fileArg, {
      journal: pickStr(args.flags.journal),
      toleranceMm: args.flags.tolerance ? Number(args.flags.tolerance) : undefined,
      maxMB: args.flags['max-mb'] ? Number(args.flags['max-mb']) : undefined,
    })
    if (r && typeof r.pass === 'boolean') log(r.pass ? '体检通过（没有必须改的问题）' : '体检没过，下面给出修改建议')
    return r
  }
  const dir = resolve(args._[0] || '.')
  const mod = await loadTool('check', 'checkFigure')
  const svgPath = pickSvgPath(dir, args.flags)
  if (!svgPath) log('out/ 里还没有 SVG，先跑 render 或 chart')
  else log(`检查 ${svgPath}`)
  const r = await mod.checkFigure(dir, {
    journal: pickStr(args.flags.journal),
    export: Boolean(args.flags.export),
    svgPath: svgPath || undefined,
  })
  if (r && typeof r.pass === 'boolean') log(r.pass ? '检查通过' : '检查没过，下面给出修改建议')
  return { ...r, checkedSvg: (r && r.checkedSvg) || svgPath || null }
}

async function cmdExport(args) {
  const dir = resolve(args._[0] || '.')
  const mod = await loadTool('export', 'exportFigure')
  const svgPath = pickSvgPath(dir, args.flags)
  log(svgPath ? `导出 ${svgPath}` : '导出位图…')
  const formats = pickStr(args.flags.formats)
  const r = await mod.exportFigure(dir, {
    formats: formats ? String(formats).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    dpi: pickNum(args.flags.dpi),
    svgPath: svgPath || undefined,
  })
  if (r && Array.isArray(r.files)) log(`导出 ${r.files.length} 个文件`)
  return r
}

async function cmdConcept(args) {
  const dir = resolve(args._[0] || '.')
  const mod = await loadTool('ai', 'generateConcept')
  log('调 AI 出概念图（会花钱，按次计费）…')
  const r = await mod.generateConcept(dir, {
    n: pickNum(args.flags.n) || 2,
    key: pickStr(args.flags.key),
    prompt: pickStr(args.flags.prompt),
  })
  return r
}

async function cmdReview(args) {
  const dir = resolve(args._[0] || '.')
  const mod = await loadTool('ai', 'reviewFigure')
  log('多 AI 会审中（会花钱，按轮计费）…')
  return mod.reviewFigure(dir, {
    tier: pickStr(args.flags.tier) || 'econ',
    vision: Boolean(args.flags.vision),
    models: pickStr(args.flags.models),
    key: pickStr(args.flags.key),
  })
}

async function cmdTemplates(args) {
  const mod = await loadTool('blueprints', 'listBlueprints')
  const list = mod.listBlueprints ? mod.listBlueprints() : mod()
  if (!Array.isArray(list) || !list.length) {
    throw new PFError('没有可用的结构图模板（assets/blueprints/ 是空的）', '重装技能包；或先用 init 建空白工作区。')
  }
  log(`结构图模板 ${list.length} 个：`)
  for (const b of list) log(`  ${b.id}  ${b.title}  （${b.nodes} 个模块，${b.width}）`)
  return { ok: true, templates: list, next: 'node scripts/fig.mjs new <目录> --template <id> [--journal nature]' }
}

async function cmdNew(args) {
  const dir = resolve(args._[0] || '')
  const id = pickStr(args.flags.template)
  if (!args._[0]) {
    throw new PFError('缺目录参数', '用法：node scripts/fig.mjs new ./fig1 --template rag-pipeline')
  }
  if (!id) {
    throw new PFError('缺 --template', '先跑 `node scripts/fig.mjs templates` 看可用的模板 id，再加 --template <id>。')
  }
  const mod = await loadTool('blueprints', 'createWorkspaceFromBlueprint')
  const r = mod.createWorkspaceFromBlueprint(dir, id, {
    journal: pickStr(args.flags.journal),
    width: pickStr(args.flags.width),
    palette: pickStr(args.flags.palette),
    font_size_pt: pickNum(args.flags['font-size']) || pickNum(args.flags.font_size_pt),
    force: Boolean(args.flags.force),
  })
  log(`已从模板 ${id} 建好工作区：${r.dir}`)
  log(`下一步：node scripts/fig.mjs render ${r.dir}`)
  return {
    ok: true,
    dir: r.dir,
    template: id,
    specPath: r.specPath,
    briefPath: r.briefPath,
    nodes: (r.spec.panels || []).reduce((n, p) => n + ((p.nodes || []).length), 0),
    next: [`node scripts/fig.mjs render ${r.dir}`, `node scripts/fig.mjs check ${r.dir}`, `node scripts/fig.mjs export ${r.dir} --formats png,pdf`],
  }
}

async function cmdWallet() {
  const mod = await loadTool('ai', 'walletStatus')
  return mod.walletStatus()
}

function pickStr(v) {
  return typeof v === 'string' && v !== '' ? v : undefined
}
function pickNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
function pickWidth(v) {
  if (v === undefined || v === true) return undefined
  if (typeof v === 'number') return v
  return typeof v === 'string' ? v : undefined
}

// ================================================================ 主流程

const COMMANDS = {
  init: cmdInit,
  templates: cmdTemplates,
  new: cmdNew,
  spec: cmdSpec,
  render: cmdRender,
  chart: cmdChart,
  check: cmdCheck,
  export: cmdExport,
  concept: cmdConcept,
  review: cmdReview,
  wallet: cmdWallet,
}

async function main(argv) {
  const [cmdRaw, ...rest] = argv
  const args = parseArgs(rest)
  QUIET = Boolean(args.flags.quiet)

  if (!cmdRaw || ['help', '--help', '-h'].includes(cmdRaw) || args.flags.help) {
    return { exitCode: 0, payload: { ok: true, ...HELP } }
  }
  if (cmdRaw === 'version' || cmdRaw === '--version' || cmdRaw === '-v') {
    return { exitCode: 0, payload: { ok: true, name: HELP.name, version: HELP.version } }
  }
  const handler = COMMANDS[cmdRaw]
  if (!handler) {
    return {
      exitCode: 1,
      payload: {
        ok: false,
        error: `不认识的命令「${cmdRaw}」`,
        fix: `可用命令：${Object.keys(COMMANDS).join(' / ')}；看详细说明跑 node scripts/fig.mjs --help。`,
      },
    }
  }
  try {
    const result = await handler(args)
    if (result === undefined || result === null) {
      return { ok: false, error: `${cmdRaw} 没有返回结果`, fix: '这是 bug，请把命令贴给维护者。', exitCode: 1 }
    }
    const exitCode = result.ok === false ? Number(result.exitCode) || 1 : 0
    return { exitCode, payload: { ok: true, command: cmdRaw, ...result } }
  } catch (e) {
    if (e instanceof ModuleNotReady) {
      log(`模块未就绪：${e.moduleName}.mjs（${e.detail}）`)
      return {
        exitCode: 2,
        payload: {
          ok: false,
          error: '模块未就绪',
          module: `scripts/${e.moduleName}.mjs`,
          detail: e.detail,
          fix: '先不要把该命令写进示例；等 platform-tools 交付后再接。',
        },
      }
    }
    if (e instanceof PFError) {
      log(`出错：${e.message}`)
      return { exitCode: 1, payload: { ok: false, error: e.message, fix: e.fix || '', code: e.code } }
    }
    log(`出错：${e?.message || e}`)
    return {
      exitCode: 1,
      payload: {
        ok: false,
        error: e?.message || String(e),
        fix: '把这条命令和报错贴给维护者；如果只是参数写错，先跑 node scripts/fig.mjs --help。',
        code: e?.code || 'UNEXPECTED',
      },
    }
  }
}

// 只在被当作脚本执行时跑（被 import 时导出工具函数，方便测试）
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const result = await main(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`)
  process.exit(result.exitCode ?? 0)
}

export { HELP, main, PFError }
