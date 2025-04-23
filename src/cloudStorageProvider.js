const vscode = require('vscode');
const { Api, AssetModifiedError } = require('./api');
const path = require('path');
const FileDecorationProvider = require('./fileDecorationProvider');
const crypto = require('crypto');

let fileDecorationProvider;

const DEBUG = process.env.VSCODE_DEBUG_MODE === 'true';
const SEARCH_RESULT_MAX_LENGTH = 80;

class CloudStorageProvider {
    constructor(context, projectDataProvider) {

        this.projects = [];
        this.userId = null;

        this.context = context;
        this._onDidChangeFile = new vscode.EventEmitter();

        const filePath = path.join(__dirname, '..', 'node_modules', 'playcanvas', 'build/playcanvas.d.ts');
        this.typesReference = '///<reference path="' + filePath + '" />;\n';

        this.refresh();

        this.syncProjectsCalled = false;
        this.syncProjectsPromise = null;
        this.projectDataProvider = projectDataProvider;
    }

    get onDidChangeFile() {
        if (DEBUG) console.log('playcanvas: onDidChangeFile');
        return this._onDidChangeFile.event;
    }

    isProjectPath(path) {
        return path.split('/').length === 2;
    }

    async stat(uri) {
        if (DEBUG) console.log(`playcanvas: stat ${uri.path}`);

        if (uri.path.includes('.vscode') || uri.path.includes('.git') ||
            uri.path.includes('.devcontainer') || uri.path.includes('node_modules') ||
            uri.path.includes('pom.xml') || uri.path.includes('AndroidManifest.xml')) {
            throw vscode.FileSystemError.FileNotFound();
        }

        let project = this.getProject(uri.path);
        if (!project) {
            // if projects are not synced yet
            if (this.projects.length === 0) {
                if (DEBUG) console.log(`playcanvas: stat ${uri.path} no projects`);
                await this.ensureSyncProjects();
                project = this.getProject(uri.path);
            }
        }

        if (!project) {
            if (DEBUG) console.log(`playcanvas: stat ${uri.path} not found`);
            throw vscode.FileSystemError.FileNotFound();
        }

        if (this.isProjectPath(uri.path)) {
            const projectModified = new Date(project.modified).getTime();
            const projectCreated = new Date(project.created).getTime();
            return { type: vscode.FileType.Directory, permissions: 0, size: 0, ctime: projectCreated, mtime: projectModified };
        }

        let asset = this.lookup(uri);
        if (!asset) {
            if (DEBUG) console.log(`playcanvas: stat ${uri.path} not found`);
            throw vscode.FileSystemError.FileNotFound();
        }

        const modified = new Date(asset.modifiedAt).getTime();
        const created = new Date(asset.createdAt).getTime();

        if (asset.type === 'folder') {
            return { type: vscode.FileType.Directory, permissions: 0, size: 0, ctime: created, mtime: modified };
        }

        return { type: vscode.FileType.File, permissions: 0, size: asset.file.size, ctime: created, mtime: modified };
    }

    async readFile(uri) {
        if (DEBUG) console.log(`playcanvas: readFile ${uri.path}`);

        if (uri.path.includes('.vscode') || uri.path.includes('.git') || uri.path.includes('.devcontainer')) {
            throw vscode.FileSystemError.FileNotFound();
        }

        let project = this.getProject(uri.path);
        if (!project) {
            // if projects are not synced yet
            if (this.projects.length === 0) {
                if (DEBUG) console.log(`playcanvas: stat ${uri.path} no projects`);
                await this.ensureSyncProjects();
                project = this.getProject(uri.path);
            }
        }

        if (!project) {
            throw vscode.FileSystemError.FileNotFound();
        }

        let asset = this.lookup(uri);
        if (!asset) {
            throw vscode.FileSystemError.FileNotFound();
        }

        if (asset && asset.type === 'folder') {
            return new Uint8Array();
        }

        if (!asset.content) {
            asset.content = await this.fetchFileContent(asset, project.branchId);
        }

        if (asset.content === null) {
            throw vscode.FileSystemError.FileNotFound();
        }

        const config = vscode.workspace.getConfiguration('playcanvas');

        if (config.get('usePlaycanvasTypes') && (asset.file.filename.endsWith('.js') || asset.file.filename.endsWith('.mjs'))) {
            return new TextEncoder().encode(this.typesReference + asset.content);
        }

        return new TextEncoder().encode(asset.content);
    }

