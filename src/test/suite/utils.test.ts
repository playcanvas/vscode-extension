import * as assert from 'assert';

import type { Project } from '../../typings/models';
import { sanitizeName, projectToName } from '../../utils/utils';

suite('Utils Test Suite', () => {
    test('sanitizeName preserves spaces', () => {
        assert.strictEqual(sanitizeName('hello world'), 'hello world');
    });

    test('sanitizeName replaces slash', () => {
        assert.strictEqual(sanitizeName('foo/bar'), 'foo_bar');
    });

    test('sanitizeName replaces all illegal chars', () => {
        assert.strictEqual(sanitizeName('a<>:"|?*b'), 'a_______b');
    });

    test('sanitizeName trims leading dots', () => {
        assert.strictEqual(sanitizeName('...hidden'), 'hidden');
    });

    test('sanitizeName trims trailing dot and space', () => {
        assert.strictEqual(sanitizeName('trailing. '), 'trailing');
    });

    test('sanitizeName preserves legal special chars', () => {
        assert.strictEqual(sanitizeName('My Project!'), 'My Project!');
    });

    test('sanitizeName preserves emoji', () => {
        assert.strictEqual(sanitizeName('Cool 😀 Project'), 'Cool 😀 Project');
    });

    test('sanitizeName prefixes windows reserved names', () => {
        assert.strictEqual(sanitizeName('CON'), '_CON');
    });

    test('sanitizeName empty fallback', () => {
        assert.strictEqual(sanitizeName('///'), '___');
    });

    test('projectToName uses sanitizeName when encode is true', () => {
        assert.strictEqual(projectToName({ name: 'My Project!', id: 42 } as Project), 'My Project! (42)');
    });

    test('projectToName passes through raw name when encode is false', () => {
        assert.strictEqual(projectToName({ name: 'foo/bar', id: 1 } as Project, false), 'foo/bar (1)');
    });
});
