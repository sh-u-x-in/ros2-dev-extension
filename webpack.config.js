//@ts-check

'use strict';

const path = require('path');

/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const baseConfig = {
  mode: "none", // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
  externals: {
    vscode: "commonjs vscode", // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
  devtool: "source-map",
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: [{ loader: "ts-loader" }],
      },
    ],
  }
};

// Config for extension source code (to be run in a Node-based context)
/** @type WebpackConfig */
const extensionConfig = {
  ...baseConfig,
  target: "node",
  entry: "./src/extension.ts",
  externals: {
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    'applicationinsights-native-metrics': 'commonjs applicationinsights-native-metrics' // ignored because we don't ship native module
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
};

/** @type WebpackConfig */
const ros2_webview_config = {
  ...baseConfig,
  target: ["web", "es2022"],
  entry: "./src/ros2/consumers/monitor/webview/ros2_webview_main.ts",
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
  // ⚠️ 2026-09-09 修复:曾设 experiments.outputModule + libraryTarget "module" → 产物带顶层 export,
  // 而 HTML 以经典 <script src> 加载 → SyntaxError,前端 JS 整段不执行("点击无反应/一直'正在加载'"根因)。
  // 本 entry 无顶层导出/顶层 await,改回经典脚本格式(默认 library,无 export)。
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "ros2_webview_main.js",
  },
};


module.exports = [extensionConfig, ros2_webview_config];
