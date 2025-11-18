import fs from 'fs';

const WORKSPACE_PATH = '.vscode-storage/prod/Test Project (1)';

if (!fs.existsSync(WORKSPACE_PATH)) {
    fs.mkdirSync(WORKSPACE_PATH, { recursive: true });
}
