export type Asset = {
    uniqueId: number;
    item_id: string;
    file?: {
        filename: string;
        hash: string;
    };
    name: string;
    path: number[];
    type: string;
};

export type Branch = {
    id: string;
    projectId: number;
    name: string;
    closed: boolean;
    permanent: boolean;
};

export type Project = {
    id: number;
    name: string;
    owner: string;
    private: boolean;
};

export type User = {
    id: number;
    username: string;
    full_name: string;
    organization: string;
};
