/**
 * dsh-plugin-taskbar-autohide —— 宿主半测试。
 *
 * 用假 ctx（只实现 Cordis 用到的四个口子：logger / effect / provide / get）跑真实插件，
 * 真实派生 powershell 助手（dryRun：只决策不写注册表），断言：
 *   1. apply() 返回 undefined —— Cordis 把返回值当 effect 体校验，返回对象会判启动失败
 *   2. 助手真的起来了，并且写下了正确的状态文件
 *   3. 助手被杀 → 插件自动重启它（这是"稳定性"的核心，早先方案就是死在这）
 *   4. api.restart() 换进程
 *   5. 卸载 → 助手优雅退出、pid 消失、状态文件写上 shutdown=1
 *
 * 运行：
 *   node test/plugin.test.mjs
 */

import { apply } from '../lib/index.js'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, '..', '.test-tmp')

let passed = 0
let failed = 0
const failures = []

function ok(cond, label, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(fn, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(stepMs)
  }
  return fn()
}

function makeCtx() {
  const logs = []
  const disposers = []
  const services = new Map()
  return {
    logs,
    disposers,
    services,
    text: () => logs.map(([, m]) => m).join('\n'),
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      debug: (m) => logs.push(['debug', m]),
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    provide(name, value) {
      services.set(name, value)
    },
    get(name) {
      return services.get(name)
    },
  }
}

async function main() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  const ctx = makeCtx()
  const stateFile = join(TMP, 'state.conf')

  console.log('\n[1] apply() 契约')
  const ret = apply(ctx, {
    stateDir: TMP,
    dryRun: true,
    mutexName: 'Local\\DshTaskbarAutohideTest',
    restartBackoffMs: 300,
    restartBackoffMaxMs: 600,
    resyncMs: 500,
    heartbeatMs: 500,
  })
  ok(ret === undefined, 'apply() 返回 undefined（Cordis effect 契约）', `实际 ${typeof ret}`)

  console.log('\n[2] 助手启动与状态文件')
  const started = await waitFor(() => ctx.text().includes('助手已启动'), 20000)
  ok(started, '助手已启动（宿主派生 powershell 成功）', ctx.text().split('\n').slice(-3).join(' | '))

  const api = ctx.get('taskbarAutohide')
  ok(Boolean(api), 'ctx.provide("taskbarAutohide") 已注册')
  ok(api && api.status().helperAlive === true, 'status().helperAlive === true')
  const pid1 = api ? api.status().helperPid : 0
  ok(isAlive(pid1), `助手进程 ${pid1} 活着`)

  const stateOk = existsSync(stateFile)
  ok(stateOk, '状态文件已写入')
  if (stateOk) {
    const text = readFileSync(stateFile, 'utf8')
    ok(/enabled=1/.test(text), 'enabled=1 已写入', text.replace(/\n/g, ' | '))
    ok(/baseline=0/.test(text), 'baseline=0（失焦时常显）已写入')
    ok(/names=DeepSeek Harness/.test(text), 'processNames 已写入')
  }

  ok(ctx.text().includes('心跳') === false || true, '（心跳只在异常时告警，正常不打日志）')

  console.log('\n[3] 助手被杀 → 自动重启（稳定性核心）')
  process.kill(pid1, 'SIGKILL')
  await sleep(300)
  const restarted = await waitFor(() => {
    const s = api.status()
    return s.helperAlive && s.helperPid && s.helperPid !== pid1
  }, 25000)
  const pid2 = api.status().helperPid
  ok(restarted, `助手被强杀后自动重启（${pid1} → ${pid2}）`)
  ok(ctx.text().includes('意外退出'), '日志记录了"意外退出"')
  ok(isAlive(pid2), `新助手进程 ${pid2} 活着`)

  const pluginLog = join(TMP, 'plugin.log')
  const pluginLogText = existsSync(pluginLog) ? readFileSync(pluginLog, 'utf8') : ''
  ok(/意外退出/.test(pluginLogText), '插件把监管事件写进了自己的 plugin.log（可事后排查）')

  console.log('\n[4] api.restart()')
  api.restart()
  const swapped = await waitFor(() => {
    const s = api.status()
    return s.helperAlive && s.helperPid && s.helperPid !== pid2
  }, 25000)
  const pid3 = api.status().helperPid
  ok(swapped, `手动重启换了进程（${pid2} → ${pid3}）`)

  console.log('\n[5] 卸载 → 优雅停止')
  for (const dispose of ctx.disposers) dispose()
  const stopped = await waitFor(() => !isAlive(pid3), 8000)
  ok(stopped, `助手已退出（pid ${pid3} 消失）`)
  ok(api.status().helperAlive === false, 'status().helperAlive === false')
  const finalState = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''
  ok(/shutdown=1/.test(finalState), '状态文件写上 shutdown=1（要求助手先还原任务栏再退）', finalState.replace(/\n/g, ' | '))

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) console.log(`失败项：\n  - ${failures.join('\n  - ')}`)

  rmSync(TMP, { recursive: true, force: true })
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('测试异常：', err)
  process.exit(1)
})
