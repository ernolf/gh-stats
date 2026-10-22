// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT

'use strict'

// The asset extensions gh-stats counts by default; gh-stats-site-db builds the
// summary from the same list, so a comparison counts what the summary counts.
const ASSETS = ['zip', 'tar.bz2', 'tar.gz', 'tar.xz', 'tgz']
const PERIODS = [1, 7, 30]
const DAY = 86400

const assetFilter = ASSETS.map((e) => `asset GLOB '*.${e}'`).join(' OR ')

let db
let now
let results
let issues
let measured
let measuredLines
// The line rows of each project and the project of each app, for the app pages.
const projectLines = new Map()
let appProjects
// What the start page had ticked and where it was scrolled to, while an app
// page is open.
let startTicks = null
let startScroll = 0

// == Loading ==

// The database is fetched whole: Pages serves it gzip-compressed, which the
// browser undoes on the fly, while a byte range would count compressed bytes.
// The buffer is allocated once at the uncompressed size config.json announces,
// so the database is never held twice while it arrives.
async function fetchDatabase(url, bytes, onProgress) {
	const res = await fetch(url)
	if (!res.ok) {
		throw new Error(`${url}: HTTP ${res.status}`)
	}
	const buf = new Uint8Array(bytes)
	const reader = res.body.getReader()
	let at = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		if (at + value.length > bytes) {
			throw new Error(`${url} is larger than the ${bytes} bytes announced`)
		}
		buf.set(value, at)
		at += value.length
		onProgress(at)
	}
	if (at !== bytes) {
		throw new Error(`${url} ended after ${at} of ${bytes} bytes`)
	}
	return buf
}

function megabytes(n) {
	return (n / 1048576).toFixed(1) + ' MB'
}

// Fills the versions of the "Built with" list. A library missing from versions
// keeps its entry without one.
function showVersions(versions) {
	for (const el of document.querySelectorAll('[data-lib]')) {
		const v = versions[el.dataset.lib]
		if (v) {
			el.textContent = v
		}
	}
}

async function load() {
	const progress = document.getElementById('progress')
	const text = document.getElementById('progress-text')
	try {
		// A new build replaces the database the old config pointed to.
		const res = await fetch('config.json', { cache: 'no-cache' })
		if (!res.ok) {
			throw new Error(`config.json: HTTP ${res.status}`)
		}
		const config = await res.json()
		results = config.results
		issues = config.issues
		showVersions(config.lib ?? {})
		progress.max = config.bytes
		const [SQL, bytes] = await Promise.all([
			initSqlJs({ locateFile: (file) => `lib/sql.js/${file}` }),
			fetchDatabase(config.db, config.bytes, (at) => {
				progress.value = at
				text.textContent = `${megabytes(at)} of ${megabytes(config.bytes)}`
			}),
		])
		db = new SQL.Database(bytes)
	} catch (e) {
		text.textContent = `The database could not be loaded (${e.message}). Reload the page to try again.`
		return
	}
	// The SQLite that sql.js compiled in, as the engine itself reports it.
	showVersions({ SQLite: query('SELECT sqlite_version() AS v')[0].v })
	now = query('SELECT max(ts) AS t FROM runs')[0].t
	const asof = document.getElementById('asof')
	asof.textContent = `Data as of ${date(now, true)} UTC`
	asof.hidden = false
	document.getElementById('loading').hidden = true
	document.getElementById('overview').hidden = false
	initOverview()
}

// == Queries ==

function query(sql, params = {}) {
	const stmt = db.prepare(sql)
	const rows = []
	try {
		stmt.bind(params)
		while (stmt.step()) {
			rows.push(stmt.getAsObject())
		}
	} finally {
		stmt.free()
	}
	return rows
}

// A release the App Store lists as stable counts as stable, as there, even when
// its host flags it as a pre-release or its tag names one; the site shows that
// mismatch. The expression aggregates over releases r of one project and tag.
const MISMATCH = 'max(r.mismatch)'
const MISMATCH_TEXT = 'a pre-release by the flag of its host or by its tag, listed as stable in the App Store'

// One row per project and release line, the newest line of a project first.
function summaryRows() {
	return query(`
		SELECT project, line, host, owner, repo, tag, published, nc, total, d1, d7, d30,
		       (SELECT ${MISMATCH} FROM releases r JOIN projects j ON j.host = r.host AND j.owner = r.owner AND j.repo = r.repo
		         WHERE j.project = summary.project AND r.tag = summary.tag) AS mismatch
		  FROM summary ORDER BY project, line DESC`)
}

function projectRepos() {
	return query('SELECT project, host, owner, repo, since FROM projects ORDER BY project, host, owner, repo')
}

// The apps.owner and apps.repo columns compare without case, as the hosts do;
// they stand on the left so their collation applies.
function projectApps() {
	return query(`
		SELECT DISTINCT j.project, a.id, a.name, d.exapp FROM apps a
		  JOIN projects j ON a.host = j.host AND a.owner = j.owner AND a.repo = j.repo
		  JOIN app_details d ON d.id = a.id
		 ORDER BY j.project, a.name`)
}

// Every catalogue app with its newest release, the newest stable one where it
// has one; an app without a release, as the App Store lists an integration,
// comes without.
function catalogueApps() {
	return query(`
		SELECT d.id, d.exapp, coalesce((SELECT t.name FROM app_texts t WHERE t.id = d.id AND t.lang = 'en'), d.id) AS name,
		       r.version, CAST(strftime('%s', r.created) AS INTEGER) AS published, r.platform
		  FROM app_details d LEFT JOIN app_releases r ON r.id = d.id AND r.version = (
		       SELECT x.version FROM app_releases x WHERE x.id = d.id ORDER BY x.stable DESC, x.created DESC LIMIT 1)
		 ORDER BY d.id`)
}

