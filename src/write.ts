import { promises as fs } from 'fs';
import * as path from 'path';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as git from './git';
import { Benchmark, BenchmarkResult } from './load';
import { Config } from './config';
import { DEFAULT_INDEX_HTML } from './default_index_html';
import { leavePRComment } from './comment/leavePRComment';
import { leaveCommitComment } from './comment/leaveCommitComment';

export type BenchmarkSuites = { [name: string]: Benchmark[] };
export interface DataJson {
    lastUpdate: number;
    repoUrl: string;
    entries: BenchmarkSuites;
    groupBy: { [name: string]: string[] };
    schema: { [name: string]: string[] };
}

export interface Listing {
    branches: string[];
    prs: string[];
}

const DEFAULT_DATA_JSON = {
    lastUpdate: 0,
    repoUrl: '',
    entries: {},
    groupBy: {},
    schema: {},
};

const DEFAULT_LISTING = {
    branches: ['main'],
    prs: [],
};
function getDataPath() {
    const pr = github.context.payload.pull_request;
    const mergeGroup = github.context.payload.merge_group;
    const push = github.context.payload.push;

    if (pr) {
        const file = `${pr.number}.json`;
        return path.join('pr', file);
    }
    if (mergeGroup) {
        // don't write to path
        return undefined;
    }
    if (push) {
        return push.base_ref;
    }

    return undefined;
}
function getComparePathAndSha(): [string, string] | undefined {
    const pr = github.context.payload.pull_request;
    const mergeGroup = github.context.payload.merge_group;
    const push = github.context.payload.push;

    let sha;
    let file;
    if (pr) {
        const branch = pr.pull_request.base.ref;
        sha = pr.pull_request.base.sha;
        file = `branches/${branch}.json`;
    } else if (mergeGroup) {
        const branch = mergeGroup.merge_group.base_ref;
        sha = mergeGroup.merge_group.base_sha;
        file = `branches/${branch}.json`;
    } else if (push) {
        // do not compare
        return undefined;
    } else {
        return undefined;
    }

    const comparePath = path.join('branch', file);

    return [comparePath, sha];
}
async function getPrevBench(benchName: string): Promise<Benchmark | null> {
    // TODO: error handling
    const comparePathAndSha = getComparePathAndSha();
    if (!comparePathAndSha) {
        return null;
    }
    const [comparePath, compareSha] = comparePathAndSha;
    const data = await loadDataJson(comparePath);

    const suite = data.entries[benchName];

    if (suite === undefined) {
        return null;
    }

    for (let benchmark of Array.from(suite).reverse()) {
        if (benchmark.commit.id === compareSha) {
            return benchmark;
        }
    }

    return null;
}
async function loadListing(dataPath: string): Promise<Listing> {
    try {
        const json = await fs.readFile(dataPath, 'utf8');
        const parsed = JSON.parse(json);
        core.debug(`Loaded listing.json at ${dataPath}`);
        return parsed;
    } catch (err) {
        console.log(`Could not find listing.json at ${dataPath}. Using empty default: ${err}`);
        return { ...DEFAULT_LISTING };
    }
}

async function updateAndStoreListing(dataPath: string, data: Listing) {
    // TODO: pass these in differently
    const [type, file] = dataPath.split('/');
    const id = file.replace('.json', '');

    if (type === 'branch') {
        if (!data.branches.includes(id)) {
            data.branches.push(id);
        }
    } else {
        if (!data.prs.includes(id)) {
            data.prs.push(id);
        }
    }
    const script = JSON.stringify(data, null, 2);
    await fs.writeFile(dataPath, script, 'utf8');
    core.debug(`Overwrote ${dataPath} for adding new data`);
}

async function loadDataJson(dataPath: string): Promise<DataJson> {
    try {
        const json = await fs.readFile(dataPath, 'utf8');
        const parsed = JSON.parse(json);
        core.debug(`Loaded data.json at ${dataPath}`);
        return parsed;
    } catch (err) {
        console.log(`Could not find data.json at ${dataPath}. Using empty default: ${err}`);
        return { ...DEFAULT_DATA_JSON };
    }
}

async function storeDataJson(dataPath: string, data: DataJson) {
    const script = JSON.stringify(data, null, 2);
    await fs.writeFile(dataPath, script, 'utf8');
    core.debug(`Overwrote ${dataPath} for adding new data`);
}

