const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { evaluateAudit } = require('./audit-policy')

function main() {
  const root = path.resolve(__dirname, '..')
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('Run this check with npm run audit:ci')

  const audit = spawnSync(process.execPath, [npmCli, 'audit', '--json', '--audit-level=high'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024
  })
  fs.writeFileSync(path.join(root, 'audit-report.json'), audit.stdout || '')
  if (audit.stderr) process.stderr.write(audit.stderr)
  if (audit.error) throw audit.error
  if (![0, 1].includes(audit.status)) throw new Error(`npm audit failed with status ${audit.status}`)

  const report = JSON.parse(audit.stdout)
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
  const manifest = readJson('package.json')
  const result = evaluateAudit({
    report,
    lock: readJson('package-lock.json'),
    policy: readJson('scripts/audit-policy.json'),
    context: {
      webpackConfigSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'webpack.config.js'))).digest('hex'),
      startScript: manifest.scripts.start
    }
  })
  const expectedStatus = result.counts.high + result.counts.critical > 0 ? 1 : 0
  if (audit.status !== expectedStatus) throw new Error('npm audit exit status does not match its report')

  console.log(`Full npm audit: ${result.counts.critical} Critical, ${result.counts.high} High, ${result.counts.moderate} Moderate`)
  for (const exception of result.exceptions) {
    const message = `${exception.advisory} remains present in development dependencies (${exception.packages.join(', ')}); exception expires at ${exception.expiresAt}`
    console.warn(message)
    if (process.env.GITHUB_ACTIONS === 'true') {
      const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
      console.log(`::warning title=Temporary audit exception::${escaped}`)
    }
  }
  for (const failure of result.blocked) {
    console.error(`Blocked ${failure.package}${failure.advisory ? ` (${failure.advisory})` : ''}: ${failure.reason}`)
  }
  console.log('Unfiltered audit JSON: audit-report.json')
  if (!result.passed) process.exitCode = 1
  else console.log('Audit policy passed; no unexcepted High or Critical vulnerabilities')
}

try {
  main()
} catch (error) {
  console.error(`Audit check failed: ${error.message}`)
  process.exitCode = 1
}
