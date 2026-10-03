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

> [!TIP]
> **📖 The documentation lives in the [wiki](https://github.com/ernolf/gh-stats/wiki).**

> [!IMPORTANT]
> **Early development.** gh-stats is under active development. The command line tools are in daily use, the planned web interface does not exist yet, and options, the database schema and the output formats may still change.
