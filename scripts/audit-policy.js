const severities = ['info', 'low', 'moderate', 'high', 'critical']
const rank = (severity) => severities.indexOf(severity)

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function evaluateAudit({ report, lock, policy, context, now = new Date() }) {
  if (!object(report) || report.error || !object(report.vulnerabilities) ||
      !object(report.metadata?.vulnerabilities)) {
    throw new Error('npm audit did not return a complete vulnerability report')
  }
  if (!object(lock?.packages) || !object(policy) || policy.schemaVersion !== 1 ||
      !Array.isArray(policy.exceptions) || !object(policy.context) ||
      typeof policy.context.webpackConfigSha256 !== 'string' ||
      typeof policy.context.startScript !== 'string' || !object(context) ||
      !Number.isFinite(now.getTime())) {
    throw new Error('Invalid audit policy, lockfile, or evaluation context')
  }

  const exceptions = new Map()
  for (const exception of policy.exceptions) {
    if (!object(exception) || !/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(exception.advisory) ||
        typeof exception.package !== 'string' || !object(exception.allowedNodes) ||
        !Number.isFinite(Date.parse(exception.expiresAt)) || exceptions.has(exception.advisory)) {
      throw new Error('Invalid or duplicate audit exception')
    }
    exceptions.set(exception.advisory, exception)
  }

  const vulnerabilities = report.vulnerabilities
  const actualCounts = Object.fromEntries(severities.map((severity) => [severity, 0]))
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (!object(vulnerability) || vulnerability.name !== name || rank(vulnerability.severity) < 0 ||
        !Array.isArray(vulnerability.via) || !Array.isArray(vulnerability.nodes) ||
        vulnerability.nodes.some((node) => typeof node !== 'string')) {
      throw new Error(`Malformed vulnerability: ${name}`)
    }
    actualCounts[vulnerability.severity]++
  }
  actualCounts.total = Object.keys(vulnerabilities).length
  for (const [severity, count] of Object.entries(actualCounts)) {
    if (report.metadata.vulnerabilities[severity] !== count) {
      throw new Error(`Incomplete audit report: ${severity} count does not match`)
    }
  }

  const cache = new Map()
  function roots(name, trail = new Set()) {
    if (trail.has(name)) throw new Error(`Cyclic audit dependency: ${name}`)
    if (cache.has(name)) return cache.get(name)
    const vulnerability = vulnerabilities[name]
    if (!vulnerability) throw new Error(`Missing audit dependency: ${name}`)
    const nextTrail = new Set([...trail, name])
    const result = vulnerability.via.flatMap((entry) => {
      if (typeof entry === 'string') {
        return roots(entry, nextTrail).map((root) => ({ ...root, path: [name, ...root.path] }))
      }
      if (!object(entry) || rank(entry.severity) < 0) {
        throw new Error(`Malformed advisory: ${name}`)
      }
      return [{ package: name, advisory: entry, path: [name] }]
    })
    cache.set(name, result)
    return result
  }

  const blocked = []
  const used = new Map()
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    const highRoots = roots(name).filter((root) => rank(root.advisory.severity) >= rank('high'))
    if (vulnerability.severity === 'critical') {
      blocked.push({ package: name, reason: 'Critical vulnerabilities are never excepted' })
      continue
    }
    if (rank(vulnerability.severity) < rank('high') && highRoots.length === 0) continue
    if (highRoots.length === 0) {
      blocked.push({ package: name, reason: 'High vulnerability has no identifiable root advisory' })
    }

    for (const root of highRoots) {
      const id = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)\/?$/.exec(root.advisory.url)?.[1]
      const exception = exceptions.get(id)
      let reason
      if (root.advisory.severity === 'critical') reason = 'Critical vulnerabilities are never excepted'
      else if (!exception || root.package !== exception.package) reason = 'High advisory is not excepted'
      else if (now.getTime() >= Date.parse(exception.expiresAt)) reason = 'Audit exception has expired'
      else if (Object.entries(policy.context).some(([key, value]) => context[key] !== value)) {
        reason = 'Development server configuration changed; review the exception'
      } else {
        for (const packageName of root.path) {
          const nodes = vulnerabilities[packageName].nodes
          if (nodes.length === 0 || nodes.some((node) =>
            lock.packages[node]?.dev !== true ||
            typeof exception.allowedNodes[node] !== 'string' ||
            lock.packages[node]?.version !== exception.allowedNodes[node])) {
            reason = 'Exception is limited to the reviewed development nodes and versions'
            break
          }
        }
      }
      if (reason) blocked.push({ package: name, advisory: id || root.advisory.url, reason })
      else {
        if (!used.has(id)) used.set(id, { advisory: id, expiresAt: exception.expiresAt, packages: [] })
        if (!used.get(id).packages.includes(name)) used.get(id).packages.push(name)
      }
    }
  }
  return { passed: blocked.length === 0, counts: actualCounts, blocked, exceptions: [...used.values()] }
}

module.exports = { evaluateAudit }
