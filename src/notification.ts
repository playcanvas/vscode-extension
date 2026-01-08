import * as vscode from 'vscode';

import { Deferred } from './utils/deferred';

export const simpleNotification = (message: string) => {
    return new Promise<() => void>((resolve) => {
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: message,
                cancellable: false
            },
            () => {
                const deferred = new Deferred<void>();
                resolve(deferred.resolve);
                return deferred.promise;
            }
        );
    });
};

export const progressNotification = (message: string, total: number) => {
    return new Promise<() => void>((resolve) => {
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: message,
                cancellable: false
            },
            (progress) => {
                const deferred = new Deferred<void>();
                const increment = 100 / total;
                let i = 0;

                progress.report({ message: `${i}/${total}` });
                const next = () => {
                    i++;
                    progress.report({ increment, message: `${i}/${total}` });
                    if (i >= total) {
                        deferred.resolve();
                    }
                };
                resolve(next);

                if (total === 0) {
                    deferred.resolve();
                }

                return deferred.promise;
            }
        );
    });
};