const MEASUREMENT = `m.dir, m.app_id, m.version, m.tag, m.tarball, m.signed, m.diff,
	(SELECT count(*) FROM findings f WHERE f.dir = m.dir AND f.level = 'warn') AS warn,
	(SELECT count(*) FROM findings f WHERE f.dir = m.dir AND f.id = 'not kept') AS slim`

// A measurement of any version but the newest stable one of its app keeps the
// small results only, so the checks of the large reports are missing from it.
const SLIM = 'The large reports are kept for the newest stable version of the app only.'

// The measurements of each release, keyed by project and tag; a repository that
// holds several apps has one per app. A measurement belongs to the project of
// the repository it measured and to those of the repositories the catalogue
// links for its app, which may be others. The measurements and apps owner and
// repo columns compare without case and stand on the left. Each carries the
// version key and pre-release flag of its release in the project.
function measurementsByRelease() {
	const rows = query(`
		SELECT p.project, ${MEASUREMENT},
		       (SELECT max(r.vkey) FROM releases r JOIN projects k ON k.host = r.host AND k.owner = r.owner AND k.repo = r.repo
		         WHERE k.project = p.project AND r.tag = m.tag) AS vkey,
		       (SELECT max(r.pre) FROM releases r JOIN projects k ON k.host = r.host AND k.owner = r.owner AND k.repo = r.repo
		         WHERE k.project = p.project AND r.tag = m.tag) AS pre
		  FROM measurements m JOIN (
		       SELECT m.dir, j.project FROM measurements m
		         JOIN projects j ON m.host = j.host AND m.owner = j.owner AND m.repo = j.repo
		       UNION
		       SELECT m.dir, j.project FROM measurements m JOIN apps a ON a.id = m.app_id
		         JOIN projects j ON a.host = j.host AND a.owner = j.owner AND a.repo = j.repo) p ON p.dir = m.dir
		 WHERE m.tag IS NOT NULL ORDER BY m.subdir, m.app_id`)
	return Map.groupBy(rows, (r) => `${r.project}\n${r.tag}`)
}

// The measurements of the newest measured stable release of each line, keyed
// by project and line: the host may have a newer release of the line than the
// App Store ships, and that one is not measured yet.
function measurementsByLine(byRelease) {
	const lines = new Map()
	for (const runs of byRelease.values()) {
		const { project, vkey, pre } = runs[0]
		if (vkey === null || pre) {
			continue
		}
		const key = `${project}\n${vkey.slice(0, 12)}`
		if (!lines.has(key) || vkey > lines.get(key)[0].vkey) {
			lines.set(key, runs)
		}
	}
	return lines
}

// The measurements of one app, keyed by the version its info.xml declares.
function measurementsByVersion(id) {
	return Map.groupBy(query(`SELECT ${MEASUREMENT} FROM measurements m WHERE m.app_id = $id`, { $id: id }),
		(r) => r.version)
}

function findingsOf(dir) {
	return query('SELECT tool, level, id, text FROM findings WHERE dir = $dir ORDER BY tool, n', { $dir: dir })
}

// A release of a project is a tag of any of its repositories.
function otherReleases(project, tag) {
	return query(`
		SELECT r.tag, min(r.published) AS published, max(r.vkey) AS vkey,
		       max(r.pre) AS pre, ${MISMATCH} AS mismatch,
		       (SELECT f.spec FROM platforms f JOIN projects k ON f.host = k.host AND f.owner = k.owner AND f.repo = k.repo
		         WHERE k.project = $project AND f.tag = r.tag LIMIT 1) AS nc
		  FROM releases r JOIN projects j ON j.host = r.host AND j.owner = r.owner AND j.repo = r.repo
		 WHERE j.project = $project AND r.tag <> $tag
		 GROUP BY r.tag ORDER BY vkey DESC, published DESC`, { $project: project, $tag: tag })
}

// The same figures gh-stats-site-db writes to the summary, for any release: the
// value of an asset at a time is its last sample at or before it, an asset
// without one did not exist yet, the assets of all repositories of the project
// add up, and a period is left out when the release or the sampling of a
// repository with its assets is younger than it.
function releaseFigures(project, tag) {
	const p = { $project: project, $tag: tag }
	const at = {}
	for (const r of query(`
		WITH assets AS (
		  SELECT DISTINCT s.host, s.owner, s.repo, s.asset FROM samples s
		    JOIN projects j ON s.host = j.host AND s.owner = j.owner AND s.repo = j.repo
		   WHERE j.project = $project AND s.tag = $tag AND (${assetFilter})
		), k(d) AS (VALUES (0), (1), (7), (30))
		SELECT k.d, sum(coalesce((
		         SELECT s.downloads FROM samples s
		          WHERE s.host = a.host AND s.owner = a.owner AND s.repo = a.repo AND s.tag = $tag AND s.asset = a.asset
		            AND s.ts <= $now - k.d * ${DAY}
		          ORDER BY s.ts DESC LIMIT 1), 0)) AS v
		  FROM assets a, k GROUP BY k.d`, { ...p, $now: now })) {
		at[r.d] = r.v
	}
	const repos = query(`
		SELECT j.host, j.owner, j.repo, j.first,
		       EXISTS (SELECT 1 FROM samples s WHERE s.host = j.host AND s.owner = j.owner AND s.repo = j.repo
		                  AND s.tag = $tag AND (${assetFilter})) AS has,
		       EXISTS (SELECT 1 FROM releases r WHERE j.host = r.host AND j.owner = r.owner AND j.repo = r.repo
		                  AND r.tag = $tag) AS tagged
		  FROM projects j WHERE j.project = $project ORDER BY j.host, j.owner, j.repo`, p)
	const { published, mismatch, nc } = query(`
		SELECT (SELECT min(r.published) FROM releases r JOIN projects j ON j.host = r.host AND j.owner = r.owner AND j.repo = r.repo
		         WHERE j.project = $project AND r.tag = $tag) AS published,
		       (SELECT ${MISMATCH} FROM releases r JOIN projects j ON j.host = r.host AND j.owner = r.owner AND j.repo = r.repo
		         WHERE j.project = $project AND r.tag = $tag) AS mismatch,
		       (SELECT f.spec FROM platforms f JOIN projects j ON f.host = j.host AND f.owner = j.owner AND f.repo = j.repo
		         WHERE j.project = $project AND f.tag = $tag LIMIT 1) AS nc`, p)[0]
	// Like max() and min() in SQL, these skip a repository that was never sampled.
	const sampled = (rows) => rows.map((r) => r.first).filter((f) => f !== null)
	const withAssets = sampled(repos.filter((r) => r.has))
	const all = sampled(repos)
	const first = repos.some((r) => r.has)
		? (withAssets.length ? Math.max(...withAssets) : null)
		: (all.length ? Math.min(...all) : null)
	const home = repos.filter((r) => r.tagged).sort((a, b) => b.has - a.has)[0]
	const total = at[0] ?? 0
	const fig = { host: home.host, owner: home.owner, repo: home.repo, tag, published, mismatch, nc, total }
	for (const d of PERIODS) {
		fig['d' + d] = first !== null && Math.max(published, first) <= now - d * DAY ? total - (at[d] ?? 0) : null
	}
	return fig
}