async function addIndexHtmlIfNeeded(additionalGitArguments: string[], baseDir: string) {
    const indexHtmlRelativePath = 'index.html';
    const indexHtmlFullPath = path.join(baseDir, indexHtmlRelativePath);
    try {
        await fs.stat(indexHtmlFullPath);
        core.debug(`Skipped to create default index.html since it is already existing: ${indexHtmlFullPath}`);
        return;
    } catch (_) {
        // Continue
    }

    await fs.writeFile(indexHtmlFullPath, DEFAULT_INDEX_HTML, 'utf8');
    await git.cmd(additionalGitArguments, 'add', indexHtmlRelativePath);
    console.log('Created default index.html at', indexHtmlFullPath);
}

interface Alert {
    current: BenchmarkResult;
    prev: BenchmarkResult;
    ratio: number;
}

// construct the benchmark key using the schema,
// so we can compare BenchmarkResults for the purpose
// of generating alerts.
function benchmarkKey(benchmark: BenchmarkResult, schema: string[]): string {
    const key: any = {};
    for (const s of schema) {
        key[s] = benchmark[s];
    }

    const keyString = JSON.stringify(key);
    return keyString;
}

function findAlerts(curSuite: Benchmark, prevSuite: Benchmark, threshold: number, schema: string[]): Alert[] {
    core.debug(`Comparing current:${curSuite.commit.id} and prev:${prevSuite.commit.id} for alert`);

    const alerts = [];
    for (const current of curSuite.benches) {
        const currentKey = benchmarkKey(current, schema);
        const prev = prevSuite.benches.find((b: BenchmarkResult) => benchmarkKey(b, schema) === currentKey);
        if (prev === undefined) {
            core.debug(`Skipped because benchmark '${currentKey}' is not found in previous benchmarks`);
            continue;
        }

        const ratio = getRatio(curSuite.bigger_is_better, prev, current);

        if (ratio > threshold) {
            core.warning(
                `Performance alert! Previous value was ${prev.value} and current value is ${current.value}.` +
                    ` It is ${ratio}x worse than previous exceeding a ratio threshold ${threshold}`,
            );
            alerts.push({ current, prev, ratio });
        }
    }

    return alerts;
}

function getCurrentRepoMetadata() {
    const { repo, owner } = github.context.repo;
    const serverUrl = git.getServerUrl(github.context.payload.repository?.html_url);
    return {
        name: repo,
        owner: {
            login: owner,
        },
        // eslint-disable-next-line @typescript-eslint/naming-convention
        html_url: `${serverUrl}/${owner}/${repo}`,
    };
}

function floatStr(n: number) {
    if (!Number.isFinite(n)) {
        return `${n > 0 ? '+' : '-'}∞`;
    }

    if (Number.isInteger(n)) {
        return n.toFixed(0);
    }

    if (n > 0.1) {
        return n.toFixed(2);
    }

    return n.toString();
}

function strVal(b: BenchmarkResult): string {
    let s = `\`${b.value}\` ${b.unit}`;
    if (b.range) {
        s += ` (\`${b.range}\`)`;
    }
    return s;
}

function commentFooter(): string {
    const repoMetadata = getCurrentRepoMetadata();
    const repoUrl = repoMetadata.html_url ?? '';
    const actionUrl = repoUrl + '/actions?query=workflow%3A' + encodeURIComponent(github.context.workflow);

    return `This comment was automatically generated by [workflow](${actionUrl}) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`;
}

export function buildComment(
    benchName: string,
    curSuite: Benchmark,
    prevSuite: Benchmark,
    expandableDetails = true,
): string {
    const lines = [
        `# ${benchName}`,
        '',
        expandableDetails ? '<details>' : '',
        '',
        `| Benchmark suite | Current: ${curSuite.commit.id} | Previous: ${prevSuite.commit.id} | Ratio |`,
        '|-|-|-|-|',
    ];

    for (const current of curSuite.benches) {
        let line;
        const prev = prevSuite.benches.find((i) => i.name === current.name);

        if (prev) {
            const ratio = getRatio(curSuite.bigger_is_better, prev, current);

            line = `| \`${current.name}\` | ${strVal(current)} | ${strVal(prev)} | \`${floatStr(ratio)}\` |`;
        } else {
            line = `| \`${current.name}\` | ${strVal(current)} | | |`;
        }

        lines.push(line);
    }

    // Footer
    lines.push('', expandableDetails ? '</details>' : '', '', commentFooter());

    return lines.join('\n');
}

