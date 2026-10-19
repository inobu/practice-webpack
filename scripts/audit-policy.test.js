const assert = require('node:assert/strict')
const test = require('node:test')
const { evaluateAudit } = require('./audit-policy')
const policy = require('./audit-policy.json')

function advisory(id, severity = 'high') {
  return { severity, url: `https://github.com/advisories/${id}` }
}

function counts(report) {
  const result = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    result[vulnerability.severity]++
    result.total++
  }
  report.metadata = { vulnerabilities: result }
  return report
}

function fixture() {
  const node = (name, severity, via, nodes) => ({ name, severity, via, nodes })
  const report = counts({ vulnerabilities: {
    braces: node('braces', 'high', [advisory('GHSA-vfj7-8cjw-p6xm')], [
      'node_modules/chokidar/node_modules/braces',
      'node_modules/http-proxy-middleware/node_modules/braces'
    ]),
    chokidar: node('chokidar', 'high', ['braces'], ['node_modules/chokidar']),
    micromatch: node('micromatch', 'high', ['braces'], ['node_modules/http-proxy-middleware/node_modules/micromatch']),
    'http-proxy-middleware': node('http-proxy-middleware', 'high', ['micromatch'], ['node_modules/http-proxy-middleware']),
    uuid: node('uuid', 'moderate', [advisory('GHSA-w5hq-g745-h8pq', 'moderate')], ['node_modules/sockjs/node_modules/uuid']),
    sockjs: node('sockjs', 'moderate', ['uuid'], ['node_modules/sockjs']),
    'webpack-dev-server': node('webpack-dev-server', 'high', ['chokidar', 'http-proxy-middleware', 'sockjs'], ['node_modules/webpack-dev-server'])
  } })
  const packages = Object.fromEntries(Object.entries(policy.exceptions[0].allowedNodes).map(([path, version]) => [path, { version, dev: true }]))
  packages['node_modules/sockjs/node_modules/uuid'] = { version: '8.3.2', dev: true }
  packages['node_modules/sockjs'] = { version: '0.3.24', dev: true }
  return { report, lock: { packages }, policy: structuredClone(policy), context: { ...policy.context }, now: new Date('2026-10-19T20:46:13+09:00') }
}

test('excepts only the reviewed development advisory and its parent propagation', () => {
  const result = evaluateAudit(fixture())
  assert.equal(result.passed, true)
  assert.equal(result.counts.high, 5)
  assert.equal(result.counts.moderate, 2)
  assert.equal(result.exceptions.length, 1)
  assert.equal(result.exceptions[0].advisory, 'GHSA-vfj7-8cjw-p6xm')
  assert.equal(result.exceptions[0].packages.length, 5)
})

test('blocks a new High advisory in an otherwise approved package', () => {
  const data = fixture()
  data.report.vulnerabilities.braces.via.push(advisory('GHSA-aaaa-bbbb-cccc'))
  const result = evaluateAudit(data)
  assert.equal(result.passed, false)
  assert(result.blocked.some((entry) => entry.advisory === 'GHSA-aaaa-bbbb-cccc'))
})

test('blocks a new High dependency outside the reviewed graph', () => {
  const data = fixture()
  data.report.vulnerabilities.newdep = { name: 'newdep', severity: 'high', nodes: ['node_modules/newdep'], via: [advisory('GHSA-aaaa-bbbb-cccc')] }
  data.lock.packages['node_modules/newdep'] = { version: '1.0.0', dev: true }
  counts(data.report)
  assert.equal(evaluateAudit(data).passed, false)
})

test('never excepts Critical severity, including the known advisory ID', () => {
  const data = fixture()
  for (const value of Object.values(data.report.vulnerabilities)) {
    if (value.severity === 'high') value.severity = 'critical'
  }
  data.report.vulnerabilities.braces.via[0].severity = 'critical'
  counts(data.report)
  const result = evaluateAudit(data)
  assert.equal(result.passed, false)
  assert.equal(result.exceptions.length, 0)
})

test('blocks an exception if an affected node becomes a production dependency', () => {
  const data = fixture()
  delete data.lock.packages['node_modules/chokidar/node_modules/braces'].dev
  assert.equal(evaluateAudit(data).passed, false)
})

