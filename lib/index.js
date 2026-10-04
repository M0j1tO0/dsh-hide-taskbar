/**
 * dsh-plugin-taskbar-autohide —— 宿主半（Cordis 插件）。
 *
 * 目标：DSH 窗口在前台时隐藏 Windows 任务栏，失焦时恢复；随 DSH 生命周期起停。
 *
 * 为什么这么写（相对早先的"计划任务 + 隐藏 powershell 轮询"方案）：
 *   1. 不再依赖计划任务 —— 生命周期直接挂在 DSH 宿主上：DSH 启动即开始，DSH 退出即还原。
 *      早先的方案死在一个没人监管的独立进程上（它被杀后任务栏就永久停在"常显"）。
 *   2. 助手是**事件驱动**的（SetWinEventHook），不是 700ms 抽样，因此不会"刚好错过一次切换"；
 *      并且每次决策都读真实注册表状态再决定写不写，外部改动会被自动纠正。
 *   3. 本插件负责**监管**助手：崩溃/假死（心跳超时）都会自动重启（带退避）。
 *   4. 助手自己也有父进程存活检查：宿主被强杀时它会自行退出并还原任务栏，不留死状态。
 *
 * Cordis 硬约束（踩过的坑，见 README）：apply() 必须返回 undefined，否则会被判为
 * "Invalid effect" 启动失败；对外服务必须走 ctx.provide()。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-plugin-taskbar-autohide'
const SERVICE = 'taskbarAutohide'
const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER = join(HERE, 'taskbar-watch.ps1')

export const DEFAULTS = {
  /** 总开关：false = 插件在跑但不动任务栏（诊断用）。 */
  enabled: true,
  /** DSH 窗口所属进程名；桌面端是 'DeepSeek Harness'。 */
  processNames: ['DeepSeek Harness'],
  /** DSH 失焦时任务栏应有的状态：'visible' = 常显，'autohide' = 自动隐藏。 */
  baseline: 'visible',
  /** 兜底重扫周期（事件之外的保险），毫秒。 */
  resyncMs: 2000,
  /** 助手心跳间隔，毫秒。 */
  heartbeatMs: 5000,
  /** 超过这个时间没有心跳就认为助手假死并重启，毫秒。 */
  staleHeartbeatMs: 30000,
  /** 重启退避。 */
  restartBackoffMs: 2000,
  restartBackoffMaxMs: 30000,
  /** 只记录决策、绝不改任务栏（排查用）。 */
  dryRun: false,
  /** 助手日志大小上限，超过就滚掉重来。 */
  helperLogMaxBytes: 262144,
  /** 状态/日志目录；null = %LOCALAPPDATA%\DshTaskbarAutohide。 */
  stateDir: null,
  /** 助手单实例互斥量名（测试或多宿主机时改成不同的）。 */
  mutexName: 'Local\\DshTaskbarAutohide',
}

function makeLogger(ctx) {
  const logger = ctx && ctx.logger
  /** 插件自己的日志文件（宿主控制台之外的第二落点，便于事后排查）。 */
  let sink = null
  const writeFile = (level, msg) => {
    if (!sink) return
    try {
      if (existsSync(sink) && statSync(sink).size > 262144) rmSync(sink, { force: true })
      appendFileSync(sink, `${new Date().toISOString()}  ${level}  ${msg}\n`, 'utf8')
    } catch {
      /* 文件日志失败绝不影响功能 */
    }
  }
  const emit = (level, msg) => {
    const text = `[${NAME}] ${msg}`
    try {
      if (logger && typeof logger[level] === 'function') logger[level](text)
      else if (logger && typeof logger.info === 'function') logger.info(text)
    } catch {
      /* 日志失败绝不影响功能 */
    }
    writeFile(level, text)
  }
  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    debug: (m) => emit('debug', m),
    attachFile(path) {
      sink = path
    },
  }
}

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) }
  if (!Array.isArray(cfg.processNames)) {
    cfg.processNames = String(cfg.processNames || DEFAULTS.processNames.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  cfg.processNames = cfg.processNames.length ? cfg.processNames : [...DEFAULTS.processNames]
  cfg.baseline = cfg.baseline === 'autohide' || cfg.baseline === 1 || cfg.baseline === true ? 'autohide' : 'visible'
  for (const key of ['resyncMs', 'heartbeatMs', 'staleHeartbeatMs', 'restartBackoffMs', 'restartBackoffMaxMs', 'helperLogMaxBytes']) {
    const n = Number(cfg[key])
    cfg[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULTS[key]
  }
  cfg.enabled = cfg.enabled !== false
  cfg.dryRun = cfg.dryRun === true
  return cfg
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} config
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const log = makeLogger(ctx)

  if (process.platform !== 'win32') {
    log.info('非 Windows 平台，插件空转')
    return undefined
  }
  if (!existsSync(HELPER)) {
    log.warn(`找不到助手脚本，插件不生效：${HELPER}`)
    return undefined
  }

  const deviceRoot = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local')
  const stateDir = typeof cfg.stateDir === 'string' && cfg.stateDir.trim()
    ? cfg.stateDir.trim()
    : join(deviceRoot, 'DshTaskbarAutohide')
  const stateFile = join(stateDir, 'state.conf')
  const helperLog = join(stateDir, 'helper.log')

  try {
    mkdirSync(stateDir, { recursive: true })
  } catch (err) {
    log.warn(`无法创建状态目录 ${stateDir}：${String(err)}`)
  }
  log.attachFile(join(stateDir, 'plugin.log'))

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let disposed = false
  let stopping = false
  let lastHeartbeatAt = 0
  let startedAt = 0
  let restarts = 0
  let nextStartAt = 0
  let stdoutBuf = ''
  let watchdog = null

  function writeState(extra = {}) {
    const lines = [
      `enabled=${cfg.enabled ? 1 : 0}`,
      `baseline=${cfg.baseline === 'autohide' ? 1 : 0}`,
      `names=${cfg.processNames.join(',')}`,
      `shutdown=${extra.shutdown ? 1 : 0}`,
      '',
    ]
    try {
      writeFileSync(stateFile, lines.join('\n'), 'utf8')
      return true
    } catch (err) {
      log.warn(`写状态文件失败：${String(err)}`)
      return false
    }
  }

  function handleLine(line) {
    const text = line.trim()
    if (!text) return
    if (text.startsWith('{')) {
      try {
        const msg = JSON.parse(text)
        if (msg.type === 'heartbeat') {
          lastHeartbeatAt = Date.now()
          return
        }
        if (msg.type === 'state') {
          log.info(`任务栏 auto-hide ${msg.hide ? 'ON' : 'OFF'}（DSH 前台=${msg.focused ? '是' : '否'}）`)
          return
        }
        if (msg.type === 'start') {
          log.info(`助手已启动 pid=${msg.pid}${msg.dryRun ? '（dryRun）' : ''}`)
          return
        }
        if (msg.type === 'decision') {
          log.info(`[dryRun] 决策 auto-hide ${msg.hide ? 'ON' : 'OFF'}（DSH 前台=${msg.focused ? '是' : '否'}）`)
          return
        }
        if (msg.type === 'duplicate') {
          log.warn('已有一个助手实例在运行，本次实例退出（HMR 交接中的正常现象）')
          return
        }
        if (msg.type === 'error') {
          log.warn(`助手报错：${msg.message || 'unknown'}`)
          return
        }
        if (msg.type === 'bye') {
          log.info('助手已退出并还原任务栏状态')
          return
        }
        return
      } catch {
        /* 不是 JSON，按普通输出处理 */
      }
    }
    log.debug(`helper: ${text}`)
  }

  function consumeStdout(chunk) {
    stdoutBuf += chunk
    let idx
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx)
      stdoutBuf = stdoutBuf.slice(idx + 1)
      handleLine(line)
    }
    if (stdoutBuf.length > 8192) stdoutBuf = ''
  }

  function start(reason) {
    if (disposed || stopping || child) return
    if (Date.now() < nextStartAt) return
    writeState()
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', HELPER,
      '-ParentPid', String(process.pid),
      '-StateFile', stateFile,
      '-LogFile', helperLog,
      '-ProcessNames', cfg.processNames.join(','),
      '-ResyncMs', String(cfg.resyncMs),
      '-HeartbeatMs', String(cfg.heartbeatMs),
      '-MutexName', String(cfg.mutexName || DEFAULTS.mutexName),
    ]
    if (cfg.dryRun) args.push('-DryRun')

    try {
      // windowsHide 保证不闪黑框；stdio 管道用于监管与心跳。
      child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      startedAt = Date.now()
      lastHeartbeatAt = Date.now()
      log.info(`启动任务栏助手（${reason}）`)
    } catch (err) {
      child = null
      log.warn(`启动助手失败：${String(err)}`)
      scheduleRestart()
      return
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', consumeStdout)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log.warn(`helper stderr: ${text}`)
    })
    child.on('error', (err) => log.warn(`助手进程错误：${String(err)}`))
    child.on('exit', (code, signal) => {
      const uptime = startedAt ? Date.now() - startedAt : 0
      child = null
      if (stopping || disposed) {
        log.info(`助手已停止（code=${code}${signal ? ` signal=${signal}` : ''}）`)
        return
      }
      restarts += 1
      log.warn(`助手意外退出（code=${code}${signal ? ` signal=${signal}` : ''}，存活 ${Math.round(uptime / 1000)}s），准备重启`)
      scheduleRestart()
    })
  }

  function scheduleRestart() {
    if (disposed || stopping) return
    const backoff = Math.min(cfg.restartBackoffMs * Math.max(1, restarts), cfg.restartBackoffMaxMs)
    nextStartAt = Date.now() + backoff
  }

  function killChild(reason) {
    if (!child) return
    const target = child
    log.info(`结束助手（${reason}）`)
    try {
      target.kill()
    } catch {
      /* 忽略 */
    }
    setTimeout(() => {
      try {
        if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
    }, 2000).unref?.()
  }

  function stop(reason) {
    if (stopping) return
    stopping = true
    disposed = true
    if (watchdog) {
      clearInterval(watchdog)
      watchdog = null
    }
    // 先请求助手自行收尾（它会先把任务栏还原再退出），最多等 2.5s。
    writeState({ shutdown: true })
    const waiter = child
    if (!waiter) return
    const timer = setTimeout(() => killChild(`${reason} 超时强杀`), 2500)
    waiter.once('exit', () => clearTimeout(timer))
  }

  start('插件加载')

  watchdog = setInterval(() => {
    if (disposed || stopping) return
    if (!child) {
      start('助手不在，补启动')
      return
    }
    if (Date.now() - lastHeartbeatAt > cfg.staleHeartbeatMs) {
      log.warn(`助手 ${Math.round((Date.now() - lastHeartbeatAt) / 1000)}s 无心跳，判定假死并重启`)
      lastHeartbeatAt = Date.now()
      killChild('心跳超时')
      scheduleRestart()
    }
  }, Math.max(1000, Math.min(cfg.resyncMs, 5000)))
  watchdog.unref?.()

  // 插件卸载 / HMR：必须把自己起的一切收干净（助手会先还原任务栏）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => stop('插件卸载'))
  } else if (typeof ctx.once === 'function') {
    ctx.once('dispose', () => stop('插件卸载'))
  }

  const api = {
    status() {
      return {
        enabled: cfg.enabled,
        baseline: cfg.baseline,
        dryRun: cfg.dryRun,
        processNames: [...cfg.processNames],
        helperAlive: Boolean(child),
        helperPid: child ? child.pid : null,
        lastHeartbeatAt,
        restarts,
        stateFile,
        helperLog,
      }
    },
    setEnabled(value) {
      cfg.enabled = value !== false
      writeState()
      log.info(`enabled -> ${cfg.enabled}`)
      return cfg.enabled
    },
    setBaseline(value) {
      cfg.baseline = value === 'autohide' ? 'autohide' : 'visible'
      writeState()
      log.info(`baseline -> ${cfg.baseline}`)
      return cfg.baseline
    },
    restart() {
      restarts = 0
      nextStartAt = 0
      killChild('手动重启')
      return true
    },
  }

  try {
    if (typeof ctx.provide === 'function') ctx.provide(SERVICE, api)
  } catch (err) {
    log.warn(`注册 ${SERVICE} 服务失败（功能不受影响）：${String(err)}`)
  }

  log.info(
    `已启用：DSH 前台时隐藏任务栏，失焦恢复「${cfg.baseline === 'autohide' ? '自动隐藏' : '常显'}」` +
      `${cfg.dryRun ? '（dryRun：只记录不改动）' : ''}`,
  )

  return undefined
}

export default { name: NAME, apply }
