const fs = require('fs')
const path = require('path')

const bundlePath = path.resolve(__dirname, '..', 'dist', 'main.js')

if (!fs.existsSync(bundlePath)) {
  throw new Error(`Expected webpack bundle at ${bundlePath}`)
}

const { size } = fs.statSync(bundlePath)
if (size === 0) {
  throw new Error(`Webpack bundle is empty: ${bundlePath}`)
}

console.log(`Verified webpack bundle (${size} bytes)`)
