class PlayCanvasFileDecorationProvider {
    constructor(context, projectDataProvider, cloudStorageProvider) {
        this.context = context;
        this.projectDataProvider = projectDataProvider;
        this.cloudStorageProvider = cloudStorageProvider;
    }

    provideFileDecoration(uri, token) {
        
        const project = this.cloudStorageProvider.getProject(uri.path);
        if (project) {
            console.log('provideFileDecoration found', uri);
            const projectUri = this.cloudStorageProvider.getProjectUri(project);
            const data = this.projectDataProvider.getWorkspaceData(projectUri.path);
            if (data) {
                return {
                    tooltip: data.branch,
                    badge: '💡'
                };
            }
        } else {
            console.log('provideFileDecoration', uri);
        }
    }
};

module.exports = PlayCanvasFileDecorationProvider;