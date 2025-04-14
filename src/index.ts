import * as core from '@actions/core';
import { configFromJobInput } from './config';
import { loadResult } from './load';
import { writeBenchmark } from './write';

async function main() {
    const config = await configFromJobInput();
    core.debug(`Config extracted from job: ${config}`);

    const bench = await loadResult(config);
    core.debug(`Benchmark result was loaded: ${bench}`);

    await writeBenchmark(bench, config);

    console.log('github-action-benchmark was run successfully!', '\nData:', bench);
}

function stackTrace(e: Error): string {
    // get the stack trace without the error message
    const stackTrace = String(e.stack).split('\n').slice(1).join('\n');

    return `Stack trace:\n${stackTrace}`;
}

main().catch((e) => {
    console.log(stackTrace(e));

    core.setFailed(e.message);
});
