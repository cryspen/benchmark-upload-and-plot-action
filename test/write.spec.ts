import * as path from 'path';
import { promises as fs } from 'fs';
import * as cheerio from 'cheerio';
import markdownit from 'markdown-it';
import rimraf from 'rimraf';
import { Config } from '../src/config';
import { Benchmark } from '../src/load';
import { DataJson, writeBenchmark } from '../src/write';
import { expect } from '@jest/globals';
import { FakedOctokit, fakedRepos } from './fakedOctokit';
import { wrapBodyWithBenchmarkTags } from '../src/comment/benchmarkCommentTags';

const ok: (x: any, msg?: string) => asserts x = (x, msg) => {
    try {
        expect(x).toBeTruthy();
    } catch (err) {
        if (msg) {
            throw Error(msg);
        }
        throw err;
    }
};

type GitFunc = 'cmd' | 'push' | 'pull' | 'fetch' | 'clone' | 'checkout';
class GitSpy {
    history: [GitFunc, unknown[]][];
    pushFailure: null | string;
    pushFailureCount: number;

    constructor() {
        this.history = [];
        this.pushFailure = null;
        this.pushFailureCount = 0;
    }

    call(func: GitFunc, args: unknown[]) {
        this.history.push([func, args]);
    }

    clear() {
        this.history = [];
        this.pushFailure = null;
        this.pushFailureCount = 0;
    }

    mayFailPush() {
        if (this.pushFailure !== null && this.pushFailureCount > 0) {
            --this.pushFailureCount;
            throw new Error(this.pushFailure);
        }
    }
}
const gitSpy = new GitSpy();

interface RepositoryPayloadSubset {
    private: boolean;
    html_url: string;
}

const gitHubContext = {
    repo: {
        repo: 'repo',
        owner: 'user',
    },
    payload: {
        repository: {
            private: false,
            html_url: 'https://github.com/user/repo',
        } as RepositoryPayloadSubset | null,
        before: null as any, // for push
        pull_request: null as any,
        number: null as number | null, // PR number
        merge_group: null as any,
    },
    workflow: 'Workflow name',
    ref: 'refs/heads/main', // TODO: set separately for pull request tests
};

enum PayloadType {
    Push = 1,
    PullRequest = 2,
    MergeGroup = 3,
}

function contextSetPush(context: any, sha_before: string) {
    context.payload.pull_request = null;
    context.payload.merge_group = null;
    context.payload.number = null;
    context.payload.before = sha_before;
    context.eventName = 'push';
}

function contextSetPullRequest(context: any, prNumber: number, ref: string, sha: string) {
    context.payload.before = null;
    context.payload.merge_group = null;
    context.payload.number = prNumber;
    context.payload.pull_request = { base: { ref, sha } };
    context.eventName = 'pull_request';
}
function contextSetMergeGroup(context: any, base_ref: string, base_sha: string) {
    context.payload.before = null;
    context.payload.pull_request = null;
    context.payload.number = null;
    context.payload.merge_group = { base_ref, base_sha };
    context.eventName = 'merge_group';
}

jest.mock('@actions/core', () => ({
    debug: () => {
        /* do nothing */
    },
    warning: () => {
        /* do nothing */
    },
}));
jest.mock('@actions/github', () => ({
    get context() {
        return gitHubContext;
    },
    getOctokit(token: string) {
        return new FakedOctokit(token);
    },
}));
jest.mock('../src/git', () => ({
    ...jest.requireActual('../src/git'),
    async cmd(...args: unknown[]) {
        gitSpy.call('cmd', args);
        return '';
    },
    async push(...args: unknown[]) {
        gitSpy.call('push', args);
        gitSpy.mayFailPush(); // For testing retry
        return '';
    },
    async pull(...args: unknown[]) {
        gitSpy.call('pull', args);
        return '';
    },
    async fetch(...args: unknown[]) {
        gitSpy.call('fetch', args);
        return '';
    },
    async clone(...args: unknown[]) {
        gitSpy.call('clone', args);
        return '';
    },
    async checkout(...args: unknown[]) {
        gitSpy.call('checkout', args);
        return '';
    },
}));

