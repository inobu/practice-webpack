const assert = require('node:assert/strict')
const http = require('node:http')
const webpack = require('webpack')
const WebpackDevServer = require('webpack-dev-server')
const config = require('../webpack.config')

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

  try {
    server = new WebpackDevServer({ ...config.devServer, port: 0, open: false }, compiler)
    await server.start()
    const address = server.server.address()
    assert.equal(address.address, '127.0.0.1', 'Dev server must listen on loopback')

    const page = await request(address.port, '/')
    assert.equal(page.status, 200)
    assert.match(page.body, /<script src="main\.js"><\/script>/)

    const bundle = await request(address.port, '/main.js')
    assert.equal(bundle.status, 200)
    assert.ok(bundle.body.length > 0, 'Dev server must serve the compiled bundle')

    const invalidHost = await request(address.port, '/', { Host: 'untrusted.example' })
    assert.equal(invalidHost.status, 403, 'Dev server must reject an untrusted Host')
    console.log('Verified dev server startup, static page, bundle, and Host validation')
  } finally {
    try {
      if (server) await server.stop()
    } finally {
      await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()))
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