// == Overview ==

function date(ts, withTime = false) {
	const iso = new Date(ts * 1000).toISOString()
	return withTime ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10)
}

// A line key is the first two six-digit components of the version key.
function lineLabel(line) {
	return `${Number(line.slice(0, 6))}.${Number(line.slice(6, 12))}`
}

// A date, 2026-01-15 or 15.01.2026, or a period back from the time of the
// data: 30 days, 2 weeks, 6 months, 1 year, or short 30d, 2w, 6m, 1y. Empty
// text gives 0, text that is neither gives null.
function sinceTime(text) {
	const s = text.trim().toLowerCase()
	if (!s) {
		return 0
	}
	const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
	const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s)
	if (iso || dotted) {
		const [y, m, d] = (iso ? iso.slice(1) : dotted.slice(1).reverse()).map(Number)
		const t = new Date(Date.UTC(y, m - 1, d))
		// Date.UTC rolls 31.02. over into March.
		return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.getTime() / 1000 : null
	}
	const period = /^(\d+)\s*(d|days?|w|weeks?|m|months?|y|years?)$/.exec(s)
	if (!period) {
		return null
	}
	const n = Number(period[1])
	const t = new Date(now * 1000)
	if (period[2][0] === 'y') {
		t.setUTCFullYear(t.getUTCFullYear() - n)
	} else if (period[2][0] === 'm') {
		t.setUTCMonth(t.getUTCMonth() - n)
	} else {
		t.setUTCDate(t.getUTCDate() - n * (period[2][0] === 'w' ? 7 : 1))
	}
	return t.getTime() / 1000
}

// The steps of the slider beside Released since; one past the last is no limit.
const SINCE_STEPS = ['1d', '1w', '2w', '1m', '3m', '6m', '1y', '2y', '3y']

// The steps grow about geometrically, so the nearest one to a time is the one
// whose period differs from its age by the smallest factor.
function sinceStep(t) {
	if (!t) {
		return SINCE_STEPS.length
	}
	const off = (s) => Math.abs(Math.log(Math.max(now - t, 1) / (now - sinceTime(s))))
	return SINCE_STEPS.reduce((best, s, i) => (off(s) < off(SINCE_STEPS[best]) ? i : best), 0)
}

// The catalogue writes the range as ">=32 <=34".
function ncRange(spec) {
	if (!spec) {
		return ''
	}
	const m = /^>=\s*([\d.]+)(?:\s+<=\s*([\d.]+))?$/.exec(spec.trim())
	if (!m) {
		return spec
	}
	if (m[2] === undefined) {
		return `${m[1]}+`
	}
	return m[1] === m[2] ? m[1] : `${m[1]}–${m[2]}`
}

function el(tag, attrs = {}, ...children) {
	const e = document.createElement(tag)
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') {
			e.className = v
		} else {
			e.setAttribute(k, v)
		}
	}
	e.append(...children)
	return e
}

// Forgejo and Gitea name a repository and its releases with the paths GitHub uses.
function repoUrl(r) {
	return `https://${r.host}/${r.owner}/${r.repo}`
}

// A repository on GitHub is named owner/repo, one on another host host/owner/repo.
function slugOf(r) {
	return r.host === 'github.com' ? `${r.owner}/${r.repo}` : `${r.host}/${r.owner}/${r.repo}`
}

const UNREACHABLE_TEXT = 'the repository has answered 404 since then; its figures are the last ones it answered'

// since is the run of the first 404 of a repository the sampler counts as
// unreachable, NULL for any other.
function unreachableMark(r) {
	return r.since === null ? [] : [el('span', { class: 'unreachable', title: UNREACHABLE_TEXT }, `unreachable since ${date(r.since)}`)]
}

function releaseLink(fig) {
	return el('a', { href: `${repoUrl(fig)}/releases/tag/${encodeURIComponent(fig.tag)}` }, fig.tag)
}

function mismatchMark() {
	return el('span', { class: 'mismatch', role: 'img', 'aria-label': MISMATCH_TEXT, title: MISMATCH_TEXT }, '⚠')
}

