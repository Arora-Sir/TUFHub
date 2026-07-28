const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    'scripts/background': './src/scripts/background.js',
    'scripts/authorize': './src/scripts/authorize.js',
    'scripts/popup': './src/scripts/popup.js',
    'scripts/welcome': './src/scripts/welcome.js',
    'scripts/tuf/interceptor': './src/scripts/tuf/interceptor.js',
    'scripts/tuf/content': './src/scripts/tuf/content.js',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'src/manifest.json', to: 'manifest.json' },
        { from: 'src/popup.html', to: 'popup.html' },
        { from: 'src/welcome.html', to: 'welcome.html' },
        { from: 'src/css', to: 'css' },
        { from: 'src/assets', to: 'assets', noErrorOnMissing: true },
      ],
    }),
  ],
  resolve: {
    extensions: ['.js'],
  },
};
