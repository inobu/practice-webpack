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
      directory: outputPath
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
