// import commonjs from '@rollup/plugin-commonjs';
// import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';

export default {
    input: 'src/extension.js',
    output: [
        // {
        //         file: 'dist/extension.mjs',
        //         format: 'esm',
        //         sourcemap: true
        // },
        // {
        //         file: 'dist/extension.cjs',
        //         format: 'cjs',
        //         sourcemap: true
        // },
        {
            file: 'dist/extension.debug.js',
            name: 'ext',
            format: 'umd',
            sourcemap: true
        },
        {
            file: 'dist/extension.min.js',
            name: 'ext',
            format: 'umd',
            // @ts-ignore
            plugins: [terser()]
        }
    ],
    plugins: [
        // resolve(),
        // commonjs(),

        // @ts-ignore
        typescript({
            tsconfig: './tsconfig.json',
            declaration: true,
            declarationDir: './dist',
            sourceMap: true
        })
    ]
};
