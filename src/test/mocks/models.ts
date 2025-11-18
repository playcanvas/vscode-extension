import type { Asset, Branch, Project, User } from '../../typings/models';

export const accessToken = 'test-access-token';

export const user: User = {
    id: 1,
    username: 'testuser',
    full_name: 'Test User',
    organization: 'Test Org'
};

export const project: Project = {
    id: 1,
    name: 'Test Project',
    owner: user.username,
    private: false
};

export const branches = new Map<string, Branch>([
    [
        'main',
        {
            id: 'main',
            projectId: project.id,
            name: 'main',
            closed: false,
            permanent: true
        }
    ],
    [
        'other',
        {
            id: 'other',
            projectId: project.id,
            name: 'other',
            closed: false,
            permanent: false
        }
    ]
]);

export const projectSettings = {
    branch: branches.get('main')!.id
};

export const assets = new Map<number, Asset>(
    [
        {
            uniqueId: 1,
            item_id: '1',
            file: {
                filename: 'file.js.js'
            },
            name: 'file.js',
            path: [],
            type: 'script'
        },
        {
            uniqueId: 2,
            item_id: '2',
            file: {
                filename: 'folder'
            },
            name: 'folder',
            path: [],
            type: 'folder'
        }
    ].map((asset) => [asset.uniqueId, asset])
);

export const documents = new Map<number, string>([[1, `console.log('Hello, World!');`]]);

export const uniqueId = (function* () {
    let id = assets.size + 1;
    while (true) {
        yield id++;
    }
})();