function releaseCells(fig) {
	return [
		el('td', { class: 'tag' }, releaseLink(fig), ...(fig.mismatch ? [mismatchMark()] : [])),
		el('td', {}, ncRange(fig.nc)),
		el('td', {}, date(fig.published)),
		...['total', ...PERIODS.map((d) => 'd' + d)].map((k) => fig[k] === null
			? el('td', { class: 'num na', title: 'the release or its sampling is younger than this period' })
			: el('td', { class: 'num' }, fig[k].toLocaleString('en'))),
	]
}

// The compare drop-down is filled on first use: all releases of every project
// at once would be tens of thousands of options. The releases of the row's own
// line come first, the other lines follow from the newest.
function compareSelect(row) {
	const select = el('select', { 'aria-label': `Compare ${row.tag} with` },
		el('option', { value: '' }, 'none'))
	let filled = false
	const fill = () => {
		if (filled) {
			return
		}
		filled = true
		const lines = new Map()
		for (const r of otherReleases(row.project, row.tag)) {
			const line = r.vkey.slice(0, 12)
			if (!lines.has(line)) {
				lines.set(line, el('optgroup', { label: `line ${lineLabel(line)}` }))
			}
			const notes = [date(r.published), r.nc && `Nextcloud ${ncRange(r.nc)}`, r.pre && 'pre-release',
				r.mismatch && `⚠ ${MISMATCH_TEXT}`]
			lines.get(line).append(el('option', { value: r.tag }, `${r.tag} (${notes.filter(Boolean).join(', ')})`))
		}
		if (lines.has(row.line)) {
			select.append(lines.get(row.line))
		}
		for (const [line, group] of lines) {
			if (line !== row.line) {
				select.append(group)
			}
		}
	}
	select.addEventListener('focus', fill)
	select.addEventListener('pointerdown', fill)
	select.addEventListener('change', () => {
		row.compare.replaceChildren()
		row.compare.hidden = !select.value
		const [checks, checksRow] = checksCell(select.value && measured.get(`${row.project}\n${select.value}`), 10)
		row.compareChecks.replaceWith(checksRow)
		row.compareChecks = checksRow
		if (select.value) {
			row.compare.append(el('td'), el('td', { class: 'compare-label' }, 'compared with'),
				...releaseCells(releaseFigures(row.project, select.value)), checks, el('td'))
		}
	})
	return select
}

// == Checks ==

function finding(f) {
	return el('div', { class: `finding ${f.level ?? ''}` },
		el('span', { class: 'level' }, f.level ?? ''), ' ', el('code', {}, f.id ?? ''), el('pre', {}, f.text))
}

// The release diff compares the tarball the App Store ships with the tree the
// build stages, by kind of difference and class of file.
function diffText(m) {
	if (m.diff === null) {
		return m.tarball ? `Release tarball ${m.tarball} not compared.` : 'No release tarball.'
	}
	const kinds = Object.entries(JSON.parse(m.diff)).map(([kind, classes]) => {
		const n = Object.values(classes).reduce((a, b) => a + b, 0)
		return `${kind} ${n} (${Object.entries(classes).map(([c, k]) => `${c} ${k}`).join(', ')})`
	})
	return `Release tarball ${m.tarball}${m.signed ? ', signed' : ''}: ${kinds.join(', ') || 'no entries'}.`
}

// Warnings in full, grouped by the tool that found them, the tools with
// warnings first; ok and info only as counts that open on demand.
function checksBlock(m) {
	const hasWarn = (fs) => fs.some((f) => f.level === 'warn')
	const tools = [...Map.groupBy(findingsOf(m.dir), (f) => f.tool)].sort(([, a], [, b]) => hasWarn(b) - hasWarn(a))
	return el('section', { class: 'run' },
		el('h4', {}, `${m.app_id ?? m.dir} ${m.version ?? ''} `, el('a', { href: `${results}/${m.dir}` }, 'run directory')),
		el('p', {}, diffText(m)),
		...(m.slim ? [el('p', { class: 'hint' }, SLIM)] : []),
		...tools.map(([tool, fs]) => {
			const rest = fs.filter((f) => f.level !== 'warn')
			const counts = ['ok', 'info'].map((l) => [l, rest.filter((f) => f.level === l).length]).filter(([, n]) => n)
			return el('div', { class: 'tool' }, el('h5', {}, tool),
				...fs.filter((f) => f.level === 'warn').map(finding),
				...(rest.length
					? [el('details', {}, el('summary', {}, counts.map(([l, n]) => `${n} ${l}`).join(', ')), ...rest.map(finding))]
					: []))
		}))
}

// The cell counts the warnings of the measurements of a release; a click opens
// them in the row returned with it, built on first use, which spans the
// table from its second column. A version given names the release measured
// when it is another than the one the row shows.
function checksCell(runs, span, version = null) {
	const checks = el('tr', { class: 'checks', hidden: '' })
	if (!runs) {
		return [el('td', { class: 'check-col', title: 'not measured' }), checks]
	}
	const warn = warnings(runs)
	const button = el('button', {
		type: 'button',
		class: warn ? 'check-count warn' : 'check-count',
		'aria-expanded': 'false',
		title: `${warn} warning${warn === 1 ? '' : 's'} in ${runs.length} measurement${runs.length === 1 ? '' : 's'}${version ? ` of ${version}` : ''}${runs.some((m) => m.slim) ? `. ${SLIM}` : ''}`,
	}, warn ? `⚠ ${warn}` : '✓')
	button.addEventListener('click', () => {
		if (!checks.hasChildNodes()) {
			checks.append(el('td'), el('td', { colspan: String(span) }, ...runs.map(checksBlock)))
		}
		checks.hidden = !checks.hidden
		button.setAttribute('aria-expanded', String(!checks.hidden))
	})
	return [el('td', { class: 'check-col' }, button, ...(version ? [' ', el('span', { class: 'check-of' }, version)] : [])), checks]
}

