#!/usr/bin/env node
/**
 * tests/cn-journals.mjs —— 中文期刊/学位论文规则（v1.3）离线回归
 *
 * 覆盖：
 *   - cn-core / thesis-cn 预置存在，且 capiton/cjk_fonts 透传到 check
 *   - 图注缺失 / 编号风格不符 / 缺英文图注 都是 **warn**（因为规格待核，不许判死）
 *   - JOURNAL_PRESET_UNVERIFIED 必须出现
 * 不联网、不花钱。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const { checkFigure, resolvePreset } = await import(join(ROOT, 'scripts', 'check.mjs'))
const { createWorkspaceFromBlueprint } = await import(join(ROOT, 'scripts', 'blueprints.mjs'))
const { renderFigure } = await import(join(ROOT, 'scripts', 'render.mjs'))

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${name}${extra ? `  —— ${extra}` : ''}`) } else { fail += 1; console.log(`FAIL  ${name}${extra ? `  —— ${extra}` : ''}`) }
}
const codes = (r) => (r.issues || []).map((i) => i.code)
const levelOf = (r, code) => ((r.issues || []).find((i) => i.code === code) || {}).level

for (const id of ['cn-core', 'thesis-cn']) {
  const { preset } = await resolvePreset(id)
  ok(`${id}：预置存在且标「待核」`, Boolean(preset && preset.id === id) && preset.verified === '待核', preset && preset.label)
  ok(`${id}：透传 caption 与 cjk_fonts`, Boolean(preset.caption && preset.cjk_fonts && preset.cjk_fonts.length), preset && preset.caption && preset.caption.example)
}

const tmp = mkdtempSync(join(tmpdir(), 'pf-cn-'))
const dir = join(tmp, 'fig')
createWorkspaceFromBlueprint(dir, 'transformer-block', { journal: 'thesis-cn' })
await renderFigure(dir)

const specPath = join(dir, 'figure.json')
const baseSpec = JSON.parse(readFileSync(specPath, 'utf8'))

async function checkWith(patch) {
  writeFileSync(specPath, JSON.stringify({ ...baseSpec, ...patch }, null, 2))
  return checkFigure(dir, { write: false })
}

// 1) 符合「图 章-号」且有英文图注：不该报图注类 warn
let r = await checkWith({ caption: '图 3-1  方法总体框架', caption_en: 'Figure 3-1. Overview of the proposed method.' })
ok('图注合规时不报 CAPTION_*', !codes(r).some((c) => c.startsWith('CAPTION_')), codes(r).join(','))

// 2) 缺英文图注
r = await checkWith({ caption: '图 3-1  方法总体框架', caption_en: '' })
ok('缺英文图注 → CAPTION_BILINGUAL_MISSING', codes(r).includes('CAPTION_BILINGUAL_MISSING'))
ok('缺英文图注只是 warn，不是 error', levelOf(r, 'CAPTION_BILINGUAL_MISSING') === 'warn')

// 3) 编号风格不符（没写章号）
r = await checkWith({ caption: '方法总体框架', caption_en: 'Figure 3-1. Overview.' })
ok('编号风格不符 → CAPTION_NUMBER_STYLE', codes(r).includes('CAPTION_NUMBER_STYLE'))
ok('编号风格只是 warn', levelOf(r, 'CAPTION_NUMBER_STYLE') === 'warn')

// 4) 完全没图注
r = await checkWith({ caption: '', caption_en: '' })
ok('没图注 → CAPTION_MISSING', codes(r).includes('CAPTION_MISSING'))

// 5) 待核提示必须在
ok('必有 JOURNAL_PRESET_UNVERIFIED 提示', codes(r).includes('JOURNAL_PRESET_UNVERIFIED'))

// 6) 英文刊（nature）不该被中文规则误伤
const dir2 = join(tmp, 'fig-en')
createWorkspaceFromBlueprint(dir2, 'transformer-block', { journal: 'nature' })
await renderFigure(dir2)
const en = await checkFigure(dir2, { write: false })
ok('nature 不触发中文图注规则', !codes(en).some((c) => c.startsWith('CAPTION_')), codes(en).join(','))

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
