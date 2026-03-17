import * as assert from 'assert';

import type { Project } from '../../typings/models';
import { sanitizeName, projectToName } from '../../utils/utils';

suite('utils', () => {
    test('sanitize name - preserves spaces', () => {
        assert.strictEqual(sanitizeName('hello world'), 'hello world');
    });

    test('sanitize name - replaces slash', () => {
        assert.strictEqual(sanitizeName('foo/bar'), 'foo_bar');
    });

    test('sanitize name - replaces illegal chars', () => {
        assert.strictEqual(sanitizeName('a<>:"|?*b'), 'a_______b');
    });

    test('sanitize name - preserves leading dots', () => {
        assert.strictEqual(sanitizeName('...hidden'), '...hidden');
    });

    test('sanitize name - trims trailing dots and spaces', () => {
        assert.strictEqual(sanitizeName('trailing. '), 'trailing');
    });

    test('sanitize name - preserves legal special chars', () => {
        assert.strictEqual(sanitizeName('My Project!'), 'My Project!');
    });

    test('sanitize name - preserves emoji', () => {
        assert.strictEqual(sanitizeName('Cool 😀 Project'), 'Cool 😀 Project');
    });

    test('sanitize name - prefixes windows reserved names', () => {
        assert.strictEqual(sanitizeName('CON'), '_CON');
    });

    test('sanitize name - empty fallback', () => {
        assert.strictEqual(sanitizeName('///'), '___');
    });

    test('project to name - encoded', () => {
        assert.strictEqual(projectToName({ name: 'My Project!', id: 42 } as Project), 'My Project! (42)');
    });

    test('project to name - raw', () => {
        assert.strictEqual(projectToName({ name: 'foo/bar', id: 1 } as Project, false), 'foo/bar (1)');
    });
});