function buildAlertComment(
    alerts: Alert[],
    benchName: string,
    curSuite: Benchmark,
    prevSuite: Benchmark,
    threshold: number,
    cc: string[],
): string {
    // Do not show benchmark name if it is the default value 'Benchmark'.
    const benchmarkText = benchName === 'Benchmark' ? '' : ` **'${benchName}'**`;
    const title = threshold === 0 ? '# Performance Report' : '# :warning: **Performance Alert** :warning:';
    const thresholdString = floatStr(threshold);
    const lines = [
        title,
        '',
        `Possible performance regression was detected for benchmark${benchmarkText}.`,
        `Benchmark result of this commit is worse than the previous benchmark result exceeding threshold \`${thresholdString}\`.`,
        '',
        `| Benchmark suite | Current: ${curSuite.commit.id} | Previous: ${prevSuite.commit.id} | Ratio |`,
        '|-|-|-|-|',
    ];

    for (const alert of alerts) {
        const { current, prev, ratio } = alert;
        const line = `| \`${current.name}\` | ${strVal(current)} | ${strVal(prev)} | \`${floatStr(ratio)}\` |`;
        lines.push(line);
    }

    // Footer
    lines.push('', commentFooter());

    if (cc.length > 0) {
        lines.push('', `CC: ${cc.join(' ')}`);
    }

    return lines.join('\n');
}

async function leaveComment(commitId: string, body: string, commentId: string, token: string) {
    core.debug('Sending comment:\n' + body);

    const repoMetadata = getCurrentRepoMetadata();
    const pr = github.context.payload.pull_request;

    return await (pr?.number
        ? leavePRComment(repoMetadata.owner.login, repoMetadata.name, pr.number, body, commentId, token)
        : leaveCommitComment(repoMetadata.owner.login, repoMetadata.name, commitId, body, commentId, token));
}

async function handleComment(benchName: string, curSuite: Benchmark, prevSuite: Benchmark, config: Config) {
    const { commentAlways, githubToken } = config;

    if (!commentAlways) {
        core.debug('Comment check was skipped because comment-always is disabled');
        return;
    }

    if (!githubToken) {
        throw new Error("'comment-always' input is set but 'github-token' input is not set");
    }

    core.debug('Commenting about benchmark comparison');

    const body = buildComment(benchName, curSuite, prevSuite);

    await leaveComment(curSuite.commit.id, body, `${benchName} Summary`, githubToken);
}

async function handleAlert(benchName: string, curSuite: Benchmark, prevSuite: Benchmark, config: Config) {
    const { alertThreshold, githubToken, commentOnAlert, failOnAlert, alertCommentCcUsers, failThreshold } = config;

    if (!commentOnAlert && !failOnAlert) {
        core.debug('Alert check was skipped because both comment-on-alert and fail-on-alert were disabled');
        return;
    }

    const alerts = findAlerts(curSuite, prevSuite, alertThreshold, config.schema);
    if (alerts.length === 0) {
        core.debug('No performance alert found happily');
        return;
    }

    core.debug(`Found ${alerts.length} alerts`);
    const body = buildAlertComment(alerts, benchName, curSuite, prevSuite, alertThreshold, alertCommentCcUsers);
    let message = body;

    if (commentOnAlert) {
        if (!githubToken) {
            throw new Error("'comment-on-alert' input is set but 'github-token' input is not set");
        }
        const res = await leaveComment(curSuite.commit.id, body, `${benchName} Alert`, githubToken);
        const url = res.data.html_url;
        message = body + `\nComment was generated at ${url}`;
    }

    if (failOnAlert) {
        // Note: alertThreshold is smaller than failThreshold. It was checked in config.ts
        const len = alerts.length;
        const threshold = floatStr(failThreshold);
        const failures = alerts.filter((a) => a.ratio > failThreshold);
        if (failures.length > 0) {
            core.debug('Mark this workflow as fail since one or more fatal alerts found');
            if (failThreshold !== alertThreshold) {
                // Prepend message that explains how these alerts were detected with different thresholds
                message = `${failures.length} of ${len} alerts exceeded the failure threshold \`${threshold}\` specified by fail-threshold input:\n\n${message}`;
            }
            throw new Error(message);
        } else {
            core.debug(
                `${len} alerts exceeding the alert threshold ${alertThreshold} were found but` +
                    ` none of them exceeded the failure threshold ${threshold}`,
            );
        }
    }
}

function addBenchmarkToDataJson(
    groupBy: string[],
    schema: string[],
    benchName: string,
    bench: Benchmark,
    data: DataJson,
    maxItems: number | null,
) {
    const repoMetadata = getCurrentRepoMetadata();
    const htmlUrl = repoMetadata.html_url ?? '';

    data.lastUpdate = Date.now();
    data.groupBy[benchName] = groupBy;
    data.repoUrl = htmlUrl;
    data.schema[benchName] = schema;

    // Add benchmark result
    if (data.entries[benchName] === undefined) {
        data.entries[benchName] = [bench];
        core.debug(`No suite was found for benchmark '${benchName}' in existing data. Created`);
    } else {
        const suites = data.entries[benchName];

        suites.push(bench);

        if (maxItems !== null && suites.length > maxItems) {
            suites.splice(0, suites.length - maxItems);
            core.debug(
                `Number of data items for '${benchName}' was truncated to ${maxItems} due to max-items-in-charts`,
            );
        }
    }
}

function isRemoteRejectedError(err: unknown): err is Error {
    if (err instanceof Error) {
        return ['[remote rejected]', '[rejected]'].some((l) => err.message.includes(l));
    }
    return false;
}

async function writeBenchmarkToGitHubPagesWithRetry(bench: Benchmark, config: Config, retry: number) {
    const {
        name,
        ghPagesBranch,
        ghRepository,
        githubToken,
        autoPush,
        skipFetchGhPages,
        maxItemsInChart,
        groupBy,
        schema,
    } = config;
    const rollbackActions = new Array<() => Promise<void>>();

    // TODO: identify which of the below cases are needed. Potentially always
    // require the gh-repository field.
    let isPrivateRepo = null;
    try {
        isPrivateRepo = github.context.payload.repository?.private ?? false;
    } catch (error) {
        if (error instanceof Error) {
            core.warning(error.message);
        } else {
            core.warning('An unknown error occurred');
        }
    }

    let benchmarkBaseDir = './';
    let extraGitArguments: string[] = [];

    if (githubToken && !skipFetchGhPages && ghRepository) {
        benchmarkBaseDir = './benchmark-data-repository';
        await git.clone(githubToken, ghRepository, benchmarkBaseDir);
        rollbackActions.push(async () => {
            await io.rmRF(benchmarkBaseDir);
        });
        extraGitArguments = [`--work-tree=${benchmarkBaseDir}`, `--git-dir=${benchmarkBaseDir}/.git`];
        await git.checkout(ghPagesBranch, extraGitArguments);
    } else if (!skipFetchGhPages && (isPrivateRepo === false || githubToken)) {
        await git.pull(githubToken, ghPagesBranch);
    } else if (isPrivateRepo === true && !skipFetchGhPages) {
        core.warning(
            "'git pull' was skipped. If you want to ensure GitHub Pages branch is up-to-date " +
                "before generating a commit, please set 'github-token' input to pull GitHub pages branch",
        );
    } else {
        console.warn('NOTHING EXECUTED:', {
            skipFetchGhPages,
            ghRepository,
            isPrivateRepo,
            githubToken: !!githubToken,
        });
    }

    // `benchmarkDataDirPath` is an absolute path at this stage,
    // so we need to convert it to relative to be able to prepend the `benchmarkBaseDir`

    const listingPath = path.join(benchmarkBaseDir, 'listing.json');

    const dataRelativePath = getDataPath();
    const dataPath = path.join(benchmarkBaseDir, dataRelativePath);

    await io.mkdirP('./branch');
    await io.mkdirP('./pr');

    const data = await loadDataJson(dataPath);
    addBenchmarkToDataJson(groupBy, schema, name, bench, data, maxItemsInChart);

    await storeDataJson(dataPath, data);

    await git.cmd(extraGitArguments, 'add', dataRelativePath);
    await addIndexHtmlIfNeeded(extraGitArguments, benchmarkBaseDir);
    await git.cmd(extraGitArguments, 'commit', '-m', `add ${name} benchmark result for ${bench.commit.id}`);

    // handle the listing
    const listing = await loadListing(listingPath);
    await updateAndStoreListing(listingPath, listing);

    if (githubToken && autoPush) {
        try {
            await git.push(githubToken, ghRepository, ghPagesBranch, extraGitArguments);
            console.log(
                `Automatically pushed the generated commit to ${ghPagesBranch} branch since 'auto-push' is set to true`,
            );
        } catch (err: unknown) {
            if (!isRemoteRejectedError(err)) {
                throw err;
            }
            // Fall through

            core.warning(`Auto-push failed because the remote ${ghPagesBranch} was updated after git pull`);

            if (retry > 0) {
                core.debug('Rollback the auto-generated commit before retry');
                await git.cmd(extraGitArguments, 'reset', '--hard', 'HEAD~1');

                // we need to rollback actions in order so not running them concurrently
                for (const action of rollbackActions) {
                    await action();
                }

                core.warning(
                    `Retrying to generate a commit and push to remote ${ghPagesBranch} with retry count ${retry}...`,
                );
                await writeBenchmarkToGitHubPagesWithRetry(bench, config, retry - 1); // Recursively retry
                return;
            } else {
                core.warning(`Failed to add benchmark data to '${name}' data: ${JSON.stringify(bench)}`);
                throw new Error(
                    `Auto-push failed 3 times since the remote branch ${ghPagesBranch} rejected pushing all the time. Last exception was: ${err.message}`,
                );
            }
        }
    } else {
        core.debug(
            `Auto-push to ${ghPagesBranch} is skipped because it requires both 'github-token' and 'auto-push' inputs`,
        );
    }
}