// The warnings of the measurements of a release, null when it has none, so an
// unmeasured row sorts like an empty period.
function warnings(runs) {
	return runs ? runs.reduce((n, m) => n + m.warn, 0) : null
}

// The checks of a line row: those of the release it shows, else those of the
// newest measured release of its line, with that release's version. The row
// keeps the count of the cell to sort by.
function lineChecks(row, span) {
	const own = measured.get(`${row.project}\n${row.tag}`)
	if (own) {
		row.warn = warnings(own)
		return checksCell(own, span)
	}
	const runs = measuredLines.get(`${row.project}\n${row.line}`)
	row.warn = warnings(runs)
	return checksCell(runs, span, runs?.[0].version ?? runs?.[0].tag)
}

// The tick puts the row into the charts.
function lineRows(row, first) {
	row.pick = el('input', { type: 'checkbox', 'aria-label': `Chart ${row.name} line ${lineLabel(row.line)}` })
	row.pick.addEventListener('change', () => pickRow(row, row.pick.checked))
	const [checks, checksRow] = lineChecks(row, 10)
	row.checks = checksRow
	row.tr = el('tr', {}, el('td', { class: 'pick' }, row.pick), first, ...releaseCells(row), checks, el('td'))
	row.compare = el('tr', { class: 'compare', hidden: '' })
	row.compareChecks = el('tr', { class: 'checks', hidden: '' })
	row.tr.lastChild.append(compareSelect(row))
	return [row.tr, row.checks, row.compare, row.compareChecks]
}

// A project whose apps are all ExApps goes to their tab, one with any other app
// to the apps, and one without an app to the rest.
function projectTab(apps) {
	if (!apps.length) {
		return 'other'
	}
	return apps.every((a) => a.exapp) ? 'exapps' : 'apps'
}

// A catalogue app no project row shows has the row of what the App Store lists:
// its releases are downloaded from elsewhere than a release of GitHub, Forgejo or
// Gitea or not sampled, or it
// has none. Its download columns stay empty, so there is nothing to chart or
// compare.
function catalogueRow(a) {
	const released = a.version !== null
	const p = {
		tab: !released ? 'other' : a.exapp ? 'exapps' : 'apps',
		name: a.name, tag: a.version, published: a.published,
		total: null, d1: null, d7: null, d30: null, lines: [],
		search: `${a.name} ${a.id}`.toLowerCase(),
	}
	const runs = p.tab === 'apps' ? measurementsByVersion(a.id).get(a.version) : undefined
	p.warn = warnings(runs)
	const [checks, checksRow] = checksCell(runs, 10)
	const empty = released ? { class: 'num na', title: 'gh-stats samples no GitHub, Forgejo or Gitea release of this app' } : { class: 'num' }
	p.main = el('tbody', {}, el('tr', {},
		el('td', { class: 'pick' }),
		el('td', {}, el('span', { class: 'name' }, el('a', { href: `#app/${encodeURIComponent(a.id)}` }, a.name))),
		el('td', { class: 'tag' }, a.version ?? ''),
		el('td', {}, ncRange(a.platform)),
		el('td', {}, a.published === null ? '' : date(a.published)),
		...['total', ...PERIODS].map(() => el('td', empty)),
		checks, el('td')), checksRow)
	p.older = el('tbody', { class: 'older', hidden: '' })
	p.toggle = el('button', { type: 'button', class: 'toggle', hidden: '' })
	return p
}

