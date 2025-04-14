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

main().catch((e) => {
    function stackTrace(e: Error): string {
        const prefix = 'Error: ' + e.message;
        // get the stack trace without the error message
        const stackTrace = String(e.stack).replace(prefix, 'Stack trace:');

        return stackTrace;
    }
    console.log(stackTrace(e));

    core.setFailed(e.message);
});
