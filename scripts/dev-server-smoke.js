const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter, once } = require('node:events')
const { spawn } = require('node:child_process')
const test = require('node:test')
const { startDevServer } = require('./dev-server')
const config = require('../webpack.config')
const project = path.resolve(__dirname, '..')

function request(port, pathname, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, headers, method }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', data => { body += data })
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')))
    req.on('error', reject)
    req.end()
  })
}

async function events(port, token) {
  const messages = []
  const emitter = new EventEmitter()
  let req
  const response = await new Promise((resolve, reject) => {
    req = http.get({ hostname: '127.0.0.1', port, path: `/__dev/events?token=${encodeURIComponent(token)}` }, resolve)
    req.on('error', reject)
  })
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'], /text\/event-stream/)
  assert.equal(response.headers['access-control-allow-origin'], undefined)
  let buffer = ''
  response.setEncoding('utf8')
  response.on('data', data => {
    buffer += data
    let boundary
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary).trim()
      buffer = buffer.slice(boundary + 2)
      if (!frame.startsWith('data: {')) continue
      const message = JSON.parse(frame.slice(6))
      messages.push(message)
      emitter.emit('message', message)
    }
  })
  return {
    messages,
    next(predicate, after = 0) {
      return new Promise((resolve, reject) => {
        const existing = messages.slice(after).find(predicate)
        if (existing) return resolve(existing)
        const timer = setTimeout(() => {
          emitter.removeListener('message', listener)
          reject(new Error('Live reload event timed out'))
        }, 10000)
        function listener(message) {
          if (!predicate(message)) return
          clearTimeout(timer)
          emitter.removeListener('message', listener)
          resolve(message)
        }
        emitter.on('message', listener)
      })
    },
    close() { req.destroy(); response.destroy() }
  }
}

function upgrade(port, host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let result = ''
    socket.setTimeout(5000, () => socket.destroy(new Error('Upgrade timed out')))
    socket.on('error', reject)
    socket.on('data', data => { result += data })
    socket.on('end', () => resolve(result))
    socket.on('connect', () => socket.write(`GET /__dev/events HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`))
  })
}