    addFile(path, asset) {
        const parts = path.split('/');
        const project = this.getProjectByName(parts[1]);
        if (!project || parts.length === 0) {
            return null;
        }

        let files = project.files;
        for (let i = 2; i < parts.length - 1; ++i) {
            const folder = files.get(parts[i]);
            if (!folder) {
                throw new Error(`Failed to find folder ${parts[i]}`);
            }
            files = folder.files;
        }
        files.set(parts[parts.length - 1], asset);
    }

    removeFile(path) {
        const parts = path.split('/');
        const project = this.getProjectByName(parts[1]);
        if (!project || parts.length === 0) {
            return null;
        }

        let files = project.files;
        for (let i = 2; i < parts.length - 1; ++i) {
            const folder = files.get(parts[i]);
            if (!folder) {
                throw new Error(`Failed to find folder ${parts[i]}`);
            }
            files = folder.files;
        }
    }

    async checkAssetSynced(uri, newContent) {
        const project = this.getProject(uri.path);

        let localAsset = this.lookup(uri);
        const serverAsset = await this.api.fetchAsset(localAsset.id, project.branchId);

        if (DEBUG) console.log(`playcanvas: writeFile ${uri.path}\nlocalAsset:`, localAsset);
        if (DEBUG) console.log(`playcanvas: writeFile ${uri.path}\nserverAsset:`, serverAsset);

        // Important to know if modifiedAt matches, because PUT calls will fail if not matching
        // This makes the assumption that only the server updates modifiedAt
        const isAssetSynced = serverAsset.modifiedAt === localAsset.modifiedAt

        // Calculate file content hashes to determine if we need to stop
        // the user from pushing new changes.
        const remoteHash = serverAsset.file.hash;
        // This makes the assumption that only the server updates asset.file.hash
        const previousSyncHash = localAsset.file.hash;
        // Hash of our "new" file changes
        const localHash = crypto.createHash('md5').update(newContent).digest('hex');
        /* File is "synced" if one of these is true:
            A) Our last sync matches remote
            B) Our current file matches the remote file
        */
        const isContentSynced = remoteHash === previousSyncHash || localHash === remoteHash;

        if (DEBUG) console.log(`playcanvas: writeFile ${uri.path}\nremoteHash: ${remoteHash}\npreviousSyncHash: ${previousSyncHash}\nlocalHash: ${localHash}`);
        if (DEBUG) console.log(`playcanvas: writeFile ${uri.path}\nisContentSynced: ${isContentSynced}\nisAssetSynced: ${isAssetSynced}`);

        return {
            isAssetSynced,
            isContentSynced,
            serverAsset,
            localAsset,
        }
    }

