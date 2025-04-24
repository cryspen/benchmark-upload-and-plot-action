/* eslint-disable @typescript-eslint/naming-convention */
import { promises as fs } from 'fs';
import * as github from '@actions/github';
import { Config } from './config';

export interface BenchmarkResult {
    value: number;
    range?: string;
    unit: string;
    extra?: string;
    os: string;

    // from NameMetadata
    category?: string;
    keySize?: number;
    name: string;
    platform?: string;
    api?: string;
}

interface GitHubUser {
    email?: string;
    name?: string;
    username?: string;
}

interface MergeGroupHeadCommit {
    tree_id?: unknown; // unused
    author: GitHubUser;
    committer: GitHubUser;
    distinct?: unknown; // Unused
    id: string;
    message: string;
    timestamp: string;
}

interface MergeGroup {
    organization?: string;
    repository?: string;
    head_commit: MergeGroupHeadCommit;
}

interface Commit {
    author: GitHubUser;
    committer: GitHubUser;
    distinct?: unknown; // Unused
    id: string;
    message: string;
    timestamp?: string;
    tree_id?: unknown; // Unused
    url: string;
}

interface PullRequest {
    [key: string]: any;
    number: number;
    html_url?: string;
    body?: string;
}

export interface Benchmark {
    commit: Commit;
    date: number;
    bigger_is_better: boolean;
    benches: BenchmarkResult[];
}

function getCommitFromPullRequestPayload(pr: PullRequest): Commit {
    // On pull_request hook, head_commit is not available
    const id: string = pr.head.sha;
    const username: string = pr.head.user.login;
    const user = {
        name: username, // XXX: Fallback, not correct
        username,
    };

    return {
        author: user,
        committer: user,
        id,
        message: pr.title,
        timestamp: pr.head.repo.updated_at,
        url: `${pr.html_url}/commits/${id}`,
    };
}

async function getCommitFromMergeGroup(mergeGroup: MergeGroup): Promise<Commit> {
    const headCommit = mergeGroup.head_commit;

    const id: string = headCommit.id;

    // XXX: assume the repository is on GitHub
    const urlPrefix =
        mergeGroup.organization && mergeGroup.repository
            ? `https://github.com/${mergeGroup.organization}/${mergeGroup.repository}`
            : '';

    const url = `${urlPrefix}/commits/${id}`;

    // XXX: Username is not available. Use name as fallback
    return {
        author: {
            name: headCommit.author.name,
            username: headCommit.author.name,
        },
        committer: {
            name: headCommit.committer.name,
            username: headCommit.committer.name,
        },
        id,
        message: headCommit.message,
        timestamp: headCommit.timestamp,
        url,
    };
}

async function getCommitFromGitHubAPIRequest(githubToken: string, ref?: string): Promise<Commit> {
    const octocat = github.getOctokit(githubToken);

    const { status, data } = await octocat.rest.repos.getCommit({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        ref: ref ?? github.context.ref,
    });

    if (!(status === 200 || status === 304)) {
        throw new Error(`Could not fetch the head commit. Received code: ${status}`);
    }

    const { commit } = data;

    return {
        author: {
            name: commit.author?.name,
            username: data.author?.login,
            email: commit.author?.email,
        },
        committer: {
            name: commit.committer?.name,
            username: data.committer?.login,
            email: commit.committer?.email,
        },
        id: data.sha,
        message: commit.message,
        timestamp: commit.author?.date,
        url: data.html_url,
    };
}

async function getCommit(githubToken?: string, ref?: string): Promise<Commit> {
    if (github.context.payload.head_commit) {
        return github.context.payload.head_commit;
    }

    // also try with merge group
    const mergeGroup = github.context.payload.merge_group;

    if (mergeGroup) {
        if (mergeGroup.head_commit) {
            return getCommitFromMergeGroup(mergeGroup);
        }
    }

    const pr = github.context.payload.pull_request;

    if (pr) {
        return getCommitFromPullRequestPayload(pr);
    }

    if (!githubToken) {
        throw new Error(
            `No commit information is found in payload: ${JSON.stringify(
                github.context.payload,
                null,
                2,
            )}. Also, no 'github-token' provided, could not fallback to GitHub API Request.`,
        );
    }

    return getCommitFromGitHubAPIRequest(githubToken, ref);
}

function loadBenchmarkResult(output: string): BenchmarkResult[] {
    try {
        const json: BenchmarkResult[] = JSON.parse(output);
        // TODO: don't require all fields?
        return json.map(({ name, value, unit, os, range, extra, category, keySize, platform, api }) => {
            return { name, value, unit, os, range, extra, category, keySize, platform, api };
        });
    } catch (err: any) {
        throw new Error(
            `Output file must be JSON file containing an array of entries in BenchmarkResult format: ${err.message}`,
        );
    }
}

export async function loadResult(config: Config): Promise<Benchmark> {
    const output = await fs.readFile(config.inputDataPath, 'utf8');
    const { githubToken, ref } = config;
    const benches: BenchmarkResult[] = loadBenchmarkResult(output);

    if (benches.length === 0) {
        throw new Error(`No benchmark result was found in ${config.inputDataPath}. Benchmark output was '${output}'`);
    }

    const commit = await getCommit(githubToken, ref);

    const bigger_is_better = config.biggerIsBetter;

    return {
        commit,
        date: Date.now(),
        bigger_is_better,
        benches,
    };
}
