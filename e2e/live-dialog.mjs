#!/usr/bin/env node
/**
 * Live check with the REAL Codex CLI: two interactive-style sessions (as a person would run
 * them) talk through an isolated bus. Costs model tokens and takes minutes, so it is a script,
 * not a vitest case.
 *
 *   node e2e/live-dialog.mjs cpu       # tita on duty; pipa's user asks for tita's CPU usage
 *   node e2e/live-dialog.mjs crossed   # both users ask at once (pipa→tita CPU, tita→pipa RAM)
 *
 * Needs: codex on PATH with a working provider (the user's ~/.codex/config.toml + auth are
 * copied into an isolated CODEX_HOME; API keys stay in the environment), packages built.
 * Flags: --keep (leave the temp root), --model <m>, --effort <low|medium|high>.
 */
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(here, '../packages/cli/dist/bin.js')
const args = process.argv.slice(2)
const scenario = args.find((a) => !a.startsWith('--')) ?? 'cpu'
const keep = args.includes('--keep')
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const model = opt('--model')
const effort = opt('--effort')
const win = process.platform === 'win32'

const root = mkdtempSync(join(tmpdir(), 'agentbus-live-'))
for (const d of ['data', 'codex-home', 'claude-config', 'agentbus-home', 'pipa', 'tita'])
  mkdirSync(join(root, d))
// isolated Codex home: same provider/model config and auth, none of the user's hooks/skills
for (const f of ['config.toml', 'auth.json']) {
  const src = join(homedir(), '.codex', f)
  if (existsSync(src)) copyFileSync(src, join(root, 'codex-home', f))
}
const env = {
  ...process.env,
  CODEX_HOME: join(root, 'codex-home'),
  CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
  AGENTBUS_HOME: join(root, 'agentbus-home'),
}
const log = (s) => process.stderr.write(`[live] ${s}\n`)
log(`root ${root}`)

