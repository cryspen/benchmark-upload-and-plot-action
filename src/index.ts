import * as core from '@actions/core';
import { configFromJobInput } from './config';
import { loadResult } from './load';
import { writeBenchmark } from './write';

async function main() {
    console.log(`Extracting config from job...`);
    const config = await configFromJobInput();
    console.log(`Config extracted from job`);

    console.log(`Loading benchmark result...`);
    const bench = await loadResult(config);
    console.log(`Benchmark result was loaded`);

    console.log(`Writing benchmark...`);
    await writeBenchmark(bench, config);

    console.log('github-action-benchmark was run successfully!', '\nData:', bench);
}

main().catch((e) => core.setFailed(e.message));
