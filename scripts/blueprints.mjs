/**
 * scripts/blueprints.mjs —— 结构图模板包（v1.2）
 *
 * 论文里 80% 的结构图都长成那几种：Transformer 块、编码器-解码器、CNN、GNN 消息传递、
 * RAG 流水线、Agent 架构、训练流程、注意力、消融对比。每种的**正确读法**是固定的，
 * 但每年都有几十万人在 PPT 里从零拼一遍。
 *
 * 这里把它们做成 blueprint（就是一份 figure.json），一条命令铺到工作区，
 * 改字改模块名就行，排版/字号/栏宽/箭头由 render 负责。
 *
 * 接口：
 *   listBlueprints() -> [{id, title, type, width, nodes, hint}]
 *   loadBlueprint(id) -> spec 对象
 *   createWorkspaceFromBlueprint(dir, id, opts) -> {dir, specPath, spec, briefPath}
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIR = join(ROOT, 'assets', 'blueprints')

const TITLES = {
  'transformer-block': 'Transformer 编码层',
  'encoder-decoder': '编码器—解码器（seq2seq）',
  'cnn-classifier': 'CNN 分类器',
  'rag-pipeline': 'RAG 检索增强生成',
  'agent-architecture': 'Agent 总体架构',
  'gnn-message-passing': 'GNN 消息传递',
  'training-pipeline': '训练与评测流程',
  'attention-qkv': '缩放点积注意力（Q/K/V）',
  'ablation-comparison': '消融实验三联对比',
}

function read(id) {
  const p = join(DIR, `${id}.json`)
  if (!existsSync(p)) {
    const e = new Error(`没有这个模板：${id}`)
    e.code = 'BLUEPRINT_NOT_FOUND'
    e.fix = `可用模板：${listBlueprints().map((b) => b.id).join(' / ')}`
    throw e
  }
  return JSON.parse(readFileSync(p, 'utf8'))
}

export function listBlueprints() {
  if (!existsSync(DIR)) return []
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
    .map((id) => {
      const spec = read(id)
      const nodes = (spec.panels || []).reduce((s, p) => s + ((p.nodes || []).length), 0)
      return {
        id,
        title: TITLES[id] || spec.name || id,
        type: spec.type || 'pipeline',
        width: spec.width || 'double',
        nodes,
        hint: spec.notes || '',
      }
    })
}

export function loadBlueprint(id) {
  const spec = read(String(id))
  return JSON.parse(JSON.stringify(spec))
}

/**
 * 把模板铺成一个工作区（figure.json + brief.md + data/ + out/）。
 * @param {string} dir 目标目录
 * @param {string} id 模板 id
 * @param {object} opts { journal, width, palette, font_size_pt, force }
 */
export function createWorkspaceFromBlueprint(dir, id, opts = {}) {
  const abs = resolve(dir)
  const spec = loadBlueprint(id)

  if (opts.journal) spec.journal = String(opts.journal)
  if (opts.width) spec.width = String(opts.width)
  if (opts.palette) spec.palette = String(opts.palette)
  if (opts.font_size_pt) spec.font_size_pt = Number(opts.font_size_pt)

  mkdirSync(join(abs, 'out'), { recursive: true })
  mkdirSync(join(abs, 'data'), { recursive: true })

  const specPath = join(abs, 'figure.json')
  if (existsSync(specPath) && !opts.force) {
    const e = new Error(`${specPath} 已经存在`)
    e.code = 'WORKSPACE_EXISTS'
    e.fix = '换一个目录，或者加 --force 覆盖（会丢掉你已改的 figure.json）'
    throw e
  }
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8')

  const briefPath = join(abs, 'brief.md')
  const nodeList = (spec.panels || [])
    .flatMap((p) => (p.nodes || []).map((n) => `- \`${n.id}\` ${n.label}${n.sub ? `（${n.sub}）` : ''}`))
    .join('\n')
  const brief = `# ${TITLES[id] || id}（${id}）

> 模板生成于 paper-figure v1.2。改字改模块名就可以重出图，排版（字号/栏宽/箭头/留白）由 render 负责。

## 这张图要说什么

${spec.caption || '（补一句图注，说明这张图支撑正文哪一句话）'}

## 现在有哪些模块

${nodeList || '（空）'}

## 改哪里

1. 改 \`figure.json\` 里 \`panels[].nodes\` 的 \`label\` / \`sub\`（模块名、维度、层数都写在 sub）
2. 增删模块后跑 \`render\` 会自动重新分层排版，别手调坐标
3. 换刊改 \`figure.json\` 的 \`journal\`（nature / ieee / elsevier …）
4. 出图顺序：\`render\` → \`check\` → \`export\`

## 模板作者备注

${spec.notes || ''}
`
  writeFileSync(briefPath, brief, 'utf8')

  if (spec.type === 'chart' && spec.data && spec.data.file) {
    const csvPath = join(abs, 'data', spec.data.file.replace(/^data\//, ''))
    if (!existsSync(csvPath)) {
      writeFileSync(csvPath, 'group,value,error\nBaseline,71.2,1.4\nOurs,77.5,1.1\n', 'utf8')
    }
  }

  return { dir: abs, specPath, spec, briefPath }
}

export default { listBlueprints, loadBlueprint, createWorkspaceFromBlueprint }
