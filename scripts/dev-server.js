const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { parseArgs } = require('node:util')
const webpack = require('webpack')
const devMiddleware = require('webpack-dev-middleware')
const Watchpack = require('watchpack')
const config = require('../webpack.config')

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2'
}

function inside(root, file) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function allowedRequest(req, port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const host = req.headers.host
  const hostCount = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length
  return hostCount === 1 && hosts.has(host) &&
    (req.headers.origin === undefined || req.headers.origin === `http://${host}`) &&
    (req.headers['sec-fetch-site'] === undefined || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
}

async function startDevServer({ port = 8080, root = path.resolve(__dirname, '..'), webpackConfig = config } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535')
  const staticPath = path.join(await fs.realpath(root), 'dist')
  if ((await fs.lstat(staticPath)).isSymbolicLink()) throw new Error('The dist directory must not be a symbolic link')
  const staticRoot = await fs.realpath(staticPath)
  const compiler = webpack({ ...webpackConfig, context: root, mode: 'development' })
  let middleware
  let watcher
  let closing
  let failStartup
  const failed = new Promise((_, reject) => { failStartup = reject })
  failed.catch(() => {})
  compiler.hooks.failed.tap('DevStartup', failStartup)

  function reply(req, res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    if (!allowedRequest(req, server.address().port)) return reply(req, res, 403, 'Forbidden')
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD')
      return reply(req, res, 405, 'Method not allowed')
    }

    let pathname
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new Error('Invalid request target')
      pathname = decodeURIComponent(req.url.split('?')[0])
      if (pathname.includes('\\') || pathname.includes('\0') ||
          pathname.split('/').some(segment => segment.startsWith('.'))) throw new Error('Invalid path')
    } catch {
      return reply(req, res, 400, 'Invalid path')
    }

    if (pathname === '/__dev/events' && req.method === 'HEAD') return reply(req, res, 405, 'Use GET for live reload')
    if (pathname.startsWith('/__dev/') && pathname !== '/__dev/events') return reply(req, res, 404, 'Not found')

    await new Promise((resolve, reject) => {
      // Middleware serves only compiler output from its in-memory filesystem.
      res.once('finish', resolve)
      res.once('close', resolve)
      middleware(req, res, error => error ? reject(error) : resolve())
    })
    if (res.writableEnded || res.destroyed) return

    try {
      const file = await fs.realpath(path.join(staticRoot, pathname.endsWith('/') ? `${pathname}index.html` : pathname))
      if (!inside(staticRoot, file)) return reply(req, res, 403, 'Forbidden')
      if (path.relative(staticRoot, file).split(path.sep).some(segment => segment.startsWith('.'))) return reply(req, res, 403, 'Forbidden')
      if (!(await fs.stat(file)).isFile()) return reply(req, res, 404, 'Not found')
      const body = await fs.readFile(file)
      const extension = path.extname(file).toLowerCase()
      reply(req, res, 200, body, mimeTypes[extension] || 'application/octet-stream')
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return reply(req, res, 404, 'Not found')
      throw error
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      console.error('Development request failed:', error.message)
      if (!res.headersSent) reply(req, res, 500, 'Development server error')
      else res.destroy()
    })
  })
  server.on('upgrade', (req, socket) => {
    const status = allowedRequest(req, server.address().port) ? '426 Upgrade Required' : '403 Forbidden'
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  })
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'))

  async function close() {
    if (closing) return closing
    closing = (async () => {
      watcher?.close()
      const closed = server.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve()
      server.closeAllConnections()
      try {
        if (middleware) await new Promise((resolve, reject) => middleware.close(error => error ? reject(error) : resolve()))
      } finally {
        await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()))
        await closed
      }
    })()
    return closing
  }

  try {
    middleware = devMiddleware(compiler, {
      publicPath: '/', stats: 'errors-warnings',
      hot: { transport: 'sse', path: '/__dev/events', cors: false, token: true, client: { apply: 'reload' } }
    })
    watcher = new Watchpack({ aggregateTimeout: 100, followSymlinks: false })
    watcher.on('aggregated', () => middleware.publish({ action: 'reload' }))
    // Only a fixed directory is watched. Request data never supplies a pattern.
    watcher.watch({ directories: [staticRoot], startTime: Date.now() })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    await Promise.race([new Promise(resolve => middleware.waitUntilValid(resolve)), failed])
    return { server, close, url: `http://127.0.0.1:${server.address().port}`, compiler, token: middleware.token }
  } catch (error) {
    await close()
    throw error
  }
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: false })
  child.on('error', () => console.warn(`Open ${url} in your browser.`))
  child.unref()
}

async function main() {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8080' }, 'no-open': { type: 'boolean' } } })
  const dev = await startDevServer({ port: Number(values.port) })
  const shutdown = () => dev.close().catch(error => { console.error(error); process.exitCode = 1 })
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.log(`Development server: ${dev.url}`)
  if (!values['no-open']) openBrowser(dev.url)
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { startDevServer }
