const assert = require('node:assert/strict')
const http = require('node:http')
const { createRequire } = require('node:module')

// Exercise the actual SockJS dependency used by webpack-dev-server.
const serverRequire = createRequire(require.resolve('webpack-dev-server'))
const sockjs = serverRequire('sockjs')
const WebSocket = serverRequire('ws')

async function main() {
  const server = http.createServer()
  const endpoint = sockjs.createServer({ log: () => {}, disconnect_delay: 1 })
  let connectionId
  let socket

  endpoint.on('connection', (connection) => {
    connectionId = connection.id
    connection.on('data', (message) => connection.write(`echo:${message}`))
  })
  endpoint.installHandlers(server, { prefix: '/sockjs' })

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address()
    await new Promise((resolve, reject) => {
      socket = new WebSocket(`ws://127.0.0.1:${port}/sockjs/000/smoke/websocket`)
      socket.on('error', reject)
      socket.on('close', () => reject(new Error('SockJS closed before the echo reply')))
      socket.on('message', (data) => {
        try {
          const frame = data.toString()
          if (frame === 'o') {
            socket.send(JSON.stringify(['smoke']))
          } else {
            assert.equal(frame[0], 'a')
            assert.deepEqual(JSON.parse(frame.slice(1)), ['echo:smoke'])
            resolve()
          }
        } catch (error) {
          reject(error)
        }
      })
    })
    assert.match(connectionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    console.log('Verified SockJS connection UUID and WebSocket message round trip')
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve) => {
        socket.once('close', resolve)
        if (socket.readyState === WebSocket.OPEN) socket.close(1000)
        else socket.terminate()
      })
    }
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
}

const timeout = setTimeout(() => {
  console.error('SockJS smoke test timed out')
  process.exit(1)
}, 15000)

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => clearTimeout(timeout))
