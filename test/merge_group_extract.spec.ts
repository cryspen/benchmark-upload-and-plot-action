import * as path from 'path';
import { strict as A } from 'assert';
import { Config } from '../src/config';
import { loadResult } from '../src/load';

// merge_group payload
const dummyWebhookPayload = {
    merge_group: {
        organization: 'dummy',
        repository: 'repo',
        head_commit: {
            id: 'abcdef0123456789',
            tree_id: 'tree_id',
            message: 'message',
            timestamp: 'timestamp',
            author: { name: 'author', email: 'author' },
            committer: { name: 'committer', email: 'committer' },
        },
    },
} as { [key: string]: any };
const dummyCommitData = {};
class DummyGitHub {
    rest = {
        repos: {
            getCommit: (_data: any) => {
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
        owner: 'owner',
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
        {
            file: 'fullMetadata_output.json',
        },
    ];

    it.each(normalCases)(`extracts benchmark output from $file`, async function (test) {
        jest.useFakeTimers({
            now: 1712131503296,
        });
        const inputDataPath = path.join(__dirname, 'data', 'extract', test.file);
        const config = {
            schema: ['name', 'platform', 'os', 'keySize', 'api', 'category'],
            inputDataPath,
        } as Config;
        const bench = await loadResult(config);

        expect(bench).toMatchSnapshot();

        jest.useRealTimers();
    });

    it('collects the commit information from merge_group payload', async function () {
        dummyGitHubContext.payload = dummyWebhookPayload;
        const inputDataPath = path.join(__dirname, 'data', 'extract', 'customBiggerIsBetter_output.json');
        const config = {
            schema: ['name', 'platform', 'os', 'keySize', 'api', 'category'],
            inputDataPath,
        } as Config;
        const { commit } = await loadResult(config);
        const expectedAuthor = {
            name: 'author',
            username: 'author',
        };
        const expectedCommitter = {
            name: 'committer',
            username: 'committer',
        };
        A.deepEqual(commit.author, expectedAuthor);
        A.deepEqual(commit.committer, expectedCommitter);
        A.equal(commit.id, 'abcdef0123456789');
        A.equal(commit.message, 'message');
        A.equal(commit.timestamp, 'timestamp');
        A.equal(commit.url, 'https://github.com/dummy/repo/commits/abcdef0123456789');
    });
    it('collects the commit information from merge_group payload with no organization or repo provided', async function () {
        dummyGitHubContext.payload = {
            merge_group: {
                head_commit: {
                    id: 'abcdef0123456789',
                    tree_id: 'tree_id',
                    message: 'message',
                    timestamp: 'timestamp',
                    author: { name: 'author', email: 'author' },
                    committer: { name: 'committer', email: 'committer' },
                },
            },
        };
        const inputDataPath = path.join(__dirname, 'data', 'extract', 'customBiggerIsBetter_output.json');
        const config = {
            schema: ['name', 'platform', 'os', 'keySize', 'api', 'category'],
            inputDataPath,
        } as Config;
        const { commit } = await loadResult(config);
        const expectedAuthor = {
            name: 'author',
            username: 'author',
        };
        const expectedCommitter = {
            name: 'committer',
            username: 'committer',
        };
        A.deepEqual(commit.author, expectedAuthor);
        A.deepEqual(commit.committer, expectedCommitter);
        A.equal(commit.id, 'abcdef0123456789');
        A.equal(commit.message, 'message');
        A.equal(commit.timestamp, 'timestamp');
        A.equal(commit.url, '/commits/abcdef0123456789');
    });

    it('collects the commit information from merge_group payload when no author provided', async function () {
        // use copy of dummyWebHookPayload
        dummyGitHubContext.payload = JSON.parse(JSON.stringify(dummyWebhookPayload));

        // assign null
        dummyGitHubContext.payload.merge_group.head_commit.author = null;
        dummyGitHubContext.payload.merge_group.head_commit.committer = null;
        const inputDataPath = path.join(__dirname, 'data', 'extract', 'customBiggerIsBetter_output.json');
        const config = {
            schema: ['name', 'platform', 'os', 'keySize', 'api', 'category'],
            inputDataPath,
        } as Config;
        const { commit } = await loadResult(config);
        const expectedAuthor = {
            name: undefined,
            username: undefined,
        };
        const expectedCommitter = {
            name: undefined,
            username: undefined,
        };
        A.deepEqual(commit.author, expectedAuthor);
        A.deepEqual(commit.committer, expectedCommitter);
        A.equal(commit.id, 'abcdef0123456789');
        A.equal(commit.message, 'message');
        A.equal(commit.timestamp, 'timestamp');
        A.equal(commit.url, 'https://github.com/dummy/repo/commits/abcdef0123456789');
    });

    it('raises an error when commit information is not found in webhook payload and no githubToken is provided', async function () {
        dummyGitHubContext.payload = {};
        const inputDataPath = path.join(__dirname, 'data', 'extract', 'customBiggerIsBetter_output.json');
        const config = {
            schema: ['name', 'platform', 'os', 'keySize', 'api', 'category'],
            inputDataPath,
        } as Config;
        await A.rejects(loadResult(config), /^Error: No commit information is found in payload/);
    });
});
