const assert = require('node:assert/strict');
const { pbkdf2Sync } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../entrypoint.sh'), 'utf8');
const functions = source.slice(source.indexOf('generate_keyfile_from_passphrase() {'),
    source.indexOf('# Trap signals for graceful shutdown'));

function shell(body, env = {}, prelude = '') {
    return spawnSync('/bin/bash', ['-c', `set -e
log() { printf '%s\\n' "$1" >&2; }
# Tests operate on temporary files owned by the test runner.
chown() { return 0; }
${functions}
${prelude}
${body}`], { env: { ...process.env, MONGO_KEYFILE_CONTENT: '',
        MONGO_KEYFILE_PASSPHRASE: '', MONGO_KEYFILE_SALT: '', ...env },
        encoding: 'utf8', timeout: 15000 });
}

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-keyfile-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, file: path.join(dir, 'keyfile') };
}

const setup = 'if setup_keyfile; then exit 0; else exit 1; fi';

test('PBKDF2 matches a fixed vector and uses both passphrase and the full salt', () => {
    const derive = (passphrase, salt) => {
        const result = shell('generate_keyfile_from_passphrase "$MONGO_KEYFILE_PASSPHRASE"', {
            MONGO_KEYFILE_PASSPHRASE: passphrase, MONGO_KEYFILE_SALT: salt,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^[A-Za-z0-9+/]{43}=$/);
        return result.stdout;
    };
    const first = derive('audit-one', 'mongodb-flux-cluster-salt-one');
    assert.equal(first, 'NRaRlw3t39W6/uaN4YdPh+VxiEPSdzIBn5r/6R1cu+A=');
    assert.equal(first, derive('audit-one', 'mongodb-flux-cluster-salt-one'));
    assert.notEqual(first, derive('audit-two', 'mongodb-flux-cluster-salt-one'));
    assert.notEqual(first, derive('audit-one', 'mongodb-flux-cluster-salt-two'));
});

test('default salt is deterministic and special characters remain literal', () => {
    const passphrase = 'quotes" backslash\\ newline\n dollar$()';
    const result = shell('generate_keyfile_from_passphrase "$MONGO_KEYFILE_PASSPHRASE"', {
        MONGO_KEYFILE_PASSPHRASE: passphrase,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, pbkdf2Sync(passphrase, 'mongodb-flux-cluster-salt',
        600000, 32, 'sha256').toString('base64'));
});

test('fresh passphrase setup writes a valid key with mode 400', t => {
    const { dir, file } = fixture(t);
    const result = shell(setup, { KEYFILE_PATH: file, MONGO_KEYFILE_PASSPHRASE: 'audit-one' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(file).mode & 0o777, 0o400);
    assert.match(fs.readFileSync(file, 'utf8'), /^[A-Za-z0-9+/]{43}=$/);
    assert.deepEqual(fs.readdirSync(dir), ['keyfile']);
});

test('explicit content wins on a fresh volume and existing secure keys are preserved', t => {
    const { file } = fixture(t);
    const key = 'c2VjdXJlLXJhbmRvbS1rZXktZm9yLXRlc3Rpbmctb25seQ==';
    const env = { KEYFILE_PATH: file, MONGO_KEYFILE_CONTENT: key,
        MONGO_KEYFILE_PASSPHRASE: 'ignored' };
    assert.equal(shell(setup, env).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), key + '\n');
    assert.equal(shell(setup, { ...env, MONGO_KEYFILE_CONTENT: 'another-key' }).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), key + '\n');
});

test('rejects vulnerable existing keys, including whitespace and YAML rotation lists', t => {
    const { file } = fixture(t);
    for (const content of ['A'.repeat(756), 'A '.repeat(756),
        `- "${'A'.repeat(756)}"\n- c2VjdXJlLWtleQ==\n`, '', ' \n\t']) {
        fs.writeFileSync(file, content);
        const result = shell(setup, { KEYFILE_PATH: file, MONGO_KEYFILE_CONTENT: 'replacement' });
        assert.equal(result.status, 1, result.stderr);
        assert.equal(fs.readFileSync(file, 'utf8'), content);
    }
});

test('rejects insecure supplied content without leaving a keyfile', t => {
    const { dir, file } = fixture(t);
    for (const content of ['A'.repeat(756), 'A'.repeat(43) + '=', ' \n']) {
        assert.equal(shell(setup, { KEYFILE_PATH: file, MONGO_KEYFILE_CONTENT: content }).status, 1);
        assert.deepEqual(fs.readdirSync(dir), []);
    }
});

test('secure YAML rotation lists remain supported', t => {
    const { file } = fixture(t);
    const content = '- "c2VjdXJlLWtleS1vbmU="\n- "c2VjdXJlLWtleS10d28="';
    assert.equal(shell(setup, { KEYFILE_PATH: file, MONGO_KEYFILE_CONTENT: content }).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), content + '\n');
});

test('tool, permission and rename failures stop setup even in an if condition', t => {
    const { dir, file } = fixture(t);
    for (const fault of ['node() { return 127; }',
        'node() { printf partial-output; return 1; }',
        'chmod() { return 1; }', 'chown() { return 1; }', 'mv() { return 1; }']) {
        const result = shell(setup, { KEYFILE_PATH: file, MONGO_KEYFILE_PASSPHRASE: 'audit-one' }, fault);
        assert.equal(result.status, 1, fault + result.stderr);
        assert.deepEqual(fs.readdirSync(dir), []);
    }
});

test('missing Node.js fails closed for derivation and existing keyfiles', t => {
    const { dir, file } = fixture(t);
    const result = shell('generate_keyfile_from_passphrase audit-one', { PATH: dir });
    assert.equal(result.status, 1, result.stderr);
    fs.writeFileSync(file, 'c2VjdXJlLWtleQ==');
    assert.equal(shell(setup, { KEYFILE_PATH: file, PATH: dir }).status, 1);
});

test('constant KDF output is rejected', t => {
    const { dir, file } = fixture(t);
    const hook = path.join(dir, 'constant-kdf.cjs');
    fs.writeFileSync(hook, 'require("node:crypto").pbkdf2Sync = () => Buffer.alloc(32, 0);');
    const result = shell(setup, { KEYFILE_PATH: file,
        MONGO_KEYFILE_PASSPHRASE: 'audit-one', KEYFILE_CRYPTO_HOOK: hook },
        'node() { command node -r "$KEYFILE_CRYPTO_HOOK" "$@"; }');
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(fs.readdirSync(dir), ['constant-kdf.cjs']);
});

test('random fallback succeeds and OpenSSL failures stop setup', t => {
    const { dir, file } = fixture(t);
    const failed = shell(setup, { KEYFILE_PATH: file }, 'openssl() { printf partial-output; return 1; }');
    assert.equal(failed.status, 1, failed.stderr);
    assert.deepEqual(fs.readdirSync(dir), []);
    const result = shell(setup, { KEYFILE_PATH: file });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(file, 'utf8').replace(/\s/g, '').length, 1008);
});
