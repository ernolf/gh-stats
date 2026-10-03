<!--
SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
SPDX-License-Identifier: MIT
-->

# gh-stats

<p>
  <a href="https://api.reuse.software/info/github.com/ernolf/gh-stats"><img alt="REUSE status" src="https://api.reuse.software/badge/github.com/ernolf/gh-stats"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Bash" src="https://img.shields.io/badge/shell-bash-4EAA25">
</p>

Download statistics and release analysis for projects that publish on GitHub, with the Nextcloud App Store as the main use case.

GitHub only exposes the current cumulative `download_count` of each release asset: no history, no downloads per hour, day or week. gh-stats samples those counters on a schedule into a change-only SQLite time series and answers questions over any interval. For Nextcloud apps it adds the other side: what a release is built from and how it compares with what the App Store ships.

> **📖 The documentation lives in the [wiki](https://github.com/ernolf/gh-stats/wiki).** This page is the short version.

> **Early development.** gh-stats is under active development. The command line tools are in daily use, the planned web interface does not exist yet, and options, the database schema and the output formats may still change.

## Tools

| Tool | What it does |
|---|---|
| `gh-release-sampler` | Runs from cron and records the download count of every release asset of the configured owners and repositories, writing a row only when a value changed. Also records stars, forks and watchers. |
| `gh-stats` | Queries the series: current totals, deltas over any interval, hourly rates, grouped by owner, repo, tag, major version or asset, as a table, time series table or chart. |
| `gh-appstore-targets` | Builds the sampler's target list from the Nextcloud App Store catalogue, so every app that releases on GitHub is sampled without a hand-kept list. |
| `nc-appsdiag` | Diagnoses a Nextcloud app release: clones it at the tag the App Store ships, runs the [ncmake](https://github.com/ernolf/ncmake) analysers and build against it, and compares what `make dist` stages with the published tarball. Runs one app or a whole list unattended. |
| `nc-appslist` | Writes the app list for `nc-appsdiag -l` from the App Store catalogue: one repository per line with its newest stable version. |

## Requirements

* Linux with `bash` and GNU coreutils
* [`gh`](https://cli.github.com/), authenticated, plus `jq` and `sqlite3`
* `nc-appsdiag` additionally needs `git`, `curl`, `make` and whatever the measured app builds with (Node.js, Composer)

## Quick start

```sh
R=https://raw.githubusercontent.com/ernolf/gh-stats/main/bin
for t in gh-release-sampler gh-stats; do sudo curl -fL "$R/$t" -o "/usr/local/bin/$t"; done
sudo chmod 0755 /usr/local/bin/gh-release-sampler /usr/local/bin/gh-stats
sudo mkdir -p /etc/gh-stats && echo '{"targets":["ernolf"]}' | sudo tee /etc/gh-stats/targets.json
echo '5,35 * * * * root /usr/local/bin/gh-release-sampler >/dev/null 2>&1' | sudo tee /etc/cron.d/gh-stats
```

Then query, e.g. `gh-stats now --owner=ernolf` or `gh-stats 7d --by=repo`. Every run costs about two API requests per sampled repository against the 5000 per hour of the authenticated account, so size the target list and the interval together. `etc/` holds a sample of both configuration files.

## License

[MIT](LICENSE)
