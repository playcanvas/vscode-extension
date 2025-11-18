import { execSync } from 'child_process';
import fs from 'fs';

const WEB = process.env.args?.includes('--web') || false;

const pkg = JSON.parse(fs.readFileSync('./plugin/package.json', 'utf8'));

// check if we have unstaged changes
try {
    execSync('git diff --exit-code', { stdio: 'ignore' });
    execSync('git diff --cached --exit-code', { stdio: 'ignore' });
} catch {
    console.error('You have unstaged changes. Please commit or stash them before building.');
    process.exit(1);
}

const cleanup = () => {
    execSync('git clean -fd', { stdio: 'inherit' });
    execSync('npm install file:plugin', { stdio: 'inherit' });
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
    cleanup();
    process.exit(1);
});
process.on('uncaughtException', (err) => {
    console.error(err);
    cleanup();
    process.exit(1);
});

// compile extension
execSync('npm run compile', { stdio: 'inherit' });

// compile web extension
execSync('npm run compile:web', { stdio: 'inherit' });

// compile plugin
execSync('npm run compile:plugin', { stdio: 'inherit' });

// pack plugin
execSync('npm pack', { stdio: 'inherit', cwd: './plugin' });

// install packed plugin
execSync(`npm install ./plugin/${pkg.name}-0.0.0.tgz`, { stdio: 'inherit' });

// pack extension
execSync(`vsce package ${WEB ? '-t web' : ''}`, { stdio: 'inherit' });