function initOverview() {
	initCharts()
	measured = measurementsByRelease()
	measuredLines = measurementsByLine(measured)
	const repos = Map.groupBy(projectRepos(), (r) => r.project)
	const apps = Map.groupBy(projectApps(), (r) => r.project)
	appProjects = new Map([...apps.values()].flat().map((a) => [a.id, a.project]))
	const projects = [...Map.groupBy(summaryRows(), (r) => r.project)].map(([project, lines]) => {
		const [main, ...older] = lines
		const members = repos.get(project)
		const own = apps.get(project) ?? []
		const p = { project, tab: projectTab(own), name: own.map((a) => a.name).join(', ') || main.repo, ...main, lines: older }
		for (const r of lines) {
			r.name = p.name
		}
		projectLines.set(project, lines)
		p.search = `${p.name} ${members.map(slugOf).join(' ')}`.toLowerCase()

		// Each app links its page; a project that is no App Store app has none.
		const links = own.flatMap((a, i) => [i ? ', ' : '', el('a', { href: `#app/${encodeURIComponent(a.id)}` }, a.name)])
		const head = el('td', {}, el('span', { class: 'name' }, ...(links.length ? links : [p.name])),
			...members.flatMap((r) => [el('a', { class: 'slug', href: repoUrl(r) }, slugOf(r)), ...unreachableMark(r)]))
		p.main = el('tbody', {}, ...lineRows(main, head))
		p.warn = main.warn
		p.older = el('tbody', { class: 'older', hidden: '' },
			...older.flatMap((r) => lineRows(r, el('td', { class: 'line-label' }, `line ${lineLabel(r.line)}`))))
		p.toggle = el('button', { type: 'button', class: 'toggle', 'aria-expanded': 'false' })
		p.toggle.addEventListener('click', () => {
			p.older.hidden = !p.older.hidden
			p.toggle.setAttribute('aria-expanded', String(!p.older.hidden))
		})
		head.append(p.toggle)
		return p
	})
	const shown = new Set(projects.flatMap((p) => (apps.get(p.project) ?? []).map((a) => a.id)))
	projects.push(...catalogueApps().filter((a) => !shown.has(a.id)).map(catalogueRow))

	const table = document.querySelector('#overview table')
	const tabs = document.querySelectorAll('#tabs button')
	const nameHead = document.querySelector('th[data-sort="name"]')
	let tab = 'apps'
	// Each tab keeps its own ticks, so the charts show the rows of the tab shown.
	const ticks = new Map()
	const filter = document.getElementById('filter')
	const since = document.getElementById('since')
	const sinceDate = document.getElementById('since-date')
	const sinceRange = document.getElementById('since-range')
	const sinceHelp = document.getElementById('since-help')
	const sinceHelpToggle = document.getElementById('since-help-toggle')
	let sortKey = 'total'
	let sortDesc = true

	const render = () => {
		const f = filter.value.trim().toLowerCase()
		const t = sinceTime(since.value)
		since.setAttribute('aria-invalid', String(t === null))
		sinceDate.value = t ? `from ${date(t)}` : ''
		sinceRange.setAttribute('aria-valuetext', SINCE_STEPS[Number(sinceRange.value)] ?? 'no limit')
		// A line counts by the release it shows; a project stays while any of
		// its lines does, with the row of its newest line.
		const from = t ?? 0
		// Empty periods sort last in either direction.
		projects.sort((a, b) => {
			const x = a[sortKey]
			const y = b[sortKey]
			if (x === null || y === null) {
				return (x === null) - (y === null)
			}
			const c = typeof x === 'string' ? x.localeCompare(y) : x - y
			return sortDesc ? -c : c
		})
		for (const tbody of table.querySelectorAll('tbody')) {
			tbody.remove()
		}
		const frag = document.createDocumentFragment()
		for (const p of projects) {
			const older = p.lines.filter((r) => r.published >= from)
			if (p.tab !== tab || (f && !p.search.includes(f)) || (p.published < from && !older.length)) {
				continue
			}
			p.older.replaceChildren(...older.flatMap((r) => [r.tr, r.checks, r.compare, r.compareChecks]))
			p.toggle.hidden = !older.length
			p.toggle.textContent = `${older.length} older line${older.length > 1 ? 's' : ''}`
			frag.append(p.main, p.older)
		}
		table.append(frag)
		for (const th of document.querySelectorAll('th[data-sort]')) {
			th.setAttribute('aria-sort', th.dataset.sort === sortKey ? (sortDesc ? 'descending' : 'ascending') : 'none')
		}
	}

	// Only the apps are built and measured, so only their tab has the checks.
	const showTab = (next) => {
		if (next === tab) {
			return
		}
		ticks.set(tab, swapPicks(ticks.get(next) ?? []))
		tab = next
		table.dataset.tab = tab
		nameHead.textContent = { apps: 'App', exapps: 'ExApp', other: 'Project' }[tab]
		for (const b of tabs) {
			b.setAttribute('aria-pressed', String(b.dataset.tab === tab))
		}
		render()
	}
	for (const b of tabs) {
		b.addEventListener('click', () => showTab(b.dataset.tab))
	}

	for (const th of document.querySelectorAll('th[data-sort]')) {
		th.tabIndex = 0
		const sort = () => {
			const key = th.dataset.sort
			// Numbers start with the largest, text with A.
			sortDesc = key === sortKey ? !sortDesc : !['name', 'tag'].includes(key)
			sortKey = key
			render()
		}
		th.addEventListener('click', sort)
		th.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault()
				sort()
			}
		})
	}
	// The field and the slider set each other. Text that is neither a date nor
	// a period leaves the slider where it is; the browser may have restored the
	// field before the page was built.
	const syncRange = () => {
		const t = sinceTime(since.value)
		if (t !== null) {
			sinceRange.value = sinceStep(t)
		}
	}
	sinceRange.max = SINCE_STEPS.length
	syncRange()
	filter.addEventListener('input', render)
	since.addEventListener('input', () => {
		syncRange()
		render()
	})
	sinceRange.addEventListener('input', () => {
		since.value = SINCE_STEPS[Number(sinceRange.value)] ?? ''
		render()
	})
	sinceHelpToggle.addEventListener('click', () => {
		sinceHelp.hidden = !sinceHelp.hidden
		sinceHelpToggle.setAttribute('aria-expanded', String(!sinceHelp.hidden))
	})
	render()
	addEventListener('hashchange', route)
	route()
}

// == App page ==

// The page of an app is #app/<id>, so it opens without loading the database
// again and the browser's back button returns to the start page.
function route() {
	const m = /^#app\/(.+)$/.exec(location.hash)
	if (m) {
		let id = m[1]
		try {
			id = decodeURIComponent(id)
		} catch {
			// A malformed escape names no app; the page says so.
		}
		openApp(id)
	} else if (startTicks) {
		closeApp()
	}
}

// The charts move into the app page and chart all lines of the app's project;
// the start page gets its charts and ticks back when the page closes.
function openApp(id) {
	const charts = document.getElementById('charts')
	document.getElementById('overview').prepend(charts)
	if (!startTicks) {
		startScroll = scrollY
		startTicks = swapPicks([])
	}
	const lines = projectLines.get(appProjects.get(id))
	const body = document.getElementById('app-body')
	body.replaceChildren(...appPage(id, lines))
	if (lines) {
		document.getElementById('app-charts').append(charts)
		swapPicks(lines)
	} else {
		swapPicks([])
	}
	document.title = `${body.querySelector('h2').textContent} · gh-stats`
	document.getElementById('overview').hidden = true
	document.getElementById('app').hidden = false
	scrollTo(0, 0)
}

function closeApp() {
	document.getElementById('overview').prepend(document.getElementById('charts'))
	swapPicks(startTicks)
	startTicks = null
	document.getElementById('app').hidden = true
	document.getElementById('app-body').replaceChildren()
	document.getElementById('overview').hidden = false
	document.title = 'gh-stats'
	scrollTo(0, startScroll)
}