    async writeFile(uri, content, options) {
        if (DEBUG) console.log(`playcanvas: writeFile ${uri.path}`);

        const project = this.getProject(uri.path);
        let asset = this.lookup(uri);

        if (!asset) {
            if (!options.create) {
                throw vscode.FileSystemError.FileNotFound();
            }

            const folderPath = path.dirname(uri.path);
            const folderUri = vscode.Uri.parse(`playcanvas:${path.dirname(uri.path)}`);

            // Construct the new Uri using the folder path and new name
            try {
                const root = this.isProjectPath(folderPath);
                const folderData = root ? null : this.lookup(folderUri);
                const name = uri.path.split('/').pop();
                await this.api.createAsset(project.id, project.branchId, folderData ? folderData.id : null, name);
                await this.refreshProject(project);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create a file: ${error.message}`);
            }
        } else {
            let strContent = new TextDecoder().decode(content);

            // Remove reference line before saving
            const config = vscode.workspace.getConfiguration('playcanvas');

            if (config.get('usePlaycanvasTypes') && (asset.file.filename.endsWith('.js') || asset.file.filename.endsWith('.mjs'))) {
                if (strContent.startsWith(this.typesReference)) {
                    strContent = strContent.substring(this.typesReference.length);
                    content = Buffer.from(strContent);
                }
            }

            // Check if the file asset is synced with the server
            const {
                isContentSynced, // Does file content match the server?
                isAssetSynced, // Does asset metadata match the server?
                serverAsset
            } = await this.checkAssetSynced(uri, strContent);

            if (!isContentSynced) {
                if (DEBUG) console.log(`playcanvas: writeFile ${uri.path} - Latest file changes on the server have not been pulled yet.`);
                throw AssetModifiedError
            }

            // We must handle a difference in metadata because the PUT will fail
            if (!isAssetSynced) {
                if (DEBUG) console.log(`playcanvas: writeFile ${uri.path} - asset modified on server, but file content is synced. Pulling new metadata from server...`);

                asset = {
                    ...asset,
                    // Overwrite local metadata with server metadata
                    // Note: This method only merges the top-level properties
                    ...serverAsset,
                    // Add new file contents (since asset.content is from the previous update)
                    content: strContent,
                }
            }

            // Update server asset
            const updatedAsset = await this.api.uploadFile(asset.id, asset.file.filename, asset.modifiedAt, project.branchId, strContent);
            if (DEBUG) console.log('playcanvas: writeFile updatedAsset:', updatedAsset);

            // Pull in new metadata from the server, and add the new file contents
            asset = {
                ...asset,
                // Overwrite local metadata with server metadata
                // Note: This method only merges the top-level properties
                ...updatedAsset,
                // Add new file contents (since asset.content is from the previous update)
                content: strContent,
            }

            // Update local state
            project.files.set(this.getFilename(asset), asset);

            if (DEBUG) console.log('playcanvas: local asset updated to:', this.lookup(uri))
        }
    }

    watch(uri) {
        // ignore, fires for all changes...
        return new vscode.Disposable(() => { });
    }

    isWritableFileSystem(scheme) {
        return true;
    }

    async rename(oldUri, newUri) {
        console.log(`playcanvas: rename ${oldUri.path}`);

        const newName = newUri.path.split('/').pop();
        const oldAsset = this.lookup(oldUri);
        const project = this.getProject(oldUri.path);
        const folder = this.lookup(vscode.Uri.parse(`playcanvas:${path.dirname(newUri.path)}`));
        const asset = await this.api.renameAsset(oldAsset.id, folder ? folder.id : null, newName, project.branchId);
        asset.modifiedAt = asset.modifiedAt;
        await this.refreshProject(project);
    }

    getProject(path) {
        const projectName = path.split('/')[1];
        return this.getProjectByName(projectName);
    }

    getProjectUri(project) {
        return vscode.Uri.parse(`playcanvas:/${project.name}`);
    }

    getProjectByName(name) {
        if (!name) {
            return null;
        }
        const projectBranch = name.split(':');
        return this.projects.find(p => p.name === projectBranch[0]);
    }

    getBranchByFolderName(folderName) {
        const projectBranch = folderName.split(':');
        return projectBranch[1] ? projectBranch[1] : 'main';
    }

    getProjectById(id) {
        return this.projects.find(p => p.id === id);
    }

    async copy(sourceUri, targetUri) {
        console.log(`playcanvas: copy ${sourceUri.path}`);

        const asset = this.lookup(sourceUri);
        const folderUri = vscode.Uri.parse(`playcanvas:${path.dirname(targetUri.path)}`);
        const folderData = this.lookup(folderUri);
        const sourceProject = this.getProject(sourceUri.path);
        const targetProject = this.getProject(targetUri.path);
        const folderId = folderData ? folderData.id : null;
        await this.api.copyAsset(sourceProject.id, sourceProject.branchId, asset.id,
            targetProject.id, targetProject.branchId, folderId);
        await this.refreshProject(targetProject);
    }

    async delete(uri) {
        const asset = this.lookup(uri);
        const project = this.getProject(uri.path);
        await this.api.deleteAsset(asset.id, project.branchId);
        await this.refreshProject(project);
    }

    async readDirectory(uri) {
        console.log(`playcanvas: readDirectory ${uri.path}`);
        const project = this.getProject(uri.path);
        await this.fetchAssets(project);
        const folder = this.lookup(uri);
        const folderFiles = folder ? [...folder.files.values()] : [...project.files.values()];
        console.log(`playcanvas: readDirectory return files ${folderFiles.length}`);
        return folderFiles.map(f => [this.getFilename(f), f.type == 'folder' ? vscode.FileType.Directory : vscode.FileType.File]);
    }

    async createDirectory(uri) {
        console.log(`playcanvas: createDirectory ${uri.path}`);
        const project = this.getProject(uri.path);
        const asset = this.lookup(uri);
        if (!asset) {
            const folderPath = path.dirname(uri.path);
            const folderUri = vscode.Uri.parse(`${folderPath}`);

            // Construct the new Uri using the folder path and new name
            try {
                const root = this.isProjectPath(folderPath);
                const folderData = root ? null : this.lookup(folderUri);
                const name = uri.path.split('/').pop();
                await this.api.createAsset(project.id, project.branchId, folderData ? folderData.id : null, name, 'folder');
                await this.refreshProject(project);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create a folder: ${error.message}`);
            }
        }
    }

    async fetchUserId() {
        this.userId = await this.api.fetchUserId();
    }

    async getProjects() {
        return this.projects;
    }

    async fetchProjects(skipCaching) {
        if (!this.userId) {
            this.userId = await this.api.fetchUserId();
        }
        console.log(`playcanvas: fetchProjects`);

        // preserve branch selection
        const branchSelection = new Map();
        this.projects.forEach(p => {
            if (p.branchId) {
                branchSelection.set(p.id, p.branchId);
            }
        });

        const projects = await this.api.fetchProjects(this.userId);

        projects.forEach(p => {
            if (branchSelection.get(p.id)) {
                p.branchId = branchSelection.get(p.id);
            };
        });

        if (!skipCaching) {
            this.projects = projects;
        }

        return projects;
    }

    setProjects(projects) {
        this.projects = projects;
    }

    async fetchProject(id) {
        console.log(`playcanvas: fetchProject`);
        return await this.api.fetchProject(id);
    }

    async fetchBranches(project) {
        console.log(`playcanvas: fetchBranches ${project.name}`);
        // if (!project.branches) {
        const branches = await this.api.fetchBranches(project.id);
        project.branches = branches;
        // }
        return project.branches;
    }

    async getProjectBranchName(project) {
        if (!project.branchId) {
            return 'main';
        }
        const branches = await this.fetchBranches(project);
        const branch = branches.find(b => b.id === project.branchId);
        return branch ? branch.name : '';
    }

    async initializeProject(project, branch) {
        if (branch && branch != 'main') {
            await this.fetchBranches(project);
            this.switchBranch(project, branch);
        }
        await this.fetchAssets(project);
    }

    switchBranch(project, branchName) {
        const branch = project.branches.find(b => b.name === branchName);
        project.branchId = branch.id;
    }

    getFilename(asset) {
        return asset.file ? asset.file.filename : asset.name;
    }

    getPath(projectName, file, fileMap) {
        if (file.path) {
            return file.path;
        }

        const filename = this.getFilename(file);

        if (file.parent) {
            const parent = fileMap.get(file.parent);
            if (parent) {
                file.path = this.getPath(projectName, parent, fileMap) + '/' + filename;
                parent.files.set(filename, file);
            }
        } else {
            file.path = projectName + '/' + filename;
        }

        return file.path;
    }

    buildPaths(projectName, files) {
        console.log(`playcanvas: buildPaths ${projectName}`);
        const fileMap = new Map();
        for (const file of files) {
            fileMap.set(file.id, file);
            if (file.type === 'folder') {
                file.files = new Map();
            }
        }

        for (const file of files) {
            this.getPath(projectName, file, fileMap);
        }
    }

    async fetchAssets(project) {
        if (!project.files) {
            console.log(`playcanvas: fetchAssets ${project.name}, branch: ${project.branchId}`);
            const files = await this.api.fetchAssets(project.id, project.branchId);
            project.files = new Map();
            for (const file of files) {
                if (!file.parent) {
                    project.files.set(this.getFilename(file), file);
                }
            }
            this.buildPaths(project.name, files);
        }
        return project.files;
    }

    async fetchFileContent(asset, branchId) {
        console.log(`playcanvas: fetchFileContent ${asset.name}`);
        return this.api.fetchFileContent(asset.id, asset.file.filename, branchId);
    }

    lookup(uri) {
        const parts = uri.path.split('/');
        const project = this.getProjectByName(parts[1]);
        if (!project || parts.length === 0) {
            return null;
        }

        let files = project.files;
        if (!files) {
            return null;
        }
        for (let i = 2; i < parts.length - 1; ++i) {
            const folder = files.get(parts[i]);
            if (!folder) {
                return null;
            }
            files = folder.files;
        }
        return files.get(parts[parts.length - 1]);
    }

    refresh(clearProjects = true) {
        this.api = new Api(this.context);

        if (clearProjects) {
            this.projects = [];
        } else {
            this.projects.forEach(p => { delete p.files; delete p.branches; delete p.branchId });
        }
    }

    refreshUri(uri) {
        console.log('refreshUri ' + uri.path);
        // Fire the event to signal that a file has been changed.
        // VS Code will call your readDirectory and other methods to update its view.
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: uri }]);
    }

    async refreshProject(project) {
        console.log('refreshProject' + project.name);
        delete project.files;
        await this.fetchAssets(project);
    }

    async pullLatest(path) {
        console.log('pullLatest ' + path);
        const project = this.getProject(path);
        await this.refreshProject(project);
    }

    async ensureSyncProjects() {
        if (!this.syncProjectsCalled) {
            this.syncProjectsCalled = true;
            this.syncProjectsPromise = this.syncProjects();
        }
        return this.syncProjectsPromise;
    }

    async syncProjects() {
        console.log('syncProjects');
        try {
            const token = await this.context.secrets.get('playcanvas.accessToken');

            if (token) {
                await this.fetchUserId();
                await this.fetchProjects();

                // preload projects
                let promises = [];
                const folders = vscode.workspace.workspaceFolders;
                if (folders) {
                    for (const folder of folders) {
                        if (folder.uri.scheme.startsWith('playcanvas')) {
                            const project = this.getProjectByName(folder.name);
                            if (project) {
                                const branch = this.projectDataProvider.getWorkspaceData(folder.uri.path).branch;
                                promises.push(this.initializeProject(project, branch));
                            }
                        }
                    }
                }
                await Promise.all(promises);
            }

            fileDecorationProvider = new FileDecorationProvider(this.context, this.projectDataProvider, this);
            vscode.window.registerFileDecorationProvider(fileDecorationProvider);

            this.projectDataProvider.refresh();

        } catch (err) {
            console.error('error during activation:', err);
            throw err;
        }
    }

    async searchFiles(pattern, folder) {

        const results = [];

        try {
            const config = vscode.workspace.getConfiguration('playcanvas');
            const maxSearchResults = config.get('maxSearchResults');

            const regex = new RegExp(pattern, 'i');
            const self = this;

            async function searchDirectory(dir) {
                const files = await self.readDirectory(dir);
                for (const file of files) {

                    const newPath = dir.path + '/' + file[0];
                    const filePath = dir.with({ path: newPath });

                    if (file[1] === vscode.FileType.Directory) {
                        await searchDirectory(filePath);
                    } else {
                        const content = await self.readFile(filePath);

                        // decode content to string
                        const decoder = new TextDecoder();
                        const contentString = decoder.decode(content);

                        const lines = contentString.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            if (regex.test(lines[i])) {
                                results.push({
                                    uri: filePath,
                                    line: i + 1,
                                    lineText: lines[i].length > SEARCH_RESULT_MAX_LENGTH ? lines[i].substring(0, SEARCH_RESULT_MAX_LENGTH) + '...' : lines[i]
                                });
                            }

                            if (results.length >= maxSearchResults) {
                                return;
                            }
                        }
                    }
                }
            }
            if (folder) {
                // search in folder
                await searchDirectory(folder);
            } else {
                // global search
                const folders = vscode.workspace.workspaceFolders;
                if (folders) {
                    for (const folder of folders) {
                        if (folder.uri.scheme.startsWith('playcanvas')) {
                            await searchDirectory(folder.uri);
                        }
                    }
                }
            }
        } catch (err) {
            console.error('error during search:', err);
            throw err;
        }
        return results;
    }

    async getToken() {
        return this.api.getToken();
    }
}

module.exports = CloudStorageProvider;