// ---- helpers
function run(cmd, cmdArgs, { cwd, timeoutMs = 120_000, outFile } = {}) {
  return new Promise((res, rej) => {
    const q = (a) => (win && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
    const p = win
      ? spawn([cmd, ...cmdArgs].map(q).join(' '), {
          cwd,
          env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(cmd, cmdArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    // codex exec prints the transcript on stderr and only the final message on stdout: keep both
    const dump = () =>
      outFile &&
      writeFileSync(
        outFile,
        `${out}
--- stderr ---
${err}`,
      )
    p.stdout.on('data', (d) => {
      out += d
      dump()
    })
    p.stderr.on('data', (d) => {
      err += d
      dump()
    })
    const t = setTimeout(() => {
      kill(p)
      rej(new Error(`timeout: ${cmd} ${cmdArgs.join(' ')}\n${out}\n${err}`))
    }, timeoutMs)
    p.on('exit', (code) => {
      clearTimeout(t)
      code === 0
        ? res({ out, err })
        : rej(new Error(`exit ${code}: ${cmd} ${cmdArgs.join(' ')}\n${out}\n${err}`))
    })
  })
}
function kill(p) {
  if (win) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
  else p.kill('SIGKILL')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const agentbus = (a, o) => run(process.execPath, [CLI_BIN, ...a], o)

// ---- bus
const serve = spawn(
  process.execPath,
  [CLI_BIN, 'serve', '--port', '0', '--data-dir', join(root, 'data')],
  {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let serveLog = ''
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`serve did not start:\n${serveLog}`)), 20_000)
  serve.stderr.on('data', (d) => {
    serveLog += d
    const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)\/ws/.exec(serveLog)
    if (m) {
      clearTimeout(t)
      res(Number(m[1]))
    }
  })
})
const bus = `ws://127.0.0.1:${port}/ws`
const http = `http://127.0.0.1:${port}`
log(`bus ${bus}`)

try {
  // ---- skill + join, like a person would
  await agentbus([
    'install-skill',
    '--codex-dir',
    env.CODEX_HOME,
    '--claude-dir',
    env.CLAUDE_CONFIG_DIR,
  ])
  for (const name of ['pipa', 'tita']) {
    const r = await agentbus([
      'join',
      '--codex',
      '--dir',
      join(root, name),
      '--bus',
      bus,
      '--data-dir',
      join(root, 'data'),
    ])
    log(r.out.trim().split('\n').pop())
  }

  // ---- codex sessions
  const codexArgs = (dir, prompt) => [
    'exec',
    '-C',
    dir,
    '--skip-git-repo-check',
    '--dangerously-bypass-hook-trust',
    '-o',
    join(root, `${dir.split(/[\\/]/).pop()}.last`),
    ...(model ? ['-m', model] : []),
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    prompt,
  ]
  const codex = (name, prompt, timeoutMs) =>
    run('codex', codexArgs(join(root, name), prompt), {
      cwd: join(root, name),
      timeoutMs,
      outFile: join(root, `${name}.out`),
    })
  const last = (name) =>
    existsSync(join(root, `${name}.last`)) ? readFileSync(join(root, `${name}.last`), 'utf8') : ''

  const t0 = Date.now()
  let results
  if (scenario === 'cpu') {
    // tita on duty (a long-running turn), pipa's user asks about tita's machine
    const duty = spawnCodex('tita', '值班')
    await sleep(30_000)
    log('pipa asks')
    const a = await codex('pipa', '问 tita 它电脑的 CPU 使用率是多少', 300_000).catch((e) => ({
      err: String(e),
    }))
    kill(duty)
    results = { pipa: last('pipa'), tita: readFileSync(join(root, 'tita.out'), 'utf8') }
    void a
  } else if (scenario === 'crossed') {
    // the user's real case: each session gets a question about the OTHER machine at the same time
    const pA = codex('pipa', 'tita 你电脑的 CPU 使用率是多少', 300_000).catch((e) => ({
      err: String(e),
    }))
    await sleep(8_000)
    const pB = codex('tita', 'pipa 你电脑的内存使用率是多少', 300_000).catch((e) => ({
      err: String(e),
    }))
    await Promise.all([pA, pB])
    results = { pipa: last('pipa'), tita: last('tita') }
  } else throw new Error(`unknown scenario ${scenario}`)
  log(`sessions done in ${Math.round((Date.now() - t0) / 1000)}s`)

  // ---- what went over the bus
  const owner = readFileSync(join(root, 'data', 'owner.token'), 'utf8').trim()
  const r = await fetch(
    `${http}/api/console/rooms/${encodeURIComponent('dm:pipa|tita')}/messages`,
    {
      headers: { authorization: `Bearer ${owner}`, 'x-agentbus-name': 'owner' },
    },
  )
  const { messages } = r.ok ? await r.json() : { messages: [] }
  console.log('\n=== bus: dm pipa|tita ===')
  for (const m of messages) console.log(`#${m.id} ${m.from}: ${m.text}`)
  console.log('\n=== pipa final answer ===\n' + results.pipa.trim())
  console.log(
    '\n=== tita final answer / transcript tail ===\n' +
      results.tita.trim().split('\n').slice(-15).join('\n'),
  )

  const pct = /\d+(\.\d+)?\s*%/
  const from = (who) => messages.filter((m) => m.from === who)
  const checks = {
    'tita answered on the bus with a number': from('tita').some((m) => pct.test(m.text)),
    'pipa got the number into its final answer': pct.test(results.pipa),
    'nobody wrote "用户问"': !messages.some((m) => /用户问|用户再次问|再次确认/.test(m.text)),
  }
  if (scenario === 'crossed') {
    // tita's user asked about pipa's memory: tita must ask pipa, pipa must answer with a number,
    // and tita must hand that number (not its own) to its user
    checks['tita asked pipa about memory on the bus'] = from('tita').some((m) =>
      /内存|memory|RAM/i.test(m.text),
    )
    checks['pipa answered memory with a number'] = from('pipa').some(
      (m) => /内存|memory|RAM|GB/i.test(m.text) && pct.test(m.text),
    )
    checks["tita's final answer carries pipa's number"] =
      /内存|memory|RAM/i.test(results.tita) && pct.test(results.tita)
  }
  console.log('\n=== checks ===')
  let ok = true
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`)
    ok &&= v
  }
  console.log(ok ? '\nLIVE PASS' : '\nLIVE FAIL')
  process.exitCode = ok ? 0 : 1

  function spawnCodex(name, prompt) {
    const q = (a) => (win && /[\s"]/.test(a) ? `"${a}"` : a)
    const a = codexArgs(join(root, name), prompt)
    const p = win
      ? spawn(['codex', ...a].map(q).join(' '), {
          cwd: join(root, name),
          env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('codex', a, { cwd: join(root, name), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => {
      out += d
      writeFileSync(join(root, `${name}.out`), out)
    })
    p.stderr.on('data', (d) => {
      out += d
      writeFileSync(join(root, `${name}.out`), out)
    })
    return p
  }
} finally {
  serve.kill()
  await sleep(500)
  if (keep) log(`kept ${root}`)
  else
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      log(`could not remove ${root}`)
    }
}
