import 'dotenv/config';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import swc from '@rollup/plugin-swc';
import polyfills from 'rollup-plugin-polyfill-node';

export default {
    input: 'src/extension.ts',
    output: {
        file: 'out/browser.js',
        format: 'cjs',
        sourcemap: true
    },
    external: ['vscode'],
    plugins: [
        replace({
            preventAssignment: true,
            values: {
                'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
                'process.env.ENV': JSON.stringify(process.env.ENV),
                'process.env.PORT': JSON.stringify(process.env.PORT),
                'process.env.PLATFORM': JSON.stringify('web'),
                'process.env.ROOT_FOLDER': JSON.stringify(process.env.ROOT_FOLDER),

                'process.env.ACCESS_TOKEN': JSON.stringify(process.env.ACCESS_TOKEN),
                'process.env.COOKIE_NAME': JSON.stringify(process.env.COOKIE_NAME),
                'process.env.API_URL': JSON.stringify(process.env.API_URL),
                'process.env.HOME_URL': JSON.stringify(process.env.HOME_URL),
                'process.env.LOGIN_URL': JSON.stringify(process.env.LOGIN_URL),
                'process.env.REALTIME_URL': JSON.stringify(process.env.REALTIME_URL),
                'process.env.RELAY_URL': JSON.stringify(process.env.RELAY_URL),
                'process.env.MESSENGER_URL': JSON.stringify(process.env.MESSENGER_URL)
            }
        }),
        nodeResolve({
            browser: true,
            preferBuiltins: false,
            extensions: ['.js', '.ts']
        }),
        commonjs(),
        polyfills(),
        swc()
    ]
};