// The catalogue names a language in lower case with its region or script
// after a hyphen (pt-br, zh-hant). The first language of the browser the app
// has wins, else its base language, else English.
function pickLang(langs) {
	const have = new Set(langs)
	for (const l of navigator.languages ?? [navigator.language]) {
		const k = l.toLowerCase()
		if (have.has(k)) {
			return k
		}
		if (have.has(k.split('-')[0])) {
			return k.split('-')[0]
		}
	}
	return have.has('en') ? 'en' : langs[0]
}

function webLink(url, text) {
	return /^https?:\/\//i.test(url ?? '') ? el('a', { href: url }, text) : null
}

// An image stays a placeholder until the visitor loads the images of the page,
// as loading it tells its host the visitor's address. Inside a link the
// placeholder is plain text, since a link cannot hold another.
function imageHolder(src, alt, linked) {
	const attrs = { class: 'image-holder', 'data-src': src, 'data-alt': alt }
	return linked ? el('a', { ...attrs, href: src }, alt || 'image') : el('span', attrs, alt || 'image')
}

// The referrer policy is set before the source, which starts the fetch.
function loadImages(root) {
	for (const h of root.querySelectorAll('[data-src]')) {
		h.replaceChildren(el('img', { referrerpolicy: 'no-referrer', loading: 'lazy', alt: h.dataset.alt, src: h.dataset.src }))
		h.removeAttribute('data-src')
	}
}

// Descriptions are Markdown with HTML allowed. What stays of it is text,
// structure, links and images: no style, class or id that could reach into
// the page, and no element that loads anything by itself.
const DESCRIPTION = {
	ALLOWED_TAGS: ['a', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
		'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'ol', 'p', 'pre', 's', 'span',
		'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'],
	ALLOWED_ATTR: ['align', 'alt', 'colspan', 'href', 'rowspan', 'src', 'start', 'title'],
	ALLOW_DATA_ATTR: false,
}

// A document of DOMParser has no browsing context, so its images do not load
// while they are replaced.
function description(md) {
	const doc = new DOMParser().parseFromString(DOMPurify.sanitize(marked.parse(md), DESCRIPTION), 'text/html')
	for (const img of doc.querySelectorAll('img')) {
		const src = img.getAttribute('src') ?? ''
		const alt = img.getAttribute('alt') ?? ''
		img.replaceWith(/^https?:\/\//i.test(src) ? imageHolder(src, alt, !img.closest('a')) : alt)
	}
	return [...doc.body.childNodes]
}

// The catalogue rates from 0 to 1 and gives 0.5 to an app nobody rated.
function rating(value, count) {
	return count ? `${Math.round(value * 100)} % from ${count.toLocaleString('en')} rating${count === 1 ? '' : 's'}` : 'no ratings'
}

// A database or PHP extension with the versions the release requires; the
// catalogue writes * for any.
function specList(json) {
	return JSON.parse(json).map((s) => (s.spec && s.spec !== '*' ? `${s.id} ${s.spec}` : s.id)).join(', ')
}

// A version as request.yml accepts it: a stable release, numbers only.
const STABLE = /^[0-9]+(\.[0-9]+)*$/

function compareVersions(a, b) {
	const x = a.split('.').map(Number)
	const y = b.split('.').map(Number)
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0)
		if (d) {
			return d
		}
	}
	return 0
}

// The site is static, so a request is a new issue with the title request.yml
// reads; submitting it is what asks for the request.
function requestLink(text, title, help, label = 'appsdiag') {
	const body = `${help}\n\nSubmitting this issue asks for it. A request of a user without write access to this repository waits until a maintainer approves it.`
	const params = [['title', title], ['labels', label], ['body', body]]
		.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
	return el('a', { class: 'request', href: `${issues}?${params}`, target: '_blank', rel: 'noopener', title: help }, text)
}

// The newest stable version keeps its check, so it has no button to remove it.
function requestCell(id, r, runs, newest) {
	const links = []
	if (r.stable && !r.nightly && STABLE.test(r.version)) {
		links.push(requestLink(runs ? 'recheck' : 'check', `Measure ${id} ${r.version}`,
			`Measures ${id} ${r.version} ${runs ? 'again, with a new build, ' : ''}and keeps its result.`))
		if (runs && r.version !== newest) {
			links.push(' ', requestLink('remove check', `Remove the check of ${id} ${r.version}`,
				`Removes the results of ${id} ${r.version} and keeps the version from being measured again.`))
		}
	}
	return el('td', { class: 'request-col' }, ...links)
}

// The repositories of the app's project. Only an unreachable one can be removed
// from the database, together with its whole history.
function appRepos(project) {
	return query('SELECT host, owner, repo, since FROM projects WHERE project = $project ORDER BY host, owner, repo', { $project: project })
		.map((r) => el('div', {}, el('a', { href: repoUrl(r) }, slugOf(r)), ...unreachableMark(r),
			...(r.since !== null && issues
				? [requestLink('remove', `Remove ${r.host}/${r.owner}/${r.repo} from the database`,
					`Removes ${slugOf(r)} and its whole history from the database, and keeps the sampler from asking it again.`, 'sampler')]
				: [])))
}

