const path = require('path')

module.exports = {
    target: 'node',
    entry: './src/index.ts',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        libraryTarget: 'umd',
        devtoolModuleFilenameTemplate: 'webpack-tabby-browser:///[resource-path]',
    },
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    externals: ['electron', '@electron/remote', /^rxjs/, /^@angular/, /^@ng-bootstrap/, /^tabby-/],
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: [{ loader: 'ts-loader', options: { configFile: path.resolve(__dirname, 'tsconfig.json') } }],
            },
            {
                test: /\.scss$/,
                use: [
                    { loader: 'css-loader', options: { exportType: 'string', esModule: false } },
                    { loader: 'sass-loader', options: { api: 'modern' } },
                ],
            },
            {
                test: /\.pug$/,
                use: ['apply-loader', 'pug-loader'],
            },
        ],
    },
    resolve: {
        modules: [__dirname, 'src', 'node_modules'],
        extensions: ['.ts', '.js'],
    },
    devtool: 'source-map',
}
