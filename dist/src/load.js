"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadResult = void 0;
/* eslint-disable @typescript-eslint/naming-convention */
const fs_1 = require("fs");
const github = __importStar(require("@actions/github"));
function getCommitFromPullRequestPayload(pr) {
    // On pull_request hook, head_commit is not available
    const id = pr.head.sha;
    const username = pr.head.user.login;
    const user = {
        name: username,
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
async function getCommitFromGitHubAPIRequest(githubToken, ref) {
    var _a, _b, _c, _d, _e, _f, _g;
    const octocat = github.getOctokit(githubToken);
    const { status, data } = await octocat.rest.repos.getCommit({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        ref: ref !== null && ref !== void 0 ? ref : github.context.ref,
    });
    if (!(status === 200 || status === 304)) {
        throw new Error(`Could not fetch the head commit. Received code: ${status}`);
    }
    const { commit } = data;
    return {
        author: {
            name: (_a = commit.author) === null || _a === void 0 ? void 0 : _a.name,
            username: (_b = data.author) === null || _b === void 0 ? void 0 : _b.login,
            email: (_c = commit.author) === null || _c === void 0 ? void 0 : _c.email,
        },
        committer: {
            name: (_d = commit.committer) === null || _d === void 0 ? void 0 : _d.name,
            username: (_e = data.committer) === null || _e === void 0 ? void 0 : _e.login,
            email: (_f = commit.committer) === null || _f === void 0 ? void 0 : _f.email,
        },
        id: data.sha,
        message: commit.message,
        timestamp: (_g = commit.author) === null || _g === void 0 ? void 0 : _g.date,
        url: data.html_url,
    };
}
async function getCommit(githubToken, ref) {
    if (github.context.payload.head_commit) {
        return github.context.payload.head_commit;
    }
    const pr = github.context.payload.pull_request;
    if (pr) {
        return getCommitFromPullRequestPayload(pr);
    }
    if (!githubToken) {
        throw new Error(`No commit information is found in payload: ${JSON.stringify(github.context.payload, null, 2)}. Also, no 'github-token' provided, could not fallback to GitHub API Request.`);
    }
    return getCommitFromGitHubAPIRequest(githubToken, ref);
}
function loadBenchmarkResult(output) {
    try {
        const json = JSON.parse(output);
        // TODO: don't require all fields?
        return json.map(({ name, value, unit, os, range, extra, category, keySize, platform, api }) => {
            return { name, value, unit, os, range, extra, category, keySize, platform, api };
        });
    }
    catch (err) {
        throw new Error(`Output file must be JSON file containing an array of entries in BenchmarkResult format: ${err.message}`);
    }
}
async function loadResult(config) {
    const output = await fs_1.promises.readFile(config.inputDataPath, 'utf8');
    const { githubToken, ref } = config;
    const benches = loadBenchmarkResult(output);
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
exports.loadResult = loadResult;
//# sourceMappingURL=load.js.map