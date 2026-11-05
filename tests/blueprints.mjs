#!/usr/bin/env node
/**
 * tests/blueprints.mjs —— 结构图模板包（v1.2）离线回归
 *
 * 对每个模板：建工作区 → render → check（按模板自带期刊），要求：
 *   - SVG 生成成功，宽度不超过目标期刊双栏宽
 *   - 检查通过（没有 error；warn 允许）
 *   - 节点 id 唯一、至少 3 个节点、每个模板都有 caption 和 notes
 * 不联网、不花钱。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const { listBlueprints, loadBlueprint, createWorkspaceFromBlueprint } = await import(join(ROOT, 'scripts', 'blueprints.mjs'))
const { renderFigure } = await import(join(ROOT, 'scripts', 'render.mjs'))
const { checkFigure } = await import(join(ROOT, 'scripts', 'check.mjs'))
const { resolvePreset } = await import(join(ROOT, 'scripts', 'check.mjs'))

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${name}${extra ? `  —— ${extra}` : ''}`) } else { fail += 1; console.log(`FAIL  ${name}${extra ? `  —— ${extra}` : ''}`) }
}

const list = listBlueprints()
ok('模板数量 ≥ 8', list.length >= 8, `${list.length} 个`)

const tmp = mkdtempSync(join(tmpdir(), 'pf-blueprints-'))

for (const meta of list) {
  const id = meta.id
  let spec
  try {
    spec = loadBlueprint(id)
  } catch (e) {
    fail += 1
    console.log(`FAIL  ${id}：读不出来 ${e.message}`)
    continue
  }

  const nodeIds = (spec.panels || []).flatMap((p) => (p.nodes || []).map((n) => n.id))
  const unique = new Set(nodeIds)
  ok(`${id}：节点 id 唯一且 ≥3`, unique.size === nodeIds.length && nodeIds.length >= 3, `${nodeIds.length} 个节点`)

  const edgeIds = (spec.panels || []).flatMap((p) => p.edges || [])
  const dangling = edgeIds.filter((e) => !unique.has(e.from) || !unique.has(e.to))
  ok(`${id}：没有悬空边`, dangling.length === 0, dangling.length ? JSON.stringify(dangling[0]) : 'ok')

  ok(`${id}：有 caption 和 notes`, Boolean(spec.caption && spec.caption.length > 10 && spec.notes && spec.notes.length > 5))

  const dir = join(tmp, id)
  try {
    createWorkspaceFromBlueprint(dir, id)
    const r = await renderFigure(dir)
    ok(`${id}：render 出 SVG`, Boolean(r && r.ok && r.svgPath), `${r.widthMm}×${r.heightMm}mm`)

    const preset = await resolvePreset(spec.journal || 'custom')
    const p = preset.preset || preset
    const maxW = Number(p.double_mm) || 183
    ok(`${id}：宽度不超过双栏 ${maxW}mm`, Number(r.widthMm) <= maxW + 0.8, `${r.widthMm}mm`)
    ok(`${id}：渲染无 warning`, !(r.warnings && r.warnings.length), (r.warnings || []).join('; ').slice(0, 120))

    const c = await checkFigure(dir, { journal: spec.journal || 'custom', write: false })
    const errs = (c.issues || []).filter((i) => i.level === 'error')
    ok(`${id}：check 无 error`, errs.length === 0, errs.map((e) => e.code).join(',') || 'ok')
  } catch (e) {
    fail += 1
    console.log(`FAIL  ${id}：建/渲染/检查过程中抛错 —— ${e && e.message ? e.message : e}`)
  }
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
