import * as core from '@actions/core';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Config {
    name: string;
    groupBy: string[];
    schema: string[];
    biggerIsBetter: boolean;
    inputDataPath: string; // path to out data
    ghPagesBranch: string;
    ghRepository: string | undefined;
    githubToken: string | undefined;
    autoPush: boolean;
    skipFetchGhPages: boolean;
    commentAlways: boolean;
    summaryAlways: boolean;
    saveDataFile: boolean;
    commentOnAlert: boolean;
    alertThreshold: number;
    failOnAlert: boolean;
    failThreshold: number;
    alertCommentCcUsers: string[];
    externalDataJsonPath: string | undefined;
    basePath: string;
    maxItemsInChart: number | null;
    ref: string | undefined;
}
const RE_UINT = /^\d+$/;

function resolvePath(p: string): string {
    if (p.startsWith('~')) {
        const home = os.homedir();
        if (!home) {
            throw new Error(`Cannot resolve '~' in ${p}`);
        }
        p = path.join(home, p.slice(1));
    }
    return path.resolve(p);
}

async function resolveFilePath(p: string): Promise<string> {
    p = resolvePath(p);

    let s;
    try {
        s = await fs.stat(p);
    } catch (e) {
        throw new Error(`Cannot stat '${p}': ${e}`);
    }

    if (!s.isFile()) {
        throw new Error(`Specified path '${p}' is not a file`);
    }

    return p;
}

async function validateInputDataPath(filePath: string): Promise<string> {
    try {
        return await resolveFilePath(filePath);
    } catch (err) {
        throw new Error(`Invalid value for 'input-data-path' input: ${err}`);
    }
}

function validateGhPagesBranch(branch: string) {
    if (branch) {
        return;
    }
    throw new Error(`Branch value must not be empty for 'gh-pages-branch' input`);
}

function validateName(name: string) {
    if (name) {
        return;
    }
    throw new Error('Name must not be empty');
}

function validateGitHubToken(inputName: string, githubToken: string | undefined, todo: string) {
    if (!githubToken) {
        throw new Error(`'${inputName}' is enabled but 'github-token' is not set. Please give API token ${todo}`);
    }
}

function getBoolInput(name: string): boolean {
    const input = core.getInput(name);
    if (!input) {
        return false;
    }
    if (input !== 'true' && input !== 'false') {
        throw new Error(`'${name}' input must be boolean value 'true' or 'false' but got '${input}'`);
    }
    return input === 'true';
}

function getPercentageInput(name: string): number | null {
    const input = core.getInput(name);
    if (!input) {
        return null;
    }
    if (!input.endsWith('%')) {
        throw new Error(`'${name}' input must ends with '%' for percentage value (e.g. '200%')`);
    }

    const percentage = parseFloat(input.slice(0, -1)); // Omit '%' at last
    if (isNaN(percentage)) {
        throw new Error(`Specified value '${input.slice(0, -1)}' in '${name}' input cannot be parsed as float number`);
    }

    return percentage / 100;
}

function getCommaSeparatedInput(name: string): string[] {
    const input = core.getInput(name);
    if (!input) {
        return [];
    }
    return input.split(',').map((s) => s.trim());
}

function validateAlertCommentCcUsers(users: string[]) {
    for (const u of users) {
        if (!u.startsWith('@')) {
            throw new Error(`User name in 'alert-comment-cc-users' input must start with '@' but got '${u}'`);
        }
    }
}

async function isDir(path: string) {
    try {
        const s = await fs.stat(path);
        return s.isDirectory();
    } catch (_) {
        return false;
    }
}

async function validateExternalDataJsonPath(path: string | undefined, autoPush: boolean): Promise<string | undefined> {
    if (!path) {
        return Promise.resolve(undefined);
    }
    if (autoPush) {
        throw new Error(
            'auto-push must be false when external-data-json-path is set since this action reads/writes the given JSON file and never pushes to remote',
        );
    }
    try {
        const p = resolvePath(path);
        if (await isDir(p)) {
            throw new Error(`Specified path '${p}' must be file but it is actually directory`);
        }
        return p;
    } catch (err) {
        throw new Error(`Invalid value for 'external-data-json-path' input: ${err}`);
    }
}

function getUintInput(name: string): number | null {
    const input = core.getInput(name);
    if (!input) {
        return null;
    }
    if (!RE_UINT.test(input)) {
        throw new Error(`'${name}' input must be unsigned integer but got '${input}'`);
    }
    const i = parseInt(input, 10);
    if (isNaN(i)) {
        throw new Error(`Unsigned integer value '${input}' in '${name}' input was parsed as NaN`);
    }
    return i;
}

