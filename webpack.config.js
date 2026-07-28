const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

// Load environment variables from .env file if available
require('dotenv').config();

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
    new webpack.DefinePlugin({
      'process.env.GITHUB_CLIENT_ID': JSON.stringify(process.env.GITHUB_CLIENT_ID || ''),
      'process.env.GITHUB_CLIENT_SECRET': JSON.stringify(process.env.GITHUB_CLIENT_SECRET || ''),
    }),
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

