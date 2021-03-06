const path = require('path')

module.exports = {
  entry: path.resolve(__dirname, 'src/index.ts'),
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'index.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'vscode',
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        options: {
          transpileOnly: true,
        },
      },
    ],
  },
}