function validateMaxItemsInChart(max: number | null) {
    if (max !== null && max <= 0) {
        throw new Error(`'max-items-in-chart' input value must be one or more but got ${max}`);
    }
}

function validateGroupBy(groupBy?: string): string[] {
    if (groupBy === undefined) {
        return ['os'];
    }

    const keys = groupBy.split(',');

    if (keys.length === 1 && keys[0] === '') {
        return ['os'];
    }

    return keys;
}

function validateSchema(schema?: string): string[] {
    const defaultSchema = ['name', 'platform', 'os', 'keySize', 'api', 'category'];
    if (schema === undefined) {
        return defaultSchema;
    }

    const keys = schema.split(',');

    if (keys.length === 1 && keys[0] === '') {
        return defaultSchema;
    }

    return keys;
}

function validateAlertThreshold(alertThreshold: number | null, failThreshold: number | null): asserts alertThreshold {
    if (alertThreshold === null) {
        throw new Error("'alert-threshold' input must not be empty");
    }
    if (failThreshold && alertThreshold > failThreshold) {
        throw new Error(
            `'alert-threshold' value must be smaller than 'fail-threshold' value but got ${alertThreshold} > ${failThreshold}`,
        );
    }
}

export async function configFromJobInput(): Promise<Config> {
    const groupByString: string | undefined = core.getInput('group-by') || undefined;
    const schemaString: string | undefined = core.getInput('schema') || undefined;

    let inputDataPath: string = core.getInput('input-data-path');
    const biggerIsBetter = getBoolInput('bigger-is-better');
    const ghPagesBranch: string = core.getInput('gh-pages-branch');
    const ghRepository: string = core.getInput('gh-repository');
    const name: string = core.getInput('name');
    const githubToken: string | undefined = core.getInput('github-token') || undefined;
    const ref: string | undefined = core.getInput('ref') || undefined;
    const autoPush = getBoolInput('auto-push');
    const skipFetchGhPages = getBoolInput('skip-fetch-gh-pages');
    const commentAlways = getBoolInput('comment-always');
    const summaryAlways = getBoolInput('summary-always');
    const saveDataFile = getBoolInput('save-data-file');
    const commentOnAlert = getBoolInput('comment-on-alert');
    const alertThreshold = getPercentageInput('alert-threshold');
    const failOnAlert = getBoolInput('fail-on-alert');
    const alertCommentCcUsers = getCommaSeparatedInput('alert-comment-cc-users');
    let externalDataJsonPath: undefined | string = core.getInput('external-data-json-path');
    const maxItemsInChart = getUintInput('max-items-in-chart');
    let failThreshold = getPercentageInput('fail-threshold');

    const basePath: string = core.getInput('base-path');
    const groupBy = validateGroupBy(groupByString);
    const schema = validateSchema(schemaString);
    inputDataPath = await validateInputDataPath(inputDataPath);
    validateGhPagesBranch(ghPagesBranch);
    validateName(name);
    if (autoPush) {
        validateGitHubToken('auto-push', githubToken, 'to push GitHub pages branch to remote');
    }
    if (commentAlways) {
        validateGitHubToken('comment-always', githubToken, 'to send commit comment');
    }
    if (commentOnAlert) {
        validateGitHubToken('comment-on-alert', githubToken, 'to send commit comment on alert');
    }
    if (ghRepository) {
        validateGitHubToken('gh-repository', githubToken, 'to clone the repository');
    }
    validateAlertThreshold(alertThreshold, failThreshold);
    validateAlertCommentCcUsers(alertCommentCcUsers);
    externalDataJsonPath = await validateExternalDataJsonPath(externalDataJsonPath, autoPush);
    validateMaxItemsInChart(maxItemsInChart);
    if (failThreshold === null) {
        failThreshold = alertThreshold;
    }

    return {
        schema,
        groupBy,
        name,
        biggerIsBetter,
        inputDataPath,
        ghPagesBranch,
        ghRepository,
        githubToken,
        autoPush,
        skipFetchGhPages,
        commentAlways,
        summaryAlways,
        saveDataFile,
        commentOnAlert,
        alertThreshold,
        failOnAlert,
        alertCommentCcUsers,
        externalDataJsonPath,
        maxItemsInChart,
        failThreshold,
        ref,
        basePath,
    };
}
