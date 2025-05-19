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
exports.writeBenchmark = exports.buildComment = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
const io = __importStar(require("@actions/io"));
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const git = __importStar(require("./git"));
const default_index_html_1 = require("./default_index_html");
const leavePRComment_1 = require("./comment/leavePRComment");
const leaveCommitComment_1 = require("./comment/leaveCommitComment");
const DEFAULT_DATA_JSON = {
    lastUpdate: 0,
    repoUrl: '',
    entries: {},
    groupBy: {},
    schema: {},
};
const DEFAULT_LISTING = {
    refs: [],
    prs: [],
};
var DataEntryType;
(function (DataEntryType) {
    DataEntryType[DataEntryType["pullRequest"] = 0] = "pullRequest";
    DataEntryType[DataEntryType["ref"] = 1] = "ref";
})(DataEntryType || (DataEntryType = {}));
function getDataEntry() {
    const eventName = github.context.eventName;
    let type;
    let id;
    if (eventName === 'pull_request') {
        id = github.context.payload.number;
        type = DataEntryType.pullRequest;
    }
    else if (eventName === 'push') {
        id = github.context.ref;
        type = DataEntryType.ref;
    }
    else {
        console.warn(`Unsupported event type: ${eventName}`);
        core.debug(JSON.stringify(github.context.payload));
        return undefined;
    }
    return { type, id };
}
function getDataPath(dataEntry) {
    if (dataEntry.type === DataEntryType.pullRequest) {
        return path.join('pr', `${dataEntry.id}.json`);
    }
    else {
        return `${dataEntry.id}.json`;
    }
}
function getComparePathAndSha() {
    var _a, _b;
    const eventName = github.context.eventName;
    let ref;
    let sha;
    if (eventName === 'pull_request') {
        const branch = (_a = github.context.payload.pull_request) === null || _a === void 0 ? void 0 : _a.base.ref;
        sha = (_b = github.context.payload.pull_request) === null || _b === void 0 ? void 0 : _b.base.sha;
        if (!branch || !sha) {
            console.warn(`ref ${branch} or sha ${sha} is null; skipping`);
            return undefined;
        }
        ref = path.join('refs', 'heads', branch);
    }
    else if (eventName === 'merge_group') {
        ref = github.context.payload.merge_group.base_ref;
        sha = github.context.payload.merge_group.base_sha;
    }
    else if (eventName === 'push') {
        ref = github.context.ref;
        sha = github.context.payload.before;
    }
    else {
        return undefined;
    }
    if (!sha) {
        return undefined;
    }
    const file = `${ref}.json`;
    // already includes 'refs'
    const comparePath = file;
    return [comparePath, sha];
}
async function getPrevBench(benchName, config) {
    // TODO: error handling
    const comparePathAndSha = getComparePathAndSha();
    if (!comparePathAndSha) {
        return null;
    }
    const [comparePath, compareSha] = comparePathAndSha;
    const data = await loadDataJson(path.join(config.basePath, comparePath));
    const suite = data.entries[benchName];
    if (suite === undefined) {
        return null;
    }
    for (const benchmark of Array.from(suite).reverse()) {
        if (benchmark.commit.id === compareSha) {
            return benchmark;
        }
    }
    return null;
}
async function loadListing(baseDir, listingPath) {
    const dataPath = path.join(baseDir, listingPath);
    try {
        const json = await fs_1.promises.readFile(dataPath, 'utf8');
        const parsed = JSON.parse(json);
        core.debug(`Loaded listing.json at ${dataPath}`);
        return parsed;
    }
    catch (err) {
        console.log(`Could not find listing.json at ${dataPath}. Using empty default: ${err}`);
        return { ...DEFAULT_LISTING };
    }
}
async function updateAndStoreListing(baseDir, listingPath, listing, dataEntry) {
    if (dataEntry.type === DataEntryType.ref) {
        if (!listing.refs.includes(dataEntry.id)) {
            listing.refs.push(dataEntry.id);
        }
    }
    else {
        if (!listing.prs.includes(dataEntry.id)) {
            listing.prs.push(dataEntry.id);
        }
    }
    const script = JSON.stringify(listing, null, 2);
    const writePath = path.join(baseDir, listingPath);
    await fs_1.promises.writeFile(writePath, script, 'utf8');
    core.debug(`Overwrote the listing at ${writePath}`);
}
async function loadDataJson(dataPath) {
    try {
        const json = await fs_1.promises.readFile(dataPath, 'utf8');
        const parsed = JSON.parse(json);
        core.debug(`Loaded ${dataPath}`);
        return parsed;
    }
    catch (err) {
        console.log(`Could not find ${dataPath}. Using empty default: ${err}`);
        return { ...DEFAULT_DATA_JSON };
    }
}
async function storeDataJson(dataPath, data) {
    const script = JSON.stringify(data, null, 2);
    await fs_1.promises.writeFile(dataPath, script, 'utf8');
    core.debug(`Overwrote ${dataPath} for adding new data`);
}
async function addIndexHtmlIfNeeded(additionalGitArguments, baseDir, indexHtmlRelativePath) {
    const indexHtmlFullPath = path.join(baseDir, indexHtmlRelativePath);
    try {
        await fs_1.promises.stat(indexHtmlFullPath);
        core.debug(`Skipped to create default index.html since it is already existing: ${indexHtmlFullPath}`);
        return;
    }
    catch (_) {
        // Continue
    }
    await fs_1.promises.writeFile(indexHtmlFullPath, default_index_html_1.DEFAULT_INDEX_HTML, 'utf8');
    await git.cmd(additionalGitArguments, 'add', indexHtmlRelativePath);
    console.log('Created default index.html at', indexHtmlFullPath);
}
// construct the benchmark key using the schema,
// so we can compare BenchmarkResults for the purpose
// of generating alerts.
function benchmarkKey(benchmark, schema) {
    const key = {};
    for (const s of schema) {
        key[s] = benchmark[s];
    }
    const keyString = JSON.stringify(key);
    return keyString;
}
function findAlerts(curSuite, prevSuite, threshold, schema) {
    core.debug(`Comparing current:${curSuite.commit.id} and prev:${prevSuite.commit.id} for alert`);
    const alerts = [];
    for (const current of curSuite.benches) {
        const currentKey = benchmarkKey(current, schema);
        const prev = prevSuite.benches.find((b) => benchmarkKey(b, schema) === currentKey);
        if (prev === undefined) {
            core.debug(`Skipped because benchmark '${currentKey}' is not found in previous benchmarks`);
            continue;
        }
        const ratio = getRatio(curSuite.bigger_is_better, prev, current);
        if (ratio > threshold) {
            core.warning(`Performance alert! Previous value was ${prev.value} and current value is ${current.value}.` +
                ` It is ${ratio}x worse than previous exceeding a ratio threshold ${threshold}`);
            alerts.push({ current, prev, ratio });
        }
    }
    return alerts;
}
function getCurrentRepoMetadata() {
    var _a;
    const { repo, owner } = github.context.repo;
    const serverUrl = git.getServerUrl((_a = github.context.payload.repository) === null || _a === void 0 ? void 0 : _a.html_url);
    return {
        name: repo,
        owner: {
            login: owner,
        },
        // eslint-disable-next-line @typescript-eslint/naming-convention
        html_url: `${serverUrl}/${owner}/${repo}`,
    };
}
function floatStr(n) {
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
function strVal(b) {
    let s = `\`${b.value}\` ${b.unit}`;
    if (b.range) {
        s += ` (\`${b.range}\`)`;
    }
    return s;
}
function commentFooter() {
    var _a;
    const repoMetadata = getCurrentRepoMetadata();
    const repoUrl = (_a = repoMetadata.html_url) !== null && _a !== void 0 ? _a : '';
    const actionUrl = repoUrl + '/actions?query=workflow%3A' + encodeURIComponent(github.context.workflow);
    return `This comment was automatically generated by [workflow](${actionUrl}) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`;
}
function buildComment(benchName, curSuite, prevSuite, expandableDetails = true) {
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
        }
        else {
            line = `| \`${current.name}\` | ${strVal(current)} | | |`;
        }
        lines.push(line);
    }
    // Footer
    lines.push('', expandableDetails ? '</details>' : '', '', commentFooter());
    return lines.join('\n');
}
exports.buildComment = buildComment;
function buildAlertComment(alerts, benchName, curSuite, prevSuite, threshold, cc) {
    // TODO: display with matching units
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
async function leaveComment(commitId, body, commentId, token) {
    core.debug('Sending comment:\n' + body);
    const repoMetadata = getCurrentRepoMetadata();
    const pr = github.context.payload.pull_request;
    return await ((pr === null || pr === void 0 ? void 0 : pr.number)
        ? (0, leavePRComment_1.leavePRComment)(repoMetadata.owner.login, repoMetadata.name, pr.number, body, commentId, token)
        : (0, leaveCommitComment_1.leaveCommitComment)(repoMetadata.owner.login, repoMetadata.name, commitId, body, commentId, token));
}
async function handleComment(benchName, curSuite, prevSuite, config) {
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
async function handleAlert(benchName, curSuite, prevSuite, config) {
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
        }
        else {
            core.debug(`${len} alerts exceeding the alert threshold ${alertThreshold} were found but` +
                ` none of them exceeded the failure threshold ${threshold}`);
        }
    }
}
function addBenchmarkToDataJson(groupBy, schema, benchName, bench, data, maxItems) {
    var _a;
    const repoMetadata = getCurrentRepoMetadata();
    const htmlUrl = (_a = repoMetadata.html_url) !== null && _a !== void 0 ? _a : '';
    let prevBench = null;
    data.lastUpdate = Date.now();
    if (!data.groupBy) {
        data.groupBy = {};
    }
    if (!data.schema) {
        data.schema = {};
    }
    data.groupBy[benchName] = groupBy;
    data.repoUrl = htmlUrl;
    data.schema[benchName] = schema;
    // Add benchmark result
    if (data.entries[benchName] === undefined) {
        data.entries[benchName] = [bench];
        core.debug(`No suite was found for benchmark '${benchName}' in existing data. Created`);
    }
    else {
        const suites = data.entries[benchName];
        for (const e of suites.slice().reverse()) {
            if (e.commit.id !== bench.commit.id) {
                prevBench = e;
                break;
            }
        }
        suites.push(bench);
        if (maxItems !== null && suites.length > maxItems) {
            suites.splice(0, suites.length - maxItems);
            core.debug(`Number of data items for '${benchName}' was truncated to ${maxItems} due to max-items-in-charts`);
        }
    }
    return prevBench;
}
function isRemoteRejectedError(err) {
    if (err instanceof Error) {
        return ['[remote rejected]', '[rejected]'].some((l) => err.message.includes(l));
    }
    return false;
}
async function writeBenchmarkToGitHubPagesWithRetry(bench, config, retry) {
    var _a, _b;
    const { name, ghPagesBranch, ghRepository, githubToken, autoPush, skipFetchGhPages, maxItemsInChart, groupBy, schema, basePath, } = config;
    const rollbackActions = new Array();
    // TODO: identify which of the below cases are needed. Potentially always
    // require the gh-repository field.
    let isPrivateRepo = null;
    try {
        isPrivateRepo = (_b = (_a = github.context.payload.repository) === null || _a === void 0 ? void 0 : _a.private) !== null && _b !== void 0 ? _b : false;
    }
    catch (error) {
        if (error instanceof Error) {
            core.warning(error.message);
        }
        else {
            core.warning('An unknown error occurred');
        }
    }
    let benchmarkBaseDir = './';
    let extraGitArguments = [];
    if (githubToken && !skipFetchGhPages && ghRepository) {
        benchmarkBaseDir = './benchmark-data-repository';
        await git.clone(githubToken, ghRepository, benchmarkBaseDir);
        rollbackActions.push(async () => {
            await io.rmRF(benchmarkBaseDir);
        });
        extraGitArguments = [`--work-tree=${benchmarkBaseDir}`, `--git-dir=${benchmarkBaseDir}/.git`];
        await git.checkout(ghPagesBranch, extraGitArguments);
    }
    else if (!skipFetchGhPages && (isPrivateRepo === false || githubToken)) {
        await git.pull(githubToken, ghPagesBranch);
    }
    else if (isPrivateRepo === true && !skipFetchGhPages) {
        core.warning("'git pull' was skipped. If you want to ensure GitHub Pages branch is up-to-date " +
            "before generating a commit, please set 'github-token' input to pull GitHub pages branch");
    }
    else {
        console.warn('NOTHING EXECUTED:', {
            skipFetchGhPages,
            ghRepository,
            isPrivateRepo,
            githubToken: !!githubToken,
        });
    }
    // `benchmarkDataDirPath` is an absolute path at this stage,
    // so we need to convert it to relative to be able to prepend the `benchmarkBaseDir`
    const dataEntry = getDataEntry();
    if (!dataEntry) {
        // sometimes we don't want to push the benchmark data (e.g. on the merge queue).
        // in this case, skip the below.
        console.warn('No data path could be built');
        return;
    }
    let dataRelativePath = getDataPath(dataEntry);
    dataRelativePath = path.join(basePath, dataRelativePath);
    const dataPath = path.join(benchmarkBaseDir, dataRelativePath);
    await io.mkdirP(path.dirname(dataPath));
    const data = await loadDataJson(dataPath);
    addBenchmarkToDataJson(groupBy, schema, name, bench, data, maxItemsInChart);
    await storeDataJson(dataPath, data);
    // handle the listing
    const listingPath = path.join(basePath, 'listing.json');
    const listing = await loadListing(benchmarkBaseDir, listingPath);
    await updateAndStoreListing(benchmarkBaseDir, listingPath, listing, dataEntry);
    await git.cmd(extraGitArguments, 'add', listingPath);
    await git.cmd(extraGitArguments, 'add', dataRelativePath);
    await addIndexHtmlIfNeeded(extraGitArguments, benchmarkBaseDir, path.join(basePath, 'index.html'));
    await git.cmd(extraGitArguments, 'commit', '-m', `add ${name} benchmark result for ${bench.commit.id}`);
    if (githubToken && autoPush) {
        try {
            await git.push(githubToken, ghRepository, ghPagesBranch, extraGitArguments);
            console.log(`Automatically pushed the generated commit to ${ghPagesBranch} branch since 'auto-push' is set to true`);
        }
        catch (err) {
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
                core.warning(`Retrying to generate a commit and push to remote ${ghPagesBranch} with retry count ${retry}...`);
                await writeBenchmarkToGitHubPagesWithRetry(bench, config, retry - 1); // Recursively retry
                return;
            }
            else {
                core.warning(`Failed to add benchmark data to '${name}' data: ${JSON.stringify(bench)}`);
                throw new Error(`Auto-push failed 3 times since the remote branch ${ghPagesBranch} rejected pushing all the time. Last exception was: ${err.message}`);
            }
        }
    }
    else {
        core.debug(`Auto-push to ${ghPagesBranch} is skipped because it requires both 'github-token' and 'auto-push' inputs`);
    }
}
async function writeBenchmarkToGitHubPages(bench, config) {
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
    }
    catch (e) {
        console.warn(e);
        throw e;
    }
    finally {
        if (!ghRepository) {
            // `git switch` does not work for backing to detached head
            await git.cmd([], 'checkout', '-');
        }
    }
}
async function writeBenchmarkToExternalJson(bench, jsonFilePath, config) {
    const { name, maxItemsInChart, saveDataFile, groupBy, schema } = config;
    const data = await loadDataJson(jsonFilePath);
    const prevBench = addBenchmarkToDataJson(groupBy, schema, name, bench, data, maxItemsInChart);
    if (!saveDataFile) {
        core.debug('Skipping storing benchmarks in external data file');
        return null;
    }
    try {
        const jsonDirPath = path.dirname(jsonFilePath);
        await io.mkdirP(jsonDirPath);
        await fs_1.promises.writeFile(jsonFilePath, JSON.stringify(data, null, 2), 'utf8');
    }
    catch (err) {
        throw new Error(`Could not store benchmark data as JSON at ${jsonFilePath}: ${err}`);
    }
    return prevBench;
}
async function writeBenchmark(bench, config) {
    const { name, externalDataJsonPath } = config;
    let prevBench;
    if (externalDataJsonPath) {
        console.log('Writing to external JSON');
        prevBench = await writeBenchmarkToExternalJson(bench, externalDataJsonPath, config);
    }
    else {
        console.log('Writing to GitHub Pages');
        prevBench = await getPrevBench(name, config);
        await writeBenchmarkToGitHubPages(bench, config);
    }
    // Put this after `git push` for reducing possibility to get conflict on push. Since sending
    // comment take time due to API call, do it after updating remote branch.
    if (!prevBench) {
        core.debug('Alert check was skipped because previous benchmark result was not found');
    }
    else {
        await handleComment(name, bench, prevBench, config);
        await handleSummary(name, bench, prevBench, config);
        await handleAlert(name, bench, prevBench, config);
    }
}
exports.writeBenchmark = writeBenchmark;
async function handleSummary(benchName, currBench, prevBench, config) {
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
function adjustUnitValue(result) {
    // XXX: should unify unit format in action output
    // XXX: assumes duration
    const unit = result.unit;
    const value = result.value;
    let newValue;
    switch (unit) {
        // micro
        case '\u03bcs/iter':
        case '\u00b5s/iter':
        case 'us/iter':
            newValue = value * 1000;
            break;
        case 'ns/iter':
            newValue = value;
            break;
        case 'ms/iter':
            newValue = value * 1000000;
            break;
        case 's/iter':
            newValue = value * 1000000000;
            break;
        default:
            // XXX: could not parse unit
            core.debug(`Could not convert unit: ${unit}.`);
            return value;
    }
    return newValue;
}
function getRatio(biggerIsBetter, prev, current) {
    if (prev.value === 0 && current.value === 0)
        return 1;
    let prevValue;
    let currentValue;
    if (prev.unit === current.unit) {
        prevValue = prev.value;
        currentValue = current.value;
    }
    else {
        prevValue = adjustUnitValue(prev);
        currentValue = adjustUnitValue(current);
    }
    return biggerIsBetter
        ? prevValue / currentValue // e.g. current=100, prev=200
        : currentValue / prevValue; // e.g. current=200, prev=100
}
//# sourceMappingURL=write.js.map