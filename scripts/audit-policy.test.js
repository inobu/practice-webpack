const assert = require('node:assert/strict')
const test = require('node:test')
const { evaluateAudit } = require('./audit-policy')
const activePolicy = require('./audit-policy.json')
// Historical fixture tests the old bounded exception; it is never an active waiver.
const policy = {
  "schemaVersion": 1,
  "context": {
    "webpackConfigSha256": "0315915bbc1209e21a244c471748e1b21efab2e73bca48a3337f90bad6018c13",
    "startScript": "webpack serve --mode development --open"
  },
  "exceptions": [
    {
      "advisory": "GHSA-vfj7-8cjw-p6xm",
      "package": "braces",
      "expiresAt": "2026-10-21T00:00:00+09:00",
      "reason": "No upstream patch is available. The affected dependencies are development-only; the server binds to loopback, watches a fixed dist directory, and has no proxy or untrusted glob configuration. Review by the end of 2026-10-20 JST.",
      "allowedNodes": {
        "node_modules/chokidar/node_modules/braces": "3.0.3",
        "node_modules/http-proxy-middleware/node_modules/braces": "3.0.3",
        "node_modules/chokidar": "3.6.0",
        "node_modules/http-proxy-middleware": "2.0.10",
        "node_modules/http-proxy-middleware/node_modules/micromatch": "4.0.8",
        "node_modules/webpack-dev-server": "5.2.6"
      }
    }
  ]
}

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
  return { report, lock: { packages }, policy: structuredClone(policy), context: { ...policy.context }, now: new Date('2026-10-13T13:14:32+09:00') }
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

test('is valid through October 20 JST and expires exactly at October 21 midnight', () => {
  const data = fixture()
  data.now = new Date('2026-10-20T23:59:59.999+09:00')
  assert.equal(evaluateAudit(data).passed, true)
  data.now = new Date('2026-10-21T00:00:00+09:00')
  const result = evaluateAudit(data)
  assert.equal(result.passed, false)
  assert(result.blocked.every((entry) => entry.reason.includes('expired')))
})

test('passes after remediation even if an unused exception has expired', () => {
  const data = fixture()
  data.report = counts({ vulnerabilities: {} })
  data.now = new Date('2026-10-21T00:00:00+09:00')
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


test('the active policy has no exception and blocks the former braces graph at any date', () => {
  assert.deepEqual(activePolicy.exceptions, [])
  const data = fixture()
  data.policy = activePolicy
  data.context = { ...activePolicy.context }
  for (const date of ['2026-10-20T12:00:00+09:00', '2026-10-28T00:00:00+09:00']) {
    data.now = new Date(date)
    const result = evaluateAudit(data)
    assert.equal(result.passed, false)
    assert.equal(result.exceptions.length, 0)
    assert(result.blocked.every(entry => entry.reason === 'High advisory is not excepted'))
  }
})

test('the active policy passes a remediated graph without any exception', () => {
  const data = fixture()
  const result = evaluateAudit({ ...data, report: counts({ vulnerabilities: {} }), policy: activePolicy, context: activePolicy.context })
  assert.equal(result.passed, true)
  assert.deepEqual(result.exceptions, [])
})

test('the locked development graph removes both former braces paths and obsolete overrides', () => {
  const manifest = require('../package.json')
  const lock = require('../package-lock.json')
  const removed = /(?:^|\/)node_modules\/(?:webpack-dev-server|braces|chokidar|micromatch|http-proxy-middleware|http-proxy|follow-redirects|launch-editor|sockjs|uuid)(?:\/|$)/
  assert.deepEqual(Object.keys(lock.packages).filter(node => removed.test(node)), [])
  assert.equal(manifest.overrides, undefined)
})
