
# GitHub Action for upload and plotting of benchmark data

## Fields
- `name` (required): name of the benchmark
- `input-data-path` (required): a path to a file containing the standardized input data
- `data-out-path` (required): the path where the output of the action should be written

Every entry in the JSON file you provide only needs to provide `name`, `unit`, `platform`,
and `value`. You can also provide optional `range` (results' variance) and
`extra` (any additional information that might be useful to your benchmark's
context) properties. Like this:

```json
[
    {
        "name": "My Custom Smaller Is Better Benchmark - CPU Load",
        "unit": "Percent",
        "platform": "ubuntu-latest",
        "value": 50
    },
    {
        "name": "My Custom Smaller Is Better Benchmark - Memory Used",
        "unit": "Megabytes",
        "platform": "ubuntu-latest",
        "value": 100,
        "range": "3",
        "extra": "Value for Tooltip: 25\nOptional Num #2: 100\nAnything Else!"
    }
]
```

## How to use

This action takes a file that contains benchmark output. And it outputs the results to GitHub Pages
branch and/or alert commit comment.

### Action inputs

Input definitions are written in [action.yml](./action.yml).

#### `name` (Required)

- Type: String
- Default: `"Benchmark"`

Name of the benchmark. This value must be identical across all benchmarks in your repository.


#### `input-data-path` (Required)

- Type: String
- Default: N/A

Path to a file which contains the output from benchmark tool, in the standardized format described above. The path can be relative to repository root.

#### `gh-pages-branch` (Required)

- Type: String
- Default: `"gh-pages"`

Name of your GitHub pages branch.

Note: If you're using `docs/` directory of `main` branch for GitHub pages, please set `gh-pages-branch`
to `main` and `benchmark-data-dir-path` to the directory under `docs` like `docs/dev/bench`.

#### `gh-repository`

- Type: String

Url to an optional different repository to store benchmark results (eg. `github.com/cryspen/benchmark-upload-and-plot-action-results`)

NOTE: if you want to auto push to a different repository you need to use a separate Personal Access Token that has a write access to the specified repository.
If you are not using the `auto-push` option then you can avoid passing the `gh-token` if your data repository is public

#### `benchmark-data-dir-path` (Required)

- Type: String
- Default: `"dev/bench"`

Path to a directory that contains benchmark files on the GitHub pages branch. For example, when this value
is set to `"path/to/bench"`, `https://you.github.io/repo-name/path/to/bench` will be available as benchmarks
dashboard page. If it does not contain `index.html`, this action automatically generates it at first run.
The path can be relative to repository root.

#### `github-token` (Optional)

- Type: String
- Default: N/A

GitHub API access token.

#### `ref` (Optional)

- Type: String
- Default: N/A

Ref to use for reporting the commit

#### `auto-push` (Optional)

- Type: Boolean
- Default: `false`

If it is set to `true`, this action automatically pushes the generated commit to GitHub Pages branch.
Otherwise, you need to push it by your own. Please read 'Commit comment' section above for more details.

#### `comment-always` (Optional)

- Type: Boolean
- Default: `false`

If it is set to `true`, this action will leave a commit comment comparing the current benchmark with previous.
`github-token` is necessary as well.

#### `save-data-file` (Optional)

- Type: Boolean
- Default: `true`

If it is set to `false`, this action will not save the current benchmark to the external data file.
You can use this option to set up your action to compare the benchmarks between PR and base branch.

#### `alert-threshold` (Optional)

- Type: String
- Default: `"200%"`

Percentage value like `"150%"`. It is a ratio indicating how worse the current benchmark result is.
For example, if we now get `150 ns/iter` and previously got `100 ns/iter`, it gets `150%` worse.

If the current benchmark result is worse than previous exceeding the threshold, an alert will happen.
See `comment-on-alert` and `fail-on-alert` also.

#### `comment-on-alert` (Optional)

- Type: Boolean
- Default: `false`

If it is set to `true`, this action will leave a commit comment when an alert happens [like this][alert-comment-example].
`github-token` is necessary as well. For the threshold, please see `alert-threshold` also.

#### `fail-on-alert` (Optional)

- Type: Boolean
- Default: `false`

If it is set to `true`, the workflow will fail when an alert happens. For the threshold for this, please
see `alert-threshold` and `fail-threshold` also.

#### `fail-threshold` (Optional)

- Type: String
- Default: The same value as `alert-threshold`

Percentage value in the same format as `alert-threshold`. If this value is set, the threshold value
will be used to determine if the workflow should fail. Default value is set to the same value as
`alert-threshold` input. **This value must be equal or larger than `alert-threshold` value.**

#### `alert-comment-cc-users` (Optional)

- Type: String
- Default: N/A

Comma-separated GitHub user names mentioned in alert commit comment like `"@foo,@bar"`. These users
will be mentioned in a commit comment when an alert happens. For configuring alerts, please see
`alert-threshold` and `comment-on-alert` also.

#### `external-data-json-path` (Optional)

- Type: String
- Default: N/A

External JSON file which contains benchmark results until previous job run. When this value is set,
this action updates the file content instead of generating a Git commit in GitHub Pages branch.
This option is useful if you don't want to put benchmark results in GitHub Pages branch. Instead,
you need to keep the JSON file persistently among job runs. One option is using a workflow cache
with `actions/cache` action. Please read 'Minimal setup' section above.

#### `max-items-in-chart` (Optional)

- Type: Number
- Default: N/A

Max number of data points in a chart for avoiding too busy chart. This value must be unsigned integer
larger than zero. If the number of benchmark results for some benchmark suite exceeds this value,
the oldest one will be removed before storing the results to file. By default this value is empty
which means there is no limit.

#### `skip-fetch-gh-pages` (Optional)

- Type: Boolean
- Default: `false`

If set to `true`, the workflow will skip fetching branch defined with the `gh-pages-branch` variable.


### Action outputs

No action output is set by this action for the parent GitHub workflow.


### Caveats

#### Run only on your branches

Please ensure that your benchmark workflow runs only on your branches. Please avoid running it on
pull requests. If a branch were pushed to GitHub pages branch on a pull request, anyone who creates
a pull request on your repository could modify your GitHub pages branch.

For this, you can specify a branch that runs your benchmark workflow on `on:` section. Or set the
proper condition to `if:` section of step which pushes GitHub pages.

e.g. Runs on only `main` branch

```yaml
on:
  push:
    branches:
      - main
```

e.g. Push when not running for a pull request

```yaml
- name: Push benchmark result
  run: git push ...
  if: github.event_name != 'pull_request'
```

#### Stability of Virtual Environment

As far as watching the benchmark results of examples in this repository, the amplitude of the benchmarks
is about +- 10~20%. If your benchmarks use some resources such as networks or file I/O, the amplitude
might be bigger.

If the amplitude is not acceptable, please prepare a stable environment to run benchmarks.
GitHub action supports [self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/about-self-hosted-runners).


### Customizing the benchmarks result page

This action creates the default `index.html` in the directory specified with `benchmark-data-dir-path`
input. By default, every benchmark test case has own chart on the page. Charts are drawn with
[Chart.js](https://www.chartjs.org/).

If it does not fit your use case, please modify the HTML file or replace it with your favorite one.
Every benchmark data is stored in `window.BENCHMARK_DATA` so you can create your favorite view.


### Versioning

This action conforms semantic versioning 2.0.

For example, `cryspen/benchmark-upload-and-plot-action@v1` means the latest version of `1.x.y`. And
`cryspen/benchmark-upload-and-plot-action@v1.0.2` always uses `v1.0.2` even if a newer version is published.

`main` branch of this repository is for development and does not work as action.


### Track updates of this action

To notice new version releases, please [watch 'release only'][help-watch-release] at [this repository][proj].
Every release will appear on your GitHub notifications page.



## Future work

- Support pull requests. Instead of updating GitHub pages, add a comment to the pull request to explain
  benchmark results.
- Add more benchmark tools:
  - [airspeed-velocity Python benchmarking tool](https://github.com/airspeed-velocity/asv)
- Allow uploading results to metrics services such as [mackerel](https://en.mackerel.io/)
- Show extracted benchmark data in the output from this action
- Add a table view in dashboard page to see all data points in table



## Related actions

- [lighthouse-ci-action][] is an action for [Lighthouse CI][lighthouse-ci]. If you're measuring performance
  of your web application, using Lighthouse CI and lighthouse-ci-action would be better than using this
  action.



## License

[the MIT License](./LICENSE.txt)


