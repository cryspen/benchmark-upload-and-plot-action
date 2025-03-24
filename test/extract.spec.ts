import * as path from 'path';
import { strict as A } from 'assert';
import { Config } from '../src/config';
import { loadResult } from '../src/load';

const dummyWebhookPayload = {
    head_commit: {
        author: null,
        committer: null,
        id: '123456789abcdef',
        message: 'this is dummy',
        timestamp: 'dummy timestamp',
        url: 'https://github.com/dummy/repo',
    },
} as { [key: string]: any };
let dummyCommitData = {};
let lastCommitRequestData = {};
class DummyGitHub {
    rest = {
        repos: {
            getCommit: (data: any) => {
                lastCommitRequestData = data;
                return {
                    status: 200,
                    data: dummyCommitData,
                };
            },
        },
    };
}
const dummyGitHubContext = {
    payload: dummyWebhookPayload,
    repo: {
        owner: 'dummy',
        repo: 'repo',
    },
    ref: 'abcd1234',
};

jest.mock('@actions/github', () => ({
    get context() {
        return dummyGitHubContext;
    },
    getOctokit() {
        return new DummyGitHub();
    },
}));

describe('loadResult()', function () {
    afterAll(function () {
        jest.unmock('@actions/github');
    });

    afterEach(function () {
        dummyGitHubContext.payload = dummyWebhookPayload;
    });

    const normalCases: Array<{
        file: string;
    }> = [
        {
            file: 'customBiggerIsBetter_output.json',
        },
        {
            file: 'customSmallerIsBetter_output.json',
        },
    ];

    it.each(normalCases)(`extracts benchmark output from $file`, async function (test) {
        jest.useFakeTimers({
            now: 1712131503296,
        });
        const inputDataPath = path.join(__dirname, 'data', 'extract', test.file);
        const config = {
            inputDataPath,
        } as Config;
        const bench = await loadResult(config);

        expect(bench).toMatchSnapshot();

        jest.useRealTimers();
    });

    it('raises an error when output file is not readable', async function () {
        const config = {
            inputDataPath: 'path/does/not/exist.txt',
        } as Config;
        await A.rejects(loadResult(config));
    });

    it('raises an error when no output found', async function () {
        const config = {
            inputDataPath: path.join(__dirname, 'data', 'extract', 'invalid_output.txt'),
        } as Config;
        await A.rejects(loadResult(config), /^Error: No benchmark result was found in /);
    });

    it('collects the commit information from pull_request payload as fallback', async function () {
        dummyGitHubContext.payload = {
            pull_request: {
                title: 'this is title',
                html_url: 'https://github.com/dummy/repo/pull/1',
                head: {
                    sha: 'abcdef0123456789',
                    user: {
                        login: 'user',
                    },
                    repo: {
                        updated_at: 'repo updated at timestamp',
                    },
                },
            },
        };
        const inputDataPath = path.join(__dirname, 'data', 'extract', 'customBiggerIsBetter_output.json');
        const config = {
            inputDataPath,
        } as Config;
        const { commit } = await loadResult(config);
        const expectedUser = {
            name: 'user',
            username: 'user',
        };
        A.deepEqual(commit.author, expectedUser);
        A.deepEqual(commit.committer, expectedUser);
        A.equal(commit.id, 'abcdef0123456789');
        A.equal(commit.message, 'this is title');
        A.equal(commit.timestamp, 'repo updated at timestamp');
        A.equal(commit.url, 'https://github.com/dummy/repo/pull/1/commits/abcdef0123456789');
    });

    it('collects the commit information from specified ref via REST API as fallback when githubToken and ref provided', async function () {
        dummyGitHubContext.payload = {};
        dummyCommitData = {
            author: {
                login: 'testAuthorLogin',
            },
            committer: {
                login: 'testCommitterLogin',
            },
            commit: {
                author: {
                    name: 'test author',
                    date: 'author updated at timestamp',
                    email: 'author@testdummy.com',
                },
                committer: {
                    name: 'test committer',
                    // We use the `author.date` instead.
                    // date: 'committer updated at timestamp',
                    email: 'committer@testdummy.com',
                },
                message: 'test message',
            },
            sha: 'abcd1234',
            html_url: 'https://github.com/dymmy/repo/commit/abcd1234',
        };
        const inputDataPath = path.join(__dirname, 'data', 'extract', 'customBiggerIsBetter_output.json');
        const config = {
            inputDataPath,
            githubToken: 'abcd1234',
            ref: 'refs/pull/123/head',
        } as Config;

        const { commit } = await loadResult(config);

        const expectedCommit = {
            id: 'abcd1234',
            message: 'test message',
            timestamp: 'author updated at timestamp',
            url: 'https://github.com/dymmy/repo/commit/abcd1234',
            author: {
                name: 'test author',
                username: 'testAuthorLogin',
                email: 'author@testdummy.com',
            },
            committer: {
                name: 'test committer',
                username: 'testCommitterLogin',
                email: 'committer@testdummy.com',
            },
        };
        A.deepEqual(lastCommitRequestData, {
            owner: 'dummy',
            repo: 'repo',
            ref: 'refs/pull/123/head',
        });
        A.deepEqual(commit, expectedCommit);
    });

    it('collects the commit information from current head via REST API as fallback when githubToken is provided', async function () {
        dummyGitHubContext.payload = {};
        dummyCommitData = {
            author: {
                login: 'testAuthorLogin',
            },
            committer: {
                login: 'testCommitterLogin',
            },
            commit: {
                author: {
                    name: 'test author',
                    date: 'author updated at timestamp',
                    email: 'author@testdummy.com',
                },
                committer: {
                    name: 'test committer',
                    // We use the `author.date` instead.
                    // date: 'committer updated at timestamp',
                    email: 'committer@testdummy.com',
                },
                message: 'test message',
            },
            sha: 'abcd1235',
            html_url: 'https://github.com/dymmy/repo/commit/abcd1234',
        };
        const inputDataPath = path.join(__dirname, 'data', 'extract', 'customBiggerIsBetter_output.json');
        const config = {
            inputDataPath,
            githubToken: 'abcd1234',
        } as Config;

        const { commit } = await loadResult(config);

        const expectedCommit = {
            id: 'abcd1235',
            message: 'test message',
            timestamp: 'author updated at timestamp',
            url: 'https://github.com/dymmy/repo/commit/abcd1234',
            author: {
                name: 'test author',
                username: 'testAuthorLogin',
                email: 'author@testdummy.com',
            },
            committer: {
                name: 'test committer',
                username: 'testCommitterLogin',
                email: 'committer@testdummy.com',
            },
        };
        A.deepEqual(lastCommitRequestData, {
            owner: 'dummy',
            repo: 'repo',
            ref: 'abcd1234',
        });
        A.deepEqual(commit, expectedCommit);
    });

    it('raises an error when commit information is not found in webhook payload and no githubToken is provided', async function () {
        dummyGitHubContext.payload = {};
        const inputDataPath = path.join(__dirname, 'data', 'extract', 'customBiggerIsBetter_output.json');
        const config = {
            inputDataPath,
        } as Config;
        await A.rejects(loadResult(config), /^Error: No commit information is found in payload/);
    });
});