test('blocks an unreviewed dependency path', () => {
  const data = fixture()
  data.report.vulnerabilities.braces.nodes.push('node_modules/other/node_modules/braces')
  data.lock.packages['node_modules/other/node_modules/braces'] = { version: '3.0.3', dev: true }
  assert.equal(evaluateAudit(data).passed, false)
})

test('blocks a different dependency version', () => {
  const data = fixture()
  data.lock.packages['node_modules/chokidar/node_modules/braces'].version = '3.0.2'
  assert.equal(evaluateAudit(data).passed, false)
})

test('the original deadline still fails closed at October 21 midnight', () => {
  const data = fixture()
  data.policy.exceptions[0].expiresAt = '2026-10-21T00:00:00+09:00'
  data.now = new Date('2026-10-20T23:59:59.999+09:00')
  assert.equal(evaluateAudit(data).passed, true)
  data.now = new Date('2026-10-21T00:00:00+09:00')
  const result = evaluateAudit(data)
  assert.equal(result.passed, false)
  assert(result.blocked.every((entry) => entry.reason.includes('expired')))
})

test('the reviewed seven-day extension expires exactly at October 28 midnight JST', () => {
  const data = fixture()
  assert.equal(data.policy.exceptions[0].expiresAt, '2026-10-28T00:00:00+09:00')
  data.now = new Date('2026-10-27T23:59:59.999+09:00')
  assert.equal(evaluateAudit(data).passed, true)
  data.now = new Date('2026-10-27T15:00:00Z')
  const result = evaluateAudit(data)
  assert.equal(result.passed, false)
  assert.equal(result.exceptions.length, 0)
  assert(result.blocked.every((entry) => entry.reason.includes('expired')))
})

test('passes after remediation even if an unused exception has expired', () => {
  const data = fixture()
  data.report = counts({ vulnerabilities: {} })
  data.now = new Date('2026-10-28T00:00:00+09:00')
  const result = evaluateAudit(data)
  assert.equal(result.passed, true)
  assert.equal(result.exceptions.length, 0)
})

test('requires review after the webpack configuration changes', () => {
  const data = fixture()
  data.context.webpackConfigSha256 = 'changed'
  assert.equal(evaluateAudit(data).passed, false)
})

test('requires review if the start command exposes the server', () => {
  const data = fixture()
  data.context.startScript += ' --host 0.0.0.0'
  assert.equal(evaluateAudit(data).passed, false)
})

test('fails on npm audit service errors and malformed output', () => {
  const data = fixture()
  assert.throws(() => evaluateAudit({ ...data, report: { error: { code: 'E503' } } }), /complete/)
  assert.throws(() => evaluateAudit({ ...data, report: {} }), /complete/)
})

test('fails if vulnerability counts omit findings', () => {
  const data = fixture()
  data.report.metadata.vulnerabilities.high = 0
  assert.throws(() => evaluateAudit(data), /count does not match/)
})

test('fails if a parent points to a missing root advisory', () => {
  const data = fixture()
  data.report.vulnerabilities['webpack-dev-server'].via.push('missing')
  assert.throws(() => evaluateAudit(data), /Missing audit dependency/)
})

test('fails on cycles in the audit dependency graph', () => {
  const data = fixture()
  data.report.vulnerabilities.braces.via.push('chokidar')
  assert.throws(() => evaluateAudit(data), /Cyclic audit dependency/)
})

test('blocks a High parent with no root advisory', () => {
  const data = fixture()
  data.report.vulnerabilities.braces.via = []
  assert.equal(evaluateAudit(data).passed, false)
})

test('does not broaden an exception to another package with the same advisory ID', () => {
  const data = fixture()
  data.report.vulnerabilities.newdep = { name: 'newdep', severity: 'high', nodes: ['node_modules/newdep'], via: [advisory('GHSA-vfj7-8cjw-p6xm')] }
  counts(data.report)
  assert.equal(evaluateAudit(data).passed, false)
})

test('rejects an invalid exception deadline', () => {
  const data = fixture()
  data.policy.exceptions[0].expiresAt = 'invalid'
  assert.throws(() => evaluateAudit(data), /Invalid or duplicate audit exception/)
})