async function writeBenchmarkToGitHubPages(bench: Benchmark, config: Config) {
    const { ghPagesBranch, skipFetchGhPages, ghRepository, githubToken } = config;
    if (!ghRepository) {
        if (!skipFetchGhPages) {
            await git.fetch(githubToken, ghPagesBranch);
        }
        await git.cmd([], 'switch', ghPagesBranch);
    }
    try {
        await writeBenchmarkToGitHubPagesWithRetry(bench, config, 10);
        return;
    } finally {
        if (!ghRepository) {
            // `git switch` does not work for backing to detached head
            await git.cmd([], 'checkout', '-');
        }
    }
}

async function writeBenchmarkToExternalJson(bench: Benchmark, jsonFilePath: string, config: Config) {
    const { name, maxItemsInChart, saveDataFile, groupBy, schema } = config;
    const data = await loadDataJson(jsonFilePath);
    addBenchmarkToDataJson(groupBy, schema, name, bench, data, maxItemsInChart);

    if (!saveDataFile) {
        core.debug('Skipping storing benchmarks in external data file');
        return;
    }

    try {
        const jsonDirPath = path.dirname(jsonFilePath);
        await io.mkdirP(jsonDirPath);
        await fs.writeFile(jsonFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        throw new Error(`Could not store benchmark data as JSON at ${jsonFilePath}: ${err}`);
    }

    return;
}

export async function writeBenchmark(bench: Benchmark, config: Config) {
    const { name, externalDataJsonPath } = config;

    let prevBench;
    if (externalDataJsonPath) {
        prevBench = await writeBenchmarkToExternalJson(bench, externalDataJsonPath, config);
    } else {
        await writeBenchmarkToGitHubPages(bench, config);

        prevBench = await getPrevBench(name);
    }

    if (!prevBench) {
        // no previous benchmark to compare
        return;
    }

    // Put this after `git push` for reducing possibility to get conflict on push. Since sending
    // comment take time due to API call, do it after updating remote branch.
    if (prevBench === null) {
        core.debug('Alert check was skipped because previous benchmark result was not found');
    } else {
        await handleComment(name, bench, prevBench, config);
        await handleSummary(name, bench, prevBench, config);
        await handleAlert(name, bench, prevBench, config);
    }
}

async function handleSummary(benchName: string, currBench: Benchmark, prevBench: Benchmark, config: Config) {
    const { summaryAlways } = config;

    if (!summaryAlways) {
        core.debug('Summary was skipped because summary-always is disabled');
        return;
    }

    const body = buildComment(benchName, currBench, prevBench, false);

    const summary = core.summary.addRaw(body);

    core.debug('Writing a summary about benchmark comparison');
    core.debug(summary.stringify());

    await summary.write();
}

function getRatio(biggerIsBetter: boolean, prev: BenchmarkResult, current: BenchmarkResult) {
    if (prev.value === 0 && current.value === 0) return 1;

    return biggerIsBetter
        ? prev.value / current.value // e.g. current=100, prev=200
        : current.value / prev.value; // e.g. current=200, prev=100
}
