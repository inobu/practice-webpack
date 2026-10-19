const path = require('path')

const outputPath = path.resolve(__dirname, 'dist')
console.log(outputPath)

module.exports = {
  entry: './src/index.js',
  output: {
    filename: 'main.js',
    path: outputPath
  },
  devServer: {
    host: '127.0.0.1',
    static: {
      directory: outputPath,
      watch: {
        // This is a literal directory; never interpret watch paths as globs.
        disableGlobbing: true,
        followSymlinks: false
      }
    }
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [
          'style-loader',
          'css-loader'
          
        ]
      },
    ]
  }
}
