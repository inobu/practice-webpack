const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { once } = require('node:events')
const { createRequire } = require('node:module')
const webpack = require('webpack')
const WebpackDevServer = require('webpack-dev-server')
const config = require('../webpack.config')
const serverRequire = createRequire(require.resolve('webpack-dev-server'))
const WebSocket = serverRequire('ws')

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.setTimeout(10000, () => req.destroy(new Error(`Request timed out: ${pathname}`)))
    req.on('error', reject)
  })
}

async function main() {
  const compiler = webpack({
    ...config,
    mode: 'development',
    stats: 'errors-only',
    infrastructureLogging: { level: 'error' }
  })
  let server
  let socket
  const watchedFile = path.join(config.devServer.static.directory, `dev-server-smoke-${process.pid}.txt`)

  try {
    await fs.writeFile(watchedFile, 'before')
    server = new WebpackDevServer({ ...config.devServer, port: 0, open: false }, compiler)
    await server.start()
    const address = server.server.address()
    assert.equal(address.address, '127.0.0.1', 'Dev server must listen on loopback')
    assert.equal(server.options.proxy, undefined, 'No proxy configuration was reviewed')
    assert.deepEqual(server.options.watchFiles, [], 'No extra watch patterns were reviewed')
    assert.equal(server.options.static.length, 1)
    assert.equal(server.options.static[0].directory, path.resolve(__dirname, '..', 'dist'))
    assert.equal(server.staticWatchers.length, 1)
    const [watcher] = server.staticWatchers
    assert.equal(watcher.options.disableGlobbing, true, 'Chokidar must treat watch paths literally')
    assert.equal(watcher.options.followSymlinks, false, 'Static watching must not follow symlinks')
    if (!watcher._readyEmitted) await once(watcher, 'ready')

    // With no proxy, webpack-dev-server must not initialize this dependency path.
    const proxyModule = serverRequire.resolve('http-proxy-middleware')
    assert.equal(require.cache[proxyModule], undefined, 'Proxy middleware must not be loaded')

    const page = await request(address.port, '/')
    assert.equal(page.status, 200)
    assert.match(page.body, /<script src="main\.js"><\/script>/)

    const bundle = await request(address.port, '/main.js')
    assert.equal(bundle.status, 200)
    assert.ok(bundle.body.length > 0, 'Dev server must serve the compiled bundle')

    const invalidHost = await request(address.port, '/', { Host: 'untrusted.example' })
    assert.equal(invalidHost.status, 403, 'Dev server must reject an untrusted Host')

    const crossOrigin = await request(address.port, '/main.js', {
      Origin: 'https://untrusted.example',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site'
    })
    assert.equal(crossOrigin.status, 403, 'Dev server must reject cross-site script loading')

    // Request data must never become a watch/proxy glob.
    const nestedPattern = `${'{'.repeat(4500)}a,b${'}'.repeat(4500)}`
    const nestedGlob = `/${nestedPattern}/*`
    assert.equal(watcher._getWatchHelpers(nestedGlob).hasGlob, false,
      'Even deeply nested brace input must bypass Chokidar glob expansion')
    const nestedRequest = await request(address.port, `/main.js?pattern=${nestedPattern}`)
    assert.equal(nestedRequest.status, 200)
    assert.equal((await request(address.port, '/main.js')).status, 200)

    const invalidSocket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: 'https://untrusted.example'
    })
    try {
      const [[data]] = await Promise.all([once(invalidSocket, 'message'), once(invalidSocket, 'close')])
      assert.deepEqual(JSON.parse(data.toString()), { type: 'error', data: 'Invalid Host/Origin header' })
    } finally {
      invalidSocket.terminate()
    }

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: `http://127.0.0.1:${address.port}`
    })
    await once(socket, 'open')
    const changed = new Promise((resolve, reject) => {
      socket.on('error', reject)
      socket.on('close', () => reject(new Error('Dev socket closed before the static change')))
      socket.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          if (message.type === 'static-changed') {
            assert.equal(message.data, watchedFile)
            resolve()
          }
        } catch (error) {
          reject(error)
        }
      })
    })
    await Promise.all([changed, fs.writeFile(watchedFile, 'after')])
    assert.equal(require.cache[proxyModule], undefined, 'Requests must not initialize the proxy path')
    console.log('Verified loopback, literal static watching and live reload, no proxy, Host and HTTP/WebSocket origin checks, and nested request data handling')
  } finally {
    try {
      if (socket) socket.terminate()
      if (server) await server.stop()
    } finally {
      try {
        await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()))
      } finally {
        await fs.rm(watchedFile, { force: true })
      }
    }
  }
}

const timeout = setTimeout(() => {
  console.error('Dev server smoke test timed out')
  process.exit(1)
}, 30000)

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => clearTimeout(timeout))