// Requests are offered for the apps that are measured, which no ExApp is.
function appReleases(id, requests) {
	const runs = measurementsByVersion(id)
	const releases = query(`
		SELECT version, created, nightly, stable, mismatch, licenses, platform, php, databases, php_extensions
		  FROM app_releases WHERE id = $id ORDER BY created DESC`, { $id: id })
	const asks = Boolean(requests && issues)
	const newest = releases.filter((r) => r.stable && !r.nightly && STABLE.test(r.version))
		.map((r) => r.version).sort(compareVersions).at(-1)
	return el('table', {},
		el('thead', {}, el('tr', {}, ...['Version', 'Released', 'Channel', 'Nextcloud', 'PHP', 'Databases', 'PHP extensions', 'Licences']
			.map((h) => el('th', {}, h)), el('th', { title: 'warnings of the measurement of the release' }, 'Checks'),
		...(asks ? [el('th', { title: 'opens a prefilled issue that asks for the measurement' }, 'Request')] : []))),
		...releases.map((r) => {
			const [checks, checksRow] = checksCell(runs.get(r.version), asks ? 9 : 8)
			return el('tbody', {}, el('tr', {},
				el('td', {}, r.version),
				el('td', {}, (r.created ?? '').slice(0, 10)),
				el('td', {}, r.nightly ? 'nightly' : r.stable ? 'stable' : 'pre-release', ...(r.mismatch ? [mismatchMark()] : [])),
				el('td', {}, ncRange(r.platform)),
				el('td', {}, r.php ?? ''),
				el('td', { class: 'wrap' }, specList(r.databases)),
				el('td', { class: 'wrap' }, specList(r.php_extensions)),
				el('td', {}, JSON.parse(r.licenses).join(', ')),
				checks,
				...(asks ? [requestCell(id, r, runs.get(r.version), newest)] : [])), checksRow)
		}))
}

function appLines(lines) {
	return el('table', {},
		el('thead', {}, el('tr', {}, ...['Line', 'Release', 'Nextcloud', 'Published'].map((h) => el('th', {}, h)),
			...['Total', '1 day', '7 days', '30 days'].map((h) => el('th', { class: 'num' }, h)),
			el('th', { title: 'warnings of the measurement of the release shown' }, 'Checks'))),
		...lines.map((r) => {
			const [checks, checksRow] = lineChecks(r, 8)
			return el('tbody', {}, el('tr', {}, el('td', {}, lineLabel(r.line)), ...releaseCells(r), checks), checksRow)
		}))
}

// What the App Store shows of the app, in the browser's language where the
// app has it, and below it the downloads gh-stats sampled.
function appPage(id, lines) {
	const d = query('SELECT * FROM app_details WHERE id = $id', { $id: id })[0]
	if (!d) {
		return [el('h2', {}, id), el('p', {}, 'The App Store catalogue has no app of this id.')]
	}
	const texts = new Map(query('SELECT lang, name, summary, description FROM app_texts WHERE id = $id', { $id: id })
		.map((r) => [r.lang, r]))
	const lang = pickLang([...texts.keys()])
	// A text the language lacks comes in English, else in any language the app has.
	const text = (field) => {
		const t = [texts.get(lang), texts.get('en'), ...texts.values()].find((r) => r?.[field])
		return t ? { lang: t.lang, value: t[field] } : { lang: 'en', value: '' }
	}
	const name = text('name')
	const summary = text('summary')
	const desc = text('description')
	const authors = JSON.parse(d.authors).flatMap((a, i) => [i ? ', ' : '', webLink(a.homepage, a.name) ?? a.name])
	const links = [
		el('a', { href: `https://apps.nextcloud.com/apps/${encodeURIComponent(id)}` }, 'View in the App Store'),
		webLink(d.website, 'Website'),
		webLink(d.issue_tracker, 'Issue tracker'),
		webLink(d.discussion, 'Discussion'),
		webLink(d.user_docs, 'User documentation'),
		webLink(d.admin_docs, 'Admin documentation'),
		webLink(d.developer_docs, 'Developer documentation'),
	].filter(Boolean)
	const facts = [
		['App id', el('code', {}, id)],
		['Categories', JSON.parse(d.categories).join(', ')],
		['Authors', ...authors],
		['Rating', rating(d.rating_overall, d.rating_num_overall)],
		['Recent rating', rating(d.rating_recent, d.rating_num_recent)],
		['Added', (d.created ?? '').slice(0, 10)],
		['Last changed', (d.last_modified ?? '').slice(0, 10)],
		...(appProjects.has(id) ? [['Repositories', ...appRepos(appProjects.get(id))]] : []),
	]
	const shots = JSON.parse(d.screenshots)
	const page = el('div', {},
		el('h2', { lang: name.lang }, name.value || id),
		el('p', { class: 'summary', lang: summary.lang, dir: 'auto' }, summary.value),
		el('ul', { class: 'app-links' }, ...links.map((a) => el('li', {}, a))),
		el('dl', { class: 'facts' }, ...facts.flatMap(([k, ...v]) => [el('dt', {}, k), el('dd', {}, ...v)])))
	const images = el('p', { class: 'hint' }, el('button', { type: 'button', class: 'quiet' }, 'Load images'),
		' Images come from the hosts the authors name and load only on request.')
	images.firstChild.addEventListener('click', () => {
		loadImages(page)
		images.remove()
	})
	page.append(
		el('h3', {}, 'Description'),
		el('div', { class: 'description', lang: desc.lang, dir: 'auto' }, ...description(desc.value)),
		...(shots.length
			? [el('h3', {}, 'Screenshots'),
				el('ul', { class: 'shots' }, ...shots.map((u, i) => el('li', {}, imageHolder(u, `Screenshot ${i + 1}`, true))))]
			: []),
		el('h3', {}, 'Releases in the App Store'),
		el('div', { class: 'scroll' }, appReleases(id, !d.exapp)),
		el('h3', {}, 'Downloads'),
		...(lines
			? [el('div', { class: 'scroll' }, appLines(lines)), el('div', { id: 'app-charts' })]
			: [el('p', { class: 'hint' }, 'gh-stats samples no GitHub, Forgejo or Gitea repository of this app.')]))
	if (page.querySelector('[data-src]')) {
		page.querySelector('h3').before(images)
	}
	return [page]
}

load()