describe.each(['https://github.com', 'https://github.enterprise.corp'])('writeBenchmark() - %s', function (serverUrl) {
    const savedCwd = process.cwd();

    beforeAll(function () {
        process.chdir(path.join(__dirname, 'data', 'write'));
    });

    afterAll(function () {
        jest.unmock('@actions/core');
        jest.unmock('@actions/github');
        jest.unmock('../src/git');
        process.chdir(savedCwd);
    });

    afterEach(function () {
        fakedRepos.clear();
    });

    // Utilities for test data
    const lastUpdate = Date.now() - 10000;
    const user = {
        email: 'dummy@example.com',
        name: 'User',
        username: 'user',
    };
    const repoUrl = `${serverUrl}/user/repo`;

    function commit(id = 'commit id', message = 'dummy message', u = user) {
        return {
            author: u,
            committer: u,
            distinct: false,
            id,
            message,
            timestamp: 'dummy stamp',
            tree_id: 'dummy tree id',
            url: `${serverUrl}/user/repo/commit/` + id,
        };
    }

    function bench(
        name: string,
        value: number,
        range = '± 20',
        unit = 'ns/iter',
        os = 'ubuntu-latest',
        platform = undefined,
        api = undefined,
        keySize = undefined,
        category = undefined,
    ) {
        const entry = {
            name,
            range,
            unit,
            os,
            value,
            platform,
            api,
            keySize,
            category,
        };

        // remove undefined fields
        return JSON.parse(JSON.stringify(entry));
    }

    describe('with external json file', function () {
        const dataJson = 'data.json';
        const defaultCfg: Config = {
            basePath: 'data-dir',
            groupBy: ['os'],
            schema: ['name', 'platform', 'os', 'keySize', 'api', 'category'],
            name: 'Test benchmark',
            biggerIsBetter: false,
            inputDataPath: 'dummy', // Should not affect
            ghPagesBranch: 'dummy', // Should not affect
            ghRepository: undefined,
            githubToken: undefined,
            autoPush: false,
            skipFetchGhPages: false, // Should not affect
            summaryAlways: false,
            commentAlways: false,
            saveDataFile: true,
            commentOnAlert: false,
            alertThreshold: 2.0,
            failOnAlert: true,
            alertCommentCcUsers: ['@user'],
            externalDataJsonPath: dataJson,
            maxItemsInChart: null,
            failThreshold: 2.0,
            ref: undefined,
        };

        const savedRepository = {
            private: false,
            html_url: `${serverUrl}/user/repo`,
        } as RepositoryPayloadSubset | null;

        afterEach(async function () {
            try {
                await fs.unlink(dataJson);
            } catch (_) {
                // Ignore
            }
            gitHubContext.payload.repository = savedRepository;
        });

        const md2html = markdownit();

        const normalCases: Array<{
            it: string;
            config: Config;
            data: DataJson | null;
            added: Benchmark;
            error?: string[];
            commitComment?: string;
            repoPayload?: null | RepositoryPayloadSubset;
            gitServerUrl?: string;
        }> = [
            {
                it: 'appends new result to existing data',
                config: defaultCfg,
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
            },
            {
                it: 'creates new data file',
                config: defaultCfg,
                data: null,
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
            },
            {
                it: 'creates new result suite to existing data file',
                config: defaultCfg,
                data: {
                    groupBy: { 'Other benchmark': ['os'] },
                    schema: { 'Other benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Other benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 10)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
            },
            {
                it: 'appends new result to existing multiple benchmarks data',
                config: defaultCfg,
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100)],
                                bigger_is_better: false,
                            },
                        ],
                        'Other benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 10)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
            },
            {
                it: 'raises an alert when exceeding threshold 2.0',
                config: defaultCfg,
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100), bench('bench_fib_20', 10000)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210), bench('bench_fib_20', 25000)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                error: [
                    '# :warning: **Performance Alert** :warning:',
                    '',
                    "Possible performance regression was detected for benchmark **'Test benchmark'**.",
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `2`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `bench_fib_10` | `210` ns/iter (`± 20`) | `100` ns/iter (`± 20`) | `2.10` |',
                    '| `bench_fib_20` | `25000` ns/iter (`± 20`) | `10000` ns/iter (`± 20`) | `2.50` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                    '',
                    'CC: @user',
                ],
            },
            {
                it: 'raises an alert with tool whose result value is bigger-is-better',
                config: defaultCfg,
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('benchFib10', 100, '+-20', 'ops/sec')],
                                bigger_is_better: true,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('benchFib10', 20, '+-20', 'ops/sec')], // ops/sec so bigger is better
                    bigger_is_better: true,
                },
                error: [
                    '# :warning: **Performance Alert** :warning:',
                    '',
                    "Possible performance regression was detected for benchmark **'Test benchmark'**.",
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `2`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `benchFib10` | `20` ops/sec (`+-20`) | `100` ops/sec (`+-20`) | `5` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                    '',
                    'CC: @user',
                ],
            },
            {
                it: 'raises an alert without benchmark name with default benchmark name',
                config: { ...defaultCfg, name: 'Benchmark' },
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        Benchmark: [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                error: [
                    '# :warning: **Performance Alert** :warning:',
                    '',
                    'Possible performance regression was detected for benchmark.',
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `2`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `bench_fib_10` | `210` ns/iter (`± 20`) | `100` ns/iter (`± 20`) | `2.10` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                    '',
                    'CC: @user',
                ],
            },
            {
                it: 'raises an alert without CC names',
                config: { ...defaultCfg, alertCommentCcUsers: [] },
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                error: [
                    '# :warning: **Performance Alert** :warning:',
                    '',
                    "Possible performance regression was detected for benchmark **'Test benchmark'**.",
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `2`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `bench_fib_10` | `210` ns/iter (`± 20`) | `100` ns/iter (`± 20`) | `2.10` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                ],
            },
            {
                it: 'sends commit comment on alert with GitHub API',
                config: { ...defaultCfg, commentOnAlert: true, githubToken: 'dummy token' },
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                commitComment: 'Comment was generated at https://dummy-comment-url',
            },
            {
                it: 'does not raise an alert when both comment-on-alert and fail-on-alert are disabled',
                config: { ...defaultCfg, commentOnAlert: false, failOnAlert: false },
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                error: undefined,
                commitComment: undefined,
            },
            {
                it: 'ignores other bench case on detecting alerts',
                config: defaultCfg,
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('another_bench', 100)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                error: undefined,
                commitComment: undefined,
            },
            {
                it: 'throws an error when GitHub token is not set (though this case should not happen in favor of validation)',
                config: { ...defaultCfg, commentOnAlert: true },
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                error: ["'comment-on-alert' input is set but 'github-token' input is not set"],
                commitComment: undefined,
            },
            {
                it: 'truncates data items if it exceeds max-items-in-chart',
                config: { ...defaultCfg, maxItemsInChart: 1 },
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100), bench('bench_fib_20', 10000)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210), bench('bench_fib_20', 25000)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                // Though first item is truncated due to maxItemsInChart, alert still can be raised since previous data
                // is obtained before truncating an array of data items.
                error: [
                    '# :warning: **Performance Alert** :warning:',
                    '',
                    "Possible performance regression was detected for benchmark **'Test benchmark'**.",
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `2`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `bench_fib_10` | `210` ns/iter (`± 20`) | `100` ns/iter (`± 20`) | `2.10` |',
                    '| `bench_fib_20` | `25000` ns/iter (`± 20`) | `10000` ns/iter (`± 20`) | `2.50` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                    '',
                    'CC: @user',
                ],
            },
            {
                it: 'changes title when threshold is zero which means comment always happens',
                config: { ...defaultCfg, alertThreshold: 0, failThreshold: 0 },
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('benchFib10', 100, '+-20', 'ops/sec')],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('benchFib10', 100, '+-20', 'ops/sec')],
                    bigger_is_better: false,
                },
                error: [
                    '# Performance Report',
                    '',
                    "Possible performance regression was detected for benchmark **'Test benchmark'**.",
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `0`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `benchFib10` | `100` ops/sec (`+-20`) | `100` ops/sec (`+-20`) | `1` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                    '',
                    'CC: @user',
                ],
            },
            {
                it: 'raises an alert with different failure threshold from alert threshold',
                config: { ...defaultCfg, failThreshold: 3 },
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 350)], // Exceeds 3.0 failure threshold
                    bigger_is_better: false,
                },
                error: [
                    '1 of 1 alerts exceeded the failure threshold `3` specified by fail-threshold input:',
                    '',
                    '# :warning: **Performance Alert** :warning:',
                    '',
                    "Possible performance regression was detected for benchmark **'Test benchmark'**.",
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `2`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `bench_fib_10` | `350` ns/iter (`± 20`) | `100` ns/iter (`± 20`) | `3.50` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                    '',
                    'CC: @user',
                ],
            },
            {
                it: 'does not raise an alert when not exceeding failure threshold',
                config: { ...defaultCfg, failThreshold: 3 },
                data: {
                    groupBy: { 'Test benchmark': ['os'] },
                    schema: { 'Test benchmark': ['name', 'platform', 'os', 'keySize', 'api', 'category'] },
                    lastUpdate,
                    repoUrl,
                    entries: {
                        'Test benchmark': [
                            {
                                commit: commit('prev commit id'),
                                date: lastUpdate - 1000,
                                benches: [bench('bench_fib_10', 100)],
                                bigger_is_better: false,
                            },
                        ],
                    },
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                error: undefined,
            },
        ];

        it.each(normalCases)('$it', async function (t) {
            gitHubContext.payload.repository = {
                private: false,
                html_url: `${serverUrl}/user/repo`,
            } as RepositoryPayloadSubset | null;

            if (t.repoPayload !== undefined) {
                gitHubContext.payload.repository = t.repoPayload;
            }
            if (t.data !== null) {
                await fs.writeFile(dataJson, JSON.stringify(t.data), 'utf8');
            }

            let caughtError: Error | null = null;
            try {
                await writeBenchmark(t.added, t.config);
            } catch (err: any) {
                if (!t.error && !t.commitComment) {
                    throw err;
                }
                caughtError = err;
            }

            const json: DataJson = JSON.parse(await fs.readFile(dataJson, 'utf8'));

            expect('number').toEqual(typeof json.lastUpdate);
            expect(json.entries[t.config.name]).toBeTruthy();
            const len = json.entries[t.config.name].length;
            ok(len > 0);
            expect(t.added).toEqual(json.entries[t.config.name][len - 1]); // Check last item is the newest

            if (t.data !== null) {
                ok(json.lastUpdate > t.data.lastUpdate);
                expect(t.data.repoUrl).toEqual(json.repoUrl);
                for (const name of Object.keys(t.data.entries)) {
                    const entries = t.data.entries[name];
                    if (name === t.config.name) {
                        if (t.config.maxItemsInChart === null || len < t.config.maxItemsInChart) {
                            expect(entries.length + 1).toEqual(len);
                            // Check benchmark data except for the last appended one are not modified
                            expect(entries).toEqual(json.entries[name].slice(0, -1));
                        } else {
                            // When data items was truncated due to max-items-in-chart
                            expect(entries.length).toEqual(len); // Number of items did not change because first item was shifted
                            expect(entries.slice(1)).toEqual(json.entries[name].slice(0, -1));
                        }
                    } else {
                        expect(entries).toEqual(json.entries[name]); // eq(json.entries[name], entries, name);
                    }
                }
            }

            if (t.error && t.error !== null) {
                ok(caughtError);
                const expected = t.error.join('\n');
                expect(caughtError.message).toEqual(expected);
            }

            if (t.commitComment !== undefined) {
                ok(caughtError);
                // Last line is appended only for failure message
                const messageLines = caughtError.message.split('\n');
                ok(messageLines.length > 0);
                const expectedMessage = wrapBodyWithBenchmarkTags(
                    'Test benchmark Alert',
                    messageLines.slice(0, -1).join('\n'),
                );
                ok(fakedRepos.spyOpts.length > 0, `len: ${fakedRepos.spyOpts.length}, caught: ${caughtError.message}`);
                const opts = fakedRepos.lastCall();
                expect('user').toEqual(opts.owner);
                expect('repo').toEqual(opts.repo);
                expect('current commit id').toEqual(opts.commit_sha);
                expect(expectedMessage).toEqual(opts.body);
                const commentLine = messageLines[messageLines.length - 1];
                expect(t.commitComment).toEqual(commentLine);

                // Check the body is a correct markdown document by markdown parser
                // Validate markdown content via HTML
                // TODO: Use Markdown AST instead of DOM API
                const html = md2html.render(opts.body);
                const query = cheerio.load(html);

                const h1 = query('h1');
                expect(1).toEqual(h1.length);
                expect(':warning: Performance Alert :warning:').toEqual(h1.text());

                const tr = query('tbody tr');
                expect(t.added.benches.length).toEqual(tr.length);

                const a = query('a');
                expect(2).toEqual(a.length);

                const workflowLink = a.first();
                expect('workflow').toEqual(workflowLink.text());
                const workflowUrl = workflowLink.attr('href');
                ok(workflowUrl?.startsWith(json.repoUrl), workflowUrl);

                const actionLink = a.last();
                expect('github-action-benchmark').toEqual(actionLink.text());
                expect('https://github.com/marketplace/actions/continuous-benchmark').toEqual(actionLink.attr('href'));
            }
        });
    });

    // Tests for updating GitHub Pages branch
    describe('with gh-pages branch', function () {
        beforeEach(async function () {
            // reset the context
            contextSetPush(gitHubContext, 'prev commit id');
            (global as any).window = {}; // Fake window object on browser
        });
        afterEach(async function () {
            // reset the context
            contextSetPush(gitHubContext, 'prev commit id');
            gitSpy.clear();
            delete (global as any).window;
            for (const p of [
                path.join('data-dir', 'refs'),
                path.join('data-dir', 'pr', '10.json'),
                path.join('data-dir', 'index.html'),
                path.join('data-dir', 'listing.json'),
                'new-data-dir',
                path.join('with-index-html', 'refs'),
                path.join('with-index-html', 'pr'),
                path.join('with-index-html', 'listing.json'),
                path.join('with-index-html', 'data.json'),
                path.join('benchmark-data-repository', 'data-dir', 'data.json'),
                path.join('benchmark-data-repository', 'data-dir', 'listing.json'),
                path.join('benchmark-data-repository', 'data-dir', 'refs'),
                path.join('benchmark-data-repository', 'data-dir', 'index.html'),
                path.join('benchmark-data-repository', 'new-data-dir'),
                path.join('benchmark-data-repository', 'refs'),
                path.join('benchmark-data-repository', 'pr'),
                path.join('benchmark-data-repository', 'listing.json'),
                path.join('benchmark-data-repository', 'index.html'),
            ]) {
                // Ignore exception
                await new Promise((resolve) => rimraf(p, resolve));
            }
        });

        async function isFile(p: string) {
            try {
                const s = await fs.stat(p);
                return s.isFile();
            } catch (_) {
                return false;
            }
        }

        async function isDir(p: string) {
            try {
                const s = await fs.stat(p);
                return s.isDirectory();
            } catch (_) {
                return false;
            }
        }

        async function loadDataJson(dataJs: string, serverUrl: string) {
            if (!(await isFile(dataJs))) {
                return null;
            }
            let dataSource = await fs.readFile(dataJs, 'utf8');
            if (serverUrl !== 'https://github.com') {
                dataSource = dataSource.replace(/https:\/\/github.com/gm, serverUrl);
            }

            const dataJson = JSON.parse(dataSource);

            return dataJson as DataJson;
        }

        const defaultCfg: Config = {
            basePath: 'data-dir',
            groupBy: ['os'],
            schema: ['name', 'platform', 'os', 'keySize', 'api', 'category'],
            name: 'Test benchmark',
            biggerIsBetter: false,
            inputDataPath: 'dummy', // Should not affect
            ghPagesBranch: 'gh-pages',
            ghRepository: undefined,
            githubToken: 'dummy token',
            autoPush: true,
            skipFetchGhPages: false, // Should not affect
            commentAlways: false,
            summaryAlways: false,
            saveDataFile: true,
            commentOnAlert: false,
            alertThreshold: 2.0,
            failOnAlert: true,
            alertCommentCcUsers: [],
            externalDataJsonPath: undefined,
            maxItemsInChart: null,
            failThreshold: 2.0,
            ref: undefined,
        };

        function gitHistory(
            cfg: {
                dataPath?: string;
                baseDir?: string;
                addIndexHtml?: boolean;
                autoPush?: boolean;
                token?: string | undefined;
                fetch?: boolean;
                skipFetch?: boolean;
                payloadType?: PayloadType;
            } = {},
        ): [GitFunc, unknown[]][] {
            const baseDir = cfg.baseDir ?? 'data-dir';
            const dataPathRelative = cfg.dataPath ?? path.join('refs', 'heads', 'main.json');
            const dataPath = path.join(baseDir, dataPathRelative);
            const listingPath = path.join(baseDir, 'listing.json');
            const indexHtmlPath = path.join(baseDir, 'index.html');
            const token = 'token' in cfg ? cfg.token : 'dummy token';
            const fetch = cfg.fetch ?? true;
            const addIndexHtml = cfg.addIndexHtml ?? true;
            const addListing = dataPath ?? false;
            const autoPush = cfg.autoPush ?? true;
            const skipFetch = cfg.skipFetch ?? false;
            const payloadType = cfg.payloadType ?? PayloadType.Push;

            let hist: Array<[GitFunc, unknown[]] | undefined>;

            if (payloadType === PayloadType.MergeGroup) {
                hist = [
                    skipFetch ? undefined : ['fetch', [token, 'gh-pages']],
                    ['cmd', [[], 'switch', 'gh-pages']],
                    fetch ? ['pull', [token, 'gh-pages']] : undefined,
                    ['cmd', [[], 'checkout', '-']], // Return from gh-pages
                ];
            } else {
                hist = [
                    skipFetch ? undefined : ['fetch', [token, 'gh-pages']],
                    ['cmd', [[], 'switch', 'gh-pages']],
                    fetch ? ['pull', [token, 'gh-pages']] : undefined,
                    addListing ? ['cmd', [[], 'add', listingPath]] : undefined,
                    dataPath ? ['cmd', [[], 'add', dataPath]] : undefined,
                    addIndexHtml ? ['cmd', [[], 'add', indexHtmlPath]] : undefined,
                    ['cmd', [[], 'commit', '-m', 'add Test benchmark benchmark result for current commit id']],
                    autoPush ? ['push', [token, undefined, 'gh-pages', []]] : undefined,
                    ['cmd', [[], 'checkout', '-']], // Return from gh-pages
                ];
            }
            return hist.filter((x: [GitFunc, unknown[]] | undefined): x is [GitFunc, unknown[]] => x !== undefined);
        }

        const normalCasesWithPayloadType: Array<{
            it: string;
            config: Config;
            added: Benchmark;
            gitServerUrl: string;
            gitHistory: [GitFunc, unknown[]][];
            privateRepo?: boolean;
            error?: string[];
            expectedDataBaseDirectory?: string;
            payloadType?: PayloadType;
        }> = [
            {
                it: 'appends new data',
                config: { ...defaultCfg },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory(),
            },
            {
                it: 'creates new data file',
                config: { ...defaultCfg },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory({ dataPath: 'refs/heads/main.json' }),
            },
            {
                it: 'appends new data in other repository',
                config: {
                    ...defaultCfg,
                    ghRepository: 'https://github.com/user/other-repo',
                    basePath: 'data-dir',
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: [
                    ['clone', ['dummy token', 'https://github.com/user/other-repo', './benchmark-data-repository']],
                    [
                        'checkout',
                        [
                            'gh-pages',
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                        ],
                    ],
                    [
                        'cmd',
                        [
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                            'add',
                            path.join('data-dir', 'listing.json'),
                        ],
                    ],
                    [
                        'cmd',
                        [
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                            'add',
                            path.join('data-dir', 'refs/heads/main.json'),
                        ],
                    ],
                    [
                        'cmd',
                        [
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                            'add',
                            path.join('data-dir', 'index.html'),
                        ],
                    ],
                    [
                        'cmd',
                        [
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                            'commit',
                            '-m',
                            'add Test benchmark benchmark result for current commit id',
                        ],
                    ],
                    [
                        'push',
                        [
                            'dummy token',
                            'https://github.com/user/other-repo',
                            'gh-pages',
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                        ],
                    ],
                ],
                expectedDataBaseDirectory: 'benchmark-data-repository',
            },
            {
                it: 'creates new data file in other repository',
                config: {
                    ...defaultCfg,
                    ghRepository: 'https://github.com/user/other-repo',
                    basePath: './',
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: [
                    ['clone', ['dummy token', 'https://github.com/user/other-repo', './benchmark-data-repository']],
                    [
                        'checkout',
                        [
                            'gh-pages',
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                        ],
                    ],
                    [
                        'cmd',
                        [
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                            'add',
                            'listing.json',
                        ],
                    ],
                    [
                        'cmd',
                        [
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                            'add',
                            path.join('refs', 'heads', 'main.json'),
                        ],
                    ],
                    [
                        'cmd',
                        [
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                            'add',
                            'index.html',
                        ],
                    ],
                    [
                        'cmd',
                        [
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                            'commit',
                            '-m',
                            'add Test benchmark benchmark result for current commit id',
                        ],
                    ],
                    [
                        'push',
                        [
                            'dummy token',
                            'https://github.com/user/other-repo',
                            'gh-pages',
                            ['--work-tree=./benchmark-data-repository', '--git-dir=./benchmark-data-repository/.git'],
                        ],
                    ],
                ],
                expectedDataBaseDirectory: 'benchmark-data-repository',
            },
            {
                it: 'creates new suite in data',
                config: defaultCfg,
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('other_bench_foo', 100)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory(),
            },
            {
                it: 'does not create index.html if it already exists',
                config: { ...defaultCfg, basePath: 'with-index-html' },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 100)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory({ addIndexHtml: false, baseDir: 'with-index-html' }),
                expectedDataBaseDirectory: './',
            },
            {
                it: 'does not push to remote when auto-push is off',
                config: { ...defaultCfg, autoPush: false },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory({ autoPush: false }),
            },
            {
                it: 'does not push to remote when auto-push is off without token',
                config: { ...defaultCfg, autoPush: false, githubToken: undefined },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory({ autoPush: false, token: undefined }),
            },
            {
                it: 'does not fetch remote when github-token is not set for private repo',
                config: { ...defaultCfg, autoPush: false, githubToken: undefined },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory({ autoPush: false, token: undefined, fetch: false }),
                privateRepo: true,
            },
            {
                it: 'does not fetch remote when skip-fetch-gh-pages is enabled',
                config: { ...defaultCfg, skipFetchGhPages: true },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory({ fetch: false, skipFetch: true }),
            },
            {
                it: 'fails when exceeding the threshold',
                config: defaultCfg,
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory(),
                error: [
                    '# :warning: **Performance Alert** :warning:',
                    '',
                    "Possible performance regression was detected for benchmark **'Test benchmark'**.",
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `2`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `bench_fib_10` | `210` ns/iter (`± 20`) | `100` ns/iter (`± 20`) | `2.10` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                ],
            },
            {
                it: 'sends commit message but does not raise an error when exceeding alert threshold but not exceeding failure threshold',
                config: {
                    ...defaultCfg,
                    commentOnAlert: true,
                    githubToken: 'dummy token',
                    alertThreshold: 2,
                    failThreshold: 3,
                },
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 210)], // Exceeds 2.0 threshold but not exceed 3.0 threshold
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory(),
                error: undefined,
            },
            {
                it: 'does not write data for merge group event',
                config: defaultCfg,
                payloadType: PayloadType.MergeGroup,
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory({ payloadType: PayloadType.MergeGroup }),
            },
            {
                it: 'raises an alert when exceeding threshold 2.0 for different units',
                config: defaultCfg,
                payloadType: PayloadType.MergeGroup,
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [
                        bench('bench_fib_10', 500.0 / 1_000_000.0, undefined, 'ms/iter'),
                        bench('bench_fib_20', 25000),
                    ], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory(),
                error: [
                    '# :warning: **Performance Alert** :warning:',
                    '',
                    "Possible performance regression was detected for benchmark **'Test benchmark'**.",
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `2`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `bench_fib_10` | `0.0005` ms/iter (`± 20`) | `100` ns/iter (`± 20`) | `5` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                ],
            },
            {
                it: 'raises an alert when exceeding threshold 2.0 for merge group event',
                config: defaultCfg,
                payloadType: PayloadType.MergeGroup,
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 500), bench('bench_fib_20', 25000)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory(),
                error: [
                    '# :warning: **Performance Alert** :warning:',
                    '',
                    "Possible performance regression was detected for benchmark **'Test benchmark'**.",
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `2`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `bench_fib_10` | `500` ns/iter (`± 20`) | `100` ns/iter (`± 20`) | `5` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                ],
            },
            {
                it: 'raises an alert when exceeding threshold 2.0 for pull request event',
                config: defaultCfg,
                payloadType: PayloadType.PullRequest,
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 500), bench('bench_fib_20', 25000)], // Exceeds 2.0 threshold
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory(),
                error: [
                    '# :warning: **Performance Alert** :warning:',
                    '',
                    "Possible performance regression was detected for benchmark **'Test benchmark'**.",
                    'Benchmark result of this commit is worse than the previous benchmark result exceeding threshold `2`.',
                    '',
                    '| Benchmark suite | Current: current commit id | Previous: prev commit id | Ratio |',
                    '|-|-|-|-|',
                    '| `bench_fib_10` | `500` ns/iter (`± 20`) | `100` ns/iter (`± 20`) | `5` |',
                    '',
                    `This comment was automatically generated by [workflow](${serverUrl}/user/repo/actions?query=workflow%3AWorkflow%20name) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`,
                ],
            },
            {
                it: 'writes data for pull request event',
                config: defaultCfg,
                payloadType: PayloadType.PullRequest,
                added: {
                    commit: commit('current commit id'),
                    date: lastUpdate,
                    benches: [bench('bench_fib_10', 135)],
                    bigger_is_better: false,
                },
                gitServerUrl: serverUrl,
                gitHistory: gitHistory({ payloadType: PayloadType.PullRequest, dataPath: 'pr/10.json' }),
            },
        ];
        for (const t of normalCasesWithPayloadType) {
            // FIXME: can't use `it.each` currently as tests running in parallel interfere with each other
            it(t.it, async function () {
                const dataJsRelative = path.join('refs', 'heads', 'main.json');
                if (t.payloadType === PayloadType.PullRequest) {
                    contextSetPullRequest(gitHubContext, 10, 'main', 'prev commit id');
                } else if (t.payloadType === PayloadType.MergeGroup) {
                    contextSetMergeGroup(gitHubContext, 'refs/heads/main', 'prev commit id');
                } else {
                    contextSetPush(gitHubContext, 'prev commit id');
                }
                if (t.privateRepo) {
                    gitHubContext.payload.repository = gitHubContext.payload.repository
                        ? { ...gitHubContext.payload.repository, private: true }
                        : null;
                }
                const dataDirPath = path.join(t.expectedDataBaseDirectory ?? '', t.config.basePath);
                ok(dataJsRelative);
                const dataJs = path.join(dataDirPath, dataJsRelative);
                const originalDataJson = path.join(dataDirPath, 'original_data.json');
                const indexHtml = path.join(dataDirPath, 'index.html');

                if (await isFile(originalDataJson)) {
                    await fs.mkdir(path.dirname(dataJs), { recursive: true });
                    await fs.copyFile(originalDataJson, dataJs);
                }

                // copy pull request data
                let dataJsonPr;
                let prDataBefore;
                if (t.payloadType === PayloadType.PullRequest) {
                    const originalDataJsonPr = path.join(dataDirPath, 'pr', 'original_data.json');
                    dataJsonPr = path.join(dataDirPath, 'pr', '10.json');
                    await fs.mkdir(path.dirname(originalDataJsonPr), { recursive: true });
                    await fs.copyFile(originalDataJsonPr, dataJsonPr);

                    prDataBefore = await loadDataJson(dataJsonPr, t.gitServerUrl);
                    ok(prDataBefore);
                }

                let indexHtmlBefore = null;
                try {
                    indexHtmlBefore = await fs.readFile(indexHtml);
                } catch (_) {
                    // Ignore
                }

                let caughtError: Error | null = null;
                const beforeData = await loadDataJson(dataJs, t.gitServerUrl);
                const lenBefore = beforeData?.entries[t.config.name].length ?? 0;
                const beforeDate = Date.now();
                try {
                    await writeBenchmark(t.added, t.config);
                } catch (err: any) {
                    if (t.error === undefined) {
                        throw err;
                    }
                    caughtError = err;
                }

                if (t.error) {
                    ok(caughtError);
                    const expected = t.error.join('\n');
                    expect(caughtError.message).toEqual(expected);
                    return;
                }

                // Post condition checks for success cases

                const afterDate = Date.now();

                ok(await isDir(dataDirPath));
                if (t.payloadType !== PayloadType.MergeGroup) {
                    ok(await isFile(path.join(dataDirPath, 'index.html')));
                }

                expect(gitSpy.history).toEqual(t.gitHistory);

                ok(await isFile(dataJs));
                const data = await loadDataJson(dataJs, t.gitServerUrl);
                ok(data);

                expect('number').toEqual(typeof data.lastUpdate);
                if (t.payloadType === PayloadType.Push) {
                    ok(
                        beforeDate <= data.lastUpdate && data.lastUpdate <= afterDate,
                        `Should be ${beforeDate} <= ${data.lastUpdate} <= ${afterDate}`,
                    );
                }
                ok(data.entries[t.config.name]);
                const lenAfter = data.entries[t.config.name].length;
                ok(lenAfter > 0);
                if (t.payloadType === PayloadType.Push) {
                    expect(t.added).toEqual(data.entries[t.config.name][lenAfter - 1]); // Check last item is the newest
                } else if (t.payloadType === PayloadType.MergeGroup) {
                    expect(lenBefore).toEqual(lenAfter);
                }

                if (beforeData !== null) {
                    expect(data.repoUrl).toEqual(beforeData.repoUrl);
                    for (const name of Object.keys(beforeData.entries)) {
                        if (name === t.config.name) {
                            if (t.payloadType === PayloadType.Push) {
                                expect(data.entries[name].slice(0, -1)).toEqual(beforeData.entries[name]); // New data was appended
                            }
                        } else {
                            expect(data.entries[name]).toEqual(beforeData.entries[name]);
                        }
                    }
                }

                if (indexHtmlBefore !== null) {
                    const indexHtmlAfter = await fs.readFile(indexHtml);
                    expect(indexHtmlAfter).toEqual(indexHtmlBefore); // If index.html is already existing, do not touch it
                }

                // check PR data
                if (t.payloadType === PayloadType.PullRequest) {
                    ok(dataJsonPr);
                    ok(prDataBefore);
                    const prDataAfter = await loadDataJson(dataJsonPr, t.gitServerUrl);
                    ok(prDataAfter);
                    for (const name of Object.keys(prDataBefore.entries)) {
                        if (name === t.config.name) {
                            expect(prDataAfter.entries[name].slice(0, -1)).toEqual(prDataBefore.entries[name]); // New data was appended
                        }
                    }
                    const lenAfter = prDataAfter.entries[t.config.name].length;
                    ok(lenAfter > 0);
                    expect(t.added).toEqual(prDataAfter.entries[t.config.name][lenAfter - 1]); // Check last item is the newest
                }
            });
        }

        const maxRetries = 10;
        const retryCases: Array<{
            it: string;
            error?: RegExp;
            pushErrorMessage: string;
            pushErrorCount: number;
        }> = [
            ...[1, 2].map((retries) => ({
                it: `updates data successfully after ${retries} retries`,
                pushErrorMessage: '... [remote rejected] ...',
                pushErrorCount: retries,
            })),
            {
                it: `gives up updating data after ${maxRetries} retries with an error`,
                pushErrorMessage: '... [remote rejected] ...',
                pushErrorCount: maxRetries,
                error: /Auto-push failed 3 times since the remote branch gh-pages rejected pushing all the time/,
            },
            {
                it: `gives up updating data after ${maxRetries} retries with an error containing "[rejected]" in message`,
                pushErrorMessage: '... [rejected] ...',
                pushErrorCount: maxRetries,
                error: /Auto-push failed 3 times since the remote branch gh-pages rejected pushing all the time/,
            },
            {
                it: 'handles an unexpected error without retry',
                pushErrorMessage: 'Some fatal error',
                pushErrorCount: 1,
                error: /Some fatal error/,
            },
        ];

        it.each(retryCases)('$it', async function (t) {
            // update the payload type
            contextSetPush(gitHubContext, 'prev commit id');

            gitSpy.pushFailure = t.pushErrorMessage;
            gitSpy.pushFailureCount = t.pushErrorCount;
            const config = { ...defaultCfg, basePath: 'with-index-html' };
            const added: Benchmark = {
                commit: commit('current commit id'),
                date: lastUpdate,
                benches: [bench('bench_fib_10', 110)],
                bigger_is_better: false,
            };

            const originalDataJs = path.join(config.basePath, 'original_data.json');
            const dataJs = path.join(config.basePath, 'refs', 'heads', 'main.json');
            await fs.mkdir(path.join(config.basePath, 'refs', 'heads'), { recursive: true });
            await fs.copyFile(originalDataJs, dataJs);

            const history = gitHistory({
                addIndexHtml: false,
                dataPath: 'refs/heads/main.json',
                baseDir: 'with-index-html',
            });
            if (t.pushErrorCount > 0) {
                // First 2 commands are fetch and switch. They are not repeated on retry
                const retryHistory = history.slice(2, -1);
                retryHistory.push(['cmd', [[], 'reset', '--hard', 'HEAD~1']]);

                const retries = Math.min(t.pushErrorCount, maxRetries);
                for (let i = 0; i < retries; i++) {
                    history.splice(2, 0, ...retryHistory);
                }
            }

            try {
                await writeBenchmark(added, config);
                expect(gitSpy.history).toEqual(history);
            } catch (err: any) {
                if (t.error === undefined) {
                    throw err;
                }
                ok(t.error.test(err.message), `'${err.message}' did not match to ${t.error}`);
            }
        });
    });
});