test('Node development server preserves rebuilding and reload with restricted access', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'practice-webpack-dev-'))
  let dev
  let stream
  t.after(async () => {
    stream?.close()
    if (dev) await Promise.all([dev.close(), dev.close()])
    await fs.rm(root, { recursive: true, force: true })
  })
  await fs.mkdir(path.join(root, 'dist', 'nested'), { recursive: true })
  await fs.cp(path.join(project, 'src'), path.join(root, 'src'), { recursive: true })
  await fs.copyFile(path.join(project, 'dist', 'index.html'), path.join(root, 'dist', 'index.html'))
  await fs.writeFile(path.join(root, 'dist', 'nested', 'asset.txt'), 'static-before')
  await fs.writeFile(path.join(root, 'private.txt'), 'outside-secret')
  await fs.writeFile(path.join(root, 'dist', '.secret'), 'hidden-secret')
  await fs.symlink(path.join(root, 'private.txt'), path.join(root, 'dist', 'escape.txt'))
  await fs.symlink(path.join(root, 'dist', '.secret'), path.join(root, 'dist', 'alias.txt'))
  const sourcePath = path.join(root, 'src', 'index.js')
  const original = await fs.readFile(sourcePath, 'utf8')
  await fs.writeFile(sourcePath, `${original}\ndocument.body.dataset.smoke = 'rebuild-before';\n`)
  const webpackConfig = {
    ...config,
    output: { ...config.output, path: path.join(root, 'dist') },
    resolve: { modules: [path.join(project, 'node_modules')] },
    resolveLoader: { modules: [path.join(project, 'node_modules')] },
    infrastructureLogging: { level: 'error' }
  }
  dev = await startDevServer({ port: 0, root, webpackConfig })
  const { port, address } = dev.server.address()
  assert.equal(address, '127.0.0.1')

  await t.test('serves HTML, in-memory bundle, HEAD and nested static files', async () => {
    const page = await request(port, '/')
    assert.equal(page.status, 200)
    assert.match(page.body, /<script src="main\.js"><\/script>/)
    const bundle = await request(port, '/main.js')
    assert.equal(bundle.status, 200)
    assert.match(bundle.body, /rebuild-before/)
    assert.ok(bundle.body.includes(dev.token), 'The injected browser runtime receives the stream token')
    assert.equal(bundle.headers['cross-origin-resource-policy'], 'same-origin')
    assert.equal(bundle.headers['x-content-type-options'], 'nosniff')
    assert.equal((await request(port, '/main.js', {}, 'HEAD')).body, '')
    assert.equal((await request(port, '/nested/asset.txt')).body, 'static-before')
    assert.equal((await request(port, '/', { Host: `localhost:${port}` })).status, 200)
    await assert.rejects(fs.access(path.join(root, 'dist', 'main.js')), { code: 'ENOENT' })
  })

  await t.test('rejects foreign hosts, origins and cross-site requests on every endpoint', async () => {
    for (const route of ['/', '/main.js', '/__dev/events']) {
      for (const headers of [
        { Host: 'untrusted.example' }, { Host: '127.0.0.1' },
        { Origin: 'https://untrusted.example' }, { Origin: 'null' },
        { Origin: `http://127.0.0.1:${port === 65535 ? 65534 : port + 1}` },
        { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }
      ]) assert.equal((await request(port, route, headers)).status, 403, `${route} ${JSON.stringify(headers)}`)
    }
    assert.equal((await request(port, '/main.js', { Origin: dev.url, 'Sec-Fetch-Site': 'same-origin' })).status, 200)
    assert.equal((await request(port, '/', {}, 'POST')).status, 405)
    assert.match(await upgrade(port, 'untrusted.example'), /^HTTP\/1\.1 403 /)
    assert.match(await upgrade(port, `127.0.0.1:${port}`), /^HTTP\/1\.1 426 /)
  })

  await t.test('blocks traversal, hidden files, symlink escapes and unconfigured routes', async () => {
    for (const route of ['/../private.txt', '/%2e%2e/private.txt', '/%2f..%2fprivate.txt', '/%5c..%5cprivate.txt', '/.secret', '/%2egit/config', '/%00', '/%zz']) {
      assert.equal((await request(port, route)).status, 400, route)
    }
    for (const route of ['/escape.txt', '/alias.txt']) assert.equal((await request(port, route)).status, 403)
    for (const route of ['/private.txt', '/package.json', '/__dev/unknown', '/webpack-dev-server/open-editor']) assert.equal((await request(port, route)).status, 404)
    const pattern = `${'{'.repeat(4500)}a,b${'}'.repeat(4500)}`
    assert.equal((await request(port, `/main.js?pattern=${pattern}`)).status, 200)
  })

  await t.test('requires a stream token, rebuilds source and publishes the new compilation', async () => {
    assert.equal((await request(port, '/__dev/events')).status, 403)
    assert.equal((await request(port, '/__dev/events?token=incorrect')).status, 403)
    stream = await events(port, dev.token)
    const first = await stream.next(message => message.action === 'sync')
    const after = stream.messages.length
    await fs.writeFile(sourcePath, `${original}\ndocument.body.dataset.smoke = 'rebuild-after';\n`)
    const built = await stream.next(message => message.action === 'built' && message.hash !== first.hash, after)
    assert.deepEqual(built.errors, [])
    const bundle = await request(port, '/main.js')
    assert.match(bundle.body, /rebuild-after/)
    assert.doesNotMatch(bundle.body, /dataset\.smoke = 'rebuild-before'/)
  })

  await t.test('publishes live reload for nested static and HTML changes', async () => {
    for (const [file, text, route] of [
      ['nested/asset.txt', 'static-after', '/nested/asset.txt'],
      ['index.html', '<!doctype html><body>static-html-after<script src="main.js"></script></body>', '/']
    ]) {
      const after = stream.messages.length
      await fs.writeFile(path.join(root, 'dist', file), text)
      await stream.next(message => message.action === 'reload', after)
      assert.equal((await request(port, route)).body, text)
    }
  })

  await t.test('cleans up a failed startup on an occupied port', async () => {
    await assert.rejects(startDevServer({ port, root, webpackConfig }), { code: 'EADDRINUSE' })
  })

  await t.test('rejects fatal initial compilation instead of waiting indefinitely', async () => {
    const fatal = { apply(compiler) {
      compiler.hooks.beforeCompile.tapPromise('FatalSmoke', () => Promise.reject(new Error('synthetic fatal compile')))
    } }
    await assert.rejects(startDevServer({ port: 0, root, webpackConfig: {
      ...webpackConfig, plugins: [fatal], infrastructureLogging: { level: 'none' }
    } }), /synthetic fatal compile/)
  })
})

test('the public start command serves the application and stops on SIGTERM', { timeout: 30000 }, async t => {
  const child = spawn(process.execPath, [path.join(__dirname, 'dev-server.js'), '--port', '0', '--no-open'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await closed
  })
  let logs = ''
  const url = await new Promise((resolve, reject) => {
    child.stderr.on('data', data => { logs += data })
    child.stdout.on('data', data => {
      logs += data
      const match = /Development server: (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)
      if (match) resolve(new URL(match[1]))
    })
    child.once('exit', code => reject(new Error(`Server exited before startup (${code}): ${logs}`)))
  })
  assert.equal((await request(Number(url.port), '/')).status, 200)
  assert.equal((await request(Number(url.port), '/main.js')).status, 200)
  child.kill('SIGTERM')
  const [code, signal] = await closed
  assert.equal(code, 0)
  assert.equal(signal, null)
})
