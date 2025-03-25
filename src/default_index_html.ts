export const DEFAULT_INDEX_HTML = String.raw`<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, minimum-scale=1.0, initial-scale=1, user-scalable=yes"
    />
    <style>
      html {
        font-family:
          BlinkMacSystemFont,
          -apple-system,
          "Segoe UI",
          Roboto,
          Oxygen,
          Ubuntu,
          Cantarell,
          "Fira Sans",
          "Droid Sans",
          "Helvetica Neue",
          Helvetica,
          Arial,
          sans-serif;
        -webkit-font-smoothing: antialiased;
        background-color: #fff;
        font-size: 16px;
      }
      body {
        color: #4a4a4a;
        margin: 8px;
        font-size: 1em;
        font-weight: 400;
      }
      header {
        margin-bottom: 8px;
        display: flex;
        flex-direction: column;
      }
      main {
        width: 100%;
        display: flex;
        flex-direction: column;
      }
      a {
        color: #3273dc;
        cursor: pointer;
        text-decoration: none;
      }
      a:hover {
        color: #000;
      }
      button {
        color: #fff;
        background-color: #3298dc;
        border-color: transparent;
        cursor: pointer;
        text-align: center;
      }
      button:hover {
        background-color: #2793da;
        flex: none;
      }
      .spacer {
        flex: auto;
      }
      .small {
        font-size: 0.75rem;
      }
      footer {
        margin-top: 16px;
        display: flex;
        align-items: center;
      }
      .header-label {
        margin-right: 4px;
      }
      .benchmark-set {
        margin: 8px 0;
        width: 100%;
        display: flex;
        flex-direction: column;
      }
      .benchmark-title {
        font-size: 3rem;
        font-weight: 600;
        word-break: break-word;
        text-align: center;
      }
      .benchmark-graphs {
        display: flex;
        flex-direction: row;
        justify-content: space-around;
        align-items: center;
        flex-wrap: wrap;
        width: 100%;
      }
      .benchmark-chart {
        max-width: 1000px;
      }
    </style>
    <title>Benchmarks</title>
  </head>

  <body>
    <header id="header">
      <div class="header-item">
        <strong class="header-label">Last Update:</strong>
        <span id="last-update"></span>
      </div>
      <div class="header-item">
        <strong class="header-label">Repository:</strong>
        <a id="repository-link" rel="noopener"></a>
      </div>
    </header>
    <main id="main"></main>
    <footer>
      <!--
      <button id="dl-button">Download data as JSON</button>
      <div class="spacer"></div>
      <div class="small">Powered by <a rel="noopener" href="https://github.com/marketplace/actions/continuous-benchmark">github-action-benchmark</a></div>
       -->
    </footer>

    <script
      src="https://cdn.plot.ly/plotly-3.0.0.min.js"
      charset="utf-8"
    ></script>
    <script src="data.js"></script>
    <script id="main-script">
      "use strict";
      (function () {
        // Colors from https://github.com/github/linguist/blob/master/lib/linguist/languages.yml
        const colors = [
          "#dea584",
          "#00add8",
          "#f1e05a",
          "#000080",
          "#3572a5",
          "#f34b7d",
          "#f34b7d",
          "#a270ba",
          "#b07219",
          "#178600",
          "#38ff38",
          "#ff3838",
          "#333333",
        ];

        function init() {
          function collectBenchesPerTestCase(entries) {
            const map = new Map();
            for (const entry of entries) {
              const { commit, date, tool, benches } = entry;
              for (const bench of benches) {
                const result = { commit, date, tool, bench };
                const arr = map.get(bench.name);
                if (arr === undefined) {
                  map.set(bench.name, [result]);
                } else {
                  arr.push(result);
                }
              }
            }
            return map;
          }

          const data = window.BENCHMARK_DATA;

          // Render header
          document.getElementById("last-update").textContent = new Date(
            data.lastUpdate,
          ).toString();
          const repoLink = document.getElementById("repository-link");
          repoLink.href = data.repoUrl;
          repoLink.textContent = data.repoUrl;

          // Prepare data points for charts
          return Object.keys(data.entries).map((name) => ({
            name,
            dataSet: collectBenchesPerTestCase(data.entries[name]),
          }));
        }

        // input: separated-out datasets
        function renderAllCharts(dataSets) {
          function renderGraph(parent, dataSets) {
            const datasets = Array.from(
              dataSets.dataSet.entries().map(([name, dataset], index) => {
                return {
                  name: name,
                  y: dataset.map((d) => d.bench.value),
                };
              }),
            );

            const canvas = document.createElement("canvas");
            canvas.className = "benchmark-chart";
            parent.appendChild(canvas);

            // TODO: more config
            const layout = {
              width: 1200,
              height: 600,
            };

            const plot = Plotly.newPlot(parent, datasets, layout);
          }

          const main = document.getElementById("main");
          const setElem = document.createElement("div");
          setElem.className = "benchmark-set";
          main.appendChild(setElem);

          const nameElem = document.createElement("h1");
          nameElem.className = "benchmark-title";
          nameElem.textContent = "All benchmarks";
          setElem.appendChild(nameElem);

          const graphsElem = document.createElement("div");
          graphsElem.className = "benchmark-graphs";
          setElem.appendChild(graphsElem);

          renderGraph(graphsElem, dataSets[0]);
        }

        renderAllCharts(init()); // Start
      })();
    </script>
  </body>
</html>
`;
