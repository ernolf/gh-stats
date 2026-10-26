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
let measuredShipped
let shipped
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
		SELECT DISTINCT j.project, a.id, a.name, d.exapp, d.categories FROM apps a
		  JOIN projects j ON a.host = j.host AND a.owner = j.owner AND a.repo = j.repo
		  JOIN app_details d ON d.id = a.id
		 ORDER BY j.project, a.name`)
}

// Every catalogue app with its newest release, the newest stable one where it
// has one; an app without a release, as the App Store lists an integration,
// comes without.
function catalogueApps() {
	return query(`
		SELECT d.id, d.exapp, d.categories, coalesce((SELECT t.name FROM app_texts t WHERE t.id = d.id AND t.lang = 'en'), d.id) AS name,
		       r.version, CAST(strftime('%s', r.created) AS INTEGER) AS published, r.platform
		  FROM app_details d LEFT JOIN app_releases r ON r.id = d.id AND r.version = (
		       SELECT x.version FROM app_releases x WHERE x.id = d.id ORDER BY x.stable DESC, x.created DESC LIMIT 1)
		 ORDER BY d.id`)
}

// The ranges of every catalogue release, which name every Nextcloud major an
// app has required so far.
function catalogueSpecs() {
	return query('SELECT DISTINCT platform FROM app_releases').map((r) => r.platform)
}

// The apps the server ships, by the server release whose archive ships them,
// the newest major first and in it master, then the newest release; with an id
// only those of that app.
function shippedApps(id = null) {
	return query(`
		SELECT s.id, s.name, s.server, s.major, s.ref, s.latest, s.version, s.repo, s.path, s.app_ref, s.enabled, s.restrictable,
		       CAST(strftime('%s', s.published) AS INTEGER) AS published, d.categories
		  FROM shipped s LEFT JOIN app_details d ON d.id = s.id
		 WHERE $id IS NULL OR s.id = $id`, { $id: id })
		.sort((a, b) => b.major - a.major || (b.ref === 'master') - (a.ref === 'master')
			|| compareVersions(b.ref.slice(1), a.ref.slice(1)))
}

// The Nextcloud major each shipped app is shipped since.
function shippedSince() {
	return new Map(query('SELECT id, major FROM shipped_since').map((r) => [r.id, r.major]))
}

// The App Store categories by name, as its sidebar lists them.
function categories() {
	return new Map(query('SELECT id, name FROM categories ORDER BY name COLLATE NOCASE').map((r) => [r.id, r.name]))
}

const MEASUREMENT = `m.dir, m.app_id, m.version, m.restrictable, m.server, m.tag, m.tarball, m.signed, m.diff,
	(SELECT count(*) FROM findings f WHERE f.dir = m.dir AND f.level = 'warn') AS warn`

// The measurements of each release, keyed by project and tag; a repository that
// holds several apps has one per app. A measurement belongs to the project of
// the repository it measured and to those of the repositories the catalogue
// links for its app, which may be others. The measurements and apps owner and
// repo columns compare without case and stand on the left. Each carries the
// version key and pre-release flag of its release in the project. The run of a
// server release measures the app as that release ships it, not a release of
// the project, even where it names the tag of one.
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
		 WHERE m.tag IS NOT NULL AND m.server IS NULL ORDER BY m.subdir, m.app_id`)
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

// The measurements of one app, keyed by the version of the release they
// measured, as the App Store ships it.
function measurementsByVersion(id) {
	return Map.groupBy(query(`SELECT ${MEASUREMENT} FROM measurements m WHERE m.app_id = $id AND m.server IS NULL`, { $id: id }),
		(r) => r.version)
}

// The measurements of the shipped apps, keyed by app id and the tag of the
// server release, or master, as the shipped table names it.
function measurementsByServer() {
	return Map.groupBy(query(`SELECT ${MEASUREMENT} FROM measurements m WHERE m.server IS NOT NULL`),
		(r) => `${r.app_id}\n${r.server}`)
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
const NC_SPEC = /^>=\s*([\d.]+)(?:\s+<=\s*([\d.]+))?$/

function ncRange(spec) {
	if (!spec) {
		return ''
	}
	const m = NC_SPEC.exec(spec.trim())
	if (!m) {
		return spec
	}
	if (m[2] === undefined) {
		return `${m[1]}+`
	}
	return m[1] === m[2] ? m[1] : `${m[1]}–${m[2]}`
}

// The first and last major of a range, compared by major as the App Store
// does: <=33 covers every 33.x, a range without an upper bound every later major.
function ncMajors(spec) {
	const m = spec ? NC_SPEC.exec(spec.trim()) : null
	return m && [parseInt(m[1]), m[2] === undefined ? Infinity : parseInt(m[2])]
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

const SERVER_REPO = 'nextcloud/server'
const SHIPPED_TEXT = 'the first Nextcloud major whose core/shipped.json lists the app; the file exists since Nextcloud 9'

function shippedMark(id) {
	return shipped.has(id) ? [el('span', { class: 'shipped', title: SHIPPED_TEXT }, `shipped since Nextcloud ${shipped.get(id)}`)] : []
}

// What the core/shipped.json of a server release says of an app: always
// enabled, part of the server, or one that can be disabled, which a new
// installation enables or not.
const ENABLED = {
	always: ['always enabled', 'the server release enables the app always; it cannot be disabled'],
	default: ['enabled by default', 'a new installation of the server release enables the app; it can be disabled'],
	optional: ['disabled by default', 'a new installation of the server release leaves the app disabled; it can be enabled'],
}
// The choices of the filter that are not a single value.
const ENABLED_FILTER = { switchable: ['default', 'optional'] }
// The column Enabled of the tab Shipped Apps is narrow, so it gives a letter,
// explained once above the table.
const ENABLED_CODE = { always: 'A', default: 'E', optional: 'D' }

function enabledMark(s) {
	return s.enabled ? [el('span', { class: 'enabled', title: ENABLED[s.enabled][1] }, ENABLED[s.enabled][0])] : []
}

const RESTRICTION_TEXT = 'the server cannot restrict the app to groups: the <types> in its appinfo/info.xml hold filesystem, '
	+ 'prelogin, authentication, logging or prevent_group_restriction'

// Only an app that cannot be restricted to groups is marked; the info.xml of a
// release is read when the release is measured or the server ships it. Of a
// repository with several apps, the title names those it applies to.
function restrictionMark(apps) {
	const ids = apps.filter((a) => a.restrictable === 0).map((a) => a.app_id ?? a.id)
	if (!ids.length) {
		return []
	}
	const title = apps.length > 1 ? `${ids.join(', ')}: ${RESTRICTION_TEXT}` : RESTRICTION_TEXT
	return [el('span', { class: 'restriction', title }, 'cannot be restricted to groups')]
}

// An app of the server tree has its directory there, any other its own
// repository, each at the tag or branch of the server release.
function shippedSource(s) {
	return `https://github.com/${s.repo}/tree/${encodeURIComponent(s.app_ref)}${s.path ? `/${s.path}` : ''}`
}

// version.php of master names a release not yet out, such as 36.0.0 dev, and
// the branch name tells it from the release of that version.
function serverLink(s) {
	return el('a', { href: `https://github.com/${SERVER_REPO}/tree/${encodeURIComponent(s.ref)}` },
		s.ref === 'master' ? `master ${s.server}` : s.server)
}

function releaseLink(fig) {
	return el('a', { href: `${repoUrl(fig)}/releases/tag/${encodeURIComponent(fig.tag)}` }, fig.tag)
}

function mismatchMark() {
	return el('span', { class: 'mismatch', role: 'img', 'aria-label': MISMATCH_TEXT, title: MISMATCH_TEXT }, '⚠')
}

function releaseCells(fig, runs = []) {
	return [
		el('td', { class: 'tag' }, releaseLink(fig), ...(fig.mismatch ? [mismatchMark()] : []), ...restrictionMark(runs)),
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
	const select = el('select', { class: 'compare-select', 'aria-label': `Compare ${row.tag} with` },
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
				...releaseCells(releaseFigures(row.project, select.value), measured.get(`${row.project}\n${select.value}`)), checks, el('td'))
		}
	})
	return select
}

// == Checks ==

function finding(f) {
	return el('div', { class: `finding ${f.level ?? ''}` },
		el('span', { class: 'level' }, f.level ?? ''), ' ', el('code', {}, f.id ?? ''), el('pre', {}, f.text))
}

// The release diff compares the tarball the App Store ships, or the directory
// of the app in the server archive, with the tree the build stages, by kind of
// difference and class of file.
function diffText(m) {
	const archive = m.server ? `apps/${m.app_id}/ of the server archive ${m.tarball}` : `Release tarball ${m.tarball}`
	if (m.diff === null) {
		return m.tarball ? `${archive} not compared.` : m.server ? 'No server archive.' : 'No release tarball.'
	}
	const kinds = Object.entries(JSON.parse(m.diff)).map(([kind, classes]) => {
		const n = Object.values(classes).reduce((a, b) => a + b, 0)
		return `${kind} ${n} (${Object.entries(classes).map(([c, k]) => `${c} ${k}`).join(', ')})`
	})
	return `${archive}${m.signed ? ', signed' : ''}: ${kinds.join(', ') || 'no entries'}.`
}

// Warnings in full, grouped by the tool that found them, the tools with
// warnings first; ok and info only as counts that open on demand.
function checksBlock(m) {
	const hasWarn = (fs) => fs.some((f) => f.level === 'warn')
	const tools = [...Map.groupBy(findingsOf(m.dir), (f) => f.tool)].sort(([, a], [, b]) => hasWarn(b) - hasWarn(a))
	return el('section', { class: 'run' },
		el('h4', {}, `${m.app_id ?? m.dir} ${m.version ?? ''} `, el('a', { href: `${results}/${m.dir}` }, 'run directory')),
		el('p', {}, diffText(m)),
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
		title: `${warn} warning${warn === 1 ? '' : 's'} in ${runs.length} measurement${runs.length === 1 ? '' : 's'}${version ? ` of ${version}` : ''}`,
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
	row.tr = el('tr', {}, el('td', { class: 'pick' }, row.pick), first, ...releaseCells(row, measured.get(`${row.project}\n${row.tag}`)), checks, el('td'))
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
		name: a.name, tag: a.version, published: a.published, nc: a.platform,
		total: null, d1: null, d7: null, d30: null, lines: [],
		search: `${a.name} ${a.id}`.toLowerCase(), categories: new Set(JSON.parse(a.categories)),
	}
	const runs = p.tab === 'apps' ? measurementsByVersion(a.id).get(a.version) : undefined
	p.warn = warnings(runs)
	const [checks, checksRow] = checksCell(runs, 10)
	const empty = released ? { class: 'num na', title: 'gh-stats samples no GitHub, Forgejo or Gitea release of this app' } : { class: 'num' }
	p.main = el('tbody', {}, el('tr', {},
		el('td', { class: 'pick' }),
		el('td', {}, el('span', { class: 'name' }, el('a', { href: `#app/${encodeURIComponent(a.id)}` }, a.name)), ...shippedMark(a.id)),
		el('td', { class: 'tag' }, a.version ?? '', ...restrictionMark(runs ?? [])),
		el('td', {}, ncRange(a.platform)),
		el('td', {}, a.published === null ? '' : date(a.published)),
		...['total', ...PERIODS].map(() => el('td', empty)),
		checks, el('td')), checksRow)
	p.older = el('tbody', { class: 'older', hidden: '' })
	p.toggle = el('button', { type: 'button', class: 'toggle', hidden: '' })
	return p
}

// The button opens and closes the lines below the row of a project.
function olderToggle(p) {
	const toggle = el('button', { type: 'button', class: 'toggle', 'aria-expanded': 'false' })
	toggle.addEventListener('click', () => {
		p.older.hidden = !p.older.hidden
		toggle.setAttribute('aria-expanded', String(!p.older.hidden))
	})
	return toggle
}

// A shipped app has a line for the newest release of each server major whose
// archive ships it and for master, master on its row and the stable majors
// below, each with the checks of the app as that release ships it. An app
// master no longer ships has its newest stable major on the row.
// Nobody downloads the archives from a host gh-stats samples, so the tab has no
// download columns and nothing to chart or compare. In their place each line
// says how its server release ships the app, and the row since which major.
function shippedRow(releases) {
	const main = releases.find((s) => s.ref === 'master') ?? releases[0]
	const line = (s, first, since = null) => {
		const runs = measuredShipped.get(`${s.id}\n${s.ref}`)
		const [checks, checksRow] = checksCell(runs, 9)
		const r = {
			published: s.published, nc: `>=${s.major} <=${s.major}`, warn: warnings(runs), checks: checksRow,
			compare: el('tr', { class: 'compare', hidden: '' }), compareChecks: el('tr', { class: 'checks', hidden: '' }),
		}
		r.tr = el('tr', {}, el('td', { class: 'pick' }), first,
			el('td', { class: 'tag' }, el('a', { href: shippedSource(s) }, s.version)),
			el('td', {}, serverLink(s)),
			el('td', {}, s.published === null ? '' : date(s.published)),
			el('td', { class: 'num' }, since ?? ''),
			s.enabled ? el('td', { class: 'mark', title: ENABLED[s.enabled][0] }, ENABLED_CODE[s.enabled]) : el('td'),
			el('td', { class: 'mark' }, s.restrictable === 0 ? 'X' : ''),
			el('td', { class: 'mark' }, s.repo === SERVER_REPO ? 'X' : ''),
			checks)
		return r
	}
	const head = el('td', {}, el('span', { class: 'name' }, el('a', { href: `#app/${encodeURIComponent(main.id)}` }, main.name)),
		el('a', { class: 'slug', href: `https://github.com/${main.repo}` }, main.repo))
	const since = shipped.get(main.id) ?? null
	const row = line(main, head, since)
	const p = {
		tab: 'shipped', name: main.name, tag: main.version, published: main.published, nc: row.nc, enabled: main.enabled, tree: main.repo === SERVER_REPO,
		total: null, d1: null, d7: null, d30: null, since, warn: row.warn,
		lines: releases.filter((s) => s !== main)
			.map((s) => line(s, el('td', { class: 'line-label' }, `Nextcloud ${s.major}`))),
		search: `${main.name} ${main.id} ${main.repo}`.toLowerCase(), categories: new Set(JSON.parse(main.categories ?? '[]')),
	}
	p.main = el('tbody', {}, row.tr, row.checks)
	p.older = el('tbody', { class: 'older', hidden: '' })
	p.toggle = olderToggle(p)
	head.append(p.toggle)
	return p
}

function initOverview() {
	initCharts()
	measured = measurementsByRelease()
	measuredLines = measurementsByLine(measured)
	measuredShipped = measurementsByServer()
	shipped = shippedSince()
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
		p.categories = new Set(own.flatMap((a) => JSON.parse(a.categories)))

		// Each app links its page; a project that is no App Store app has none.
		const links = own.flatMap((a, i) => [i ? ', ' : '', el('a', { href: `#app/${encodeURIComponent(a.id)}` }, a.name)])
		const head = el('td', {}, el('span', { class: 'name' }, ...(links.length ? links : [p.name])),
			...members.flatMap((r) => [el('a', { class: 'slug', href: repoUrl(r) }, slugOf(r)), ...unreachableMark(r)]),
			...own.flatMap((a) => shippedMark(a.id)))
		p.main = el('tbody', {}, ...lineRows(main, head))
		p.warn = main.warn
		p.older = el('tbody', { class: 'older', hidden: '' },
			...older.flatMap((r) => lineRows(r, el('td', { class: 'line-label' }, `line ${lineLabel(r.line)}`))))
		p.toggle = olderToggle(p)
		head.append(p.toggle)
		return p
	})
	const shown = new Set(projects.flatMap((p) => (apps.get(p.project) ?? []).map((a) => a.id)))
	projects.push(...catalogueApps().filter((a) => !shown.has(a.id)).map(catalogueRow))
	projects.push(...[...Map.groupBy(shippedApps().filter((s) => s.latest), (s) => s.id).values()].map(shippedRow))

	const table = document.querySelector('#overview table')
	const tabs = document.querySelectorAll('#tabs button')
	const nameHead = document.querySelector('th[data-sort="name"]')
	let tab = 'apps'
	// Each tab keeps its own ticks, so the charts show the rows of the tab shown.
	const ticks = new Map()
	const filter = document.getElementById('filter')
	const invert = document.getElementById('invert')
	const since = document.getElementById('since')
	const sinceDate = document.getElementById('since-date')
	const sinceRange = document.getElementById('since-range')
	const sinceHelp = document.getElementById('since-help')
	const sinceHelpToggle = document.getElementById('since-help-toggle')
	const appFilters = document.getElementById('app-filters')
	const nc = document.getElementById('nc')
	const category = document.getElementById('category')
	const enabled = document.getElementById('enabled')
	const source = document.getElementById('source')
	const enabledCodes = document.getElementById('enabled-codes')
	enabledCodes.append(el('span', {}, 'Enabled: ', ...Object.entries(ENABLED_CODE).flatMap(([k, code], i) =>
		[i ? ', ' : '', el('b', {}, code), ` ${ENABLED[k][0]}`])))
	const reset = document.getElementById('reset')
	let sortKey = 'total'
	let sortDesc = true

	// The tab and the order are kept with the controls, each only while it
	// differs from the start.
	const save = () => {
		const s = controlSettings()
		if (tab !== 'apps') {
			s.tab = tab
		}
		if (sortKey !== 'total' || !sortDesc) {
			s.sort = { key: sortKey, desc: sortDesc }
		}
		writeSettings(s)
	}

	const render = () => {
		const f = filter.value.trim().toLowerCase()
		const t = sinceTime(since.value)
		since.setAttribute('aria-invalid', String(t === null))
		sinceDate.value = t ? `from ${date(t)}` : ''
		sinceRange.setAttribute('aria-valuetext', SINCE_STEPS[Number(sinceRange.value)] ?? 'no limit')
		// A line counts by the release it shows; a project stays while any of
		// its lines does, with the row of its newest line.
		const from = t ?? 0
		// The Other tab has no Nextcloud versions to compare.
		const major = Number(nc.value)
		const counts = (r) => {
			if (r.published < from) {
				return false
			}
			if (!major || tab === 'other') {
				return true
			}
			const m = ncMajors(r.nc)
			return m !== null && m[0] <= major && m[1] >= major
		}
		// Empty periods sort last in either direction, as do the rows of the
		// other tabs, which lack the columns of the tab Shipped Apps.
		projects.sort((a, b) => {
			const x = a[sortKey] ?? null
			const y = b[sortKey] ?? null
			if (x === null || y === null) {
				return (x === null) - (y === null)
			}
			const c = typeof x === 'string' ? x.localeCompare(y) : x - y
			return sortDesc ? -c : c
		})
		for (const tbody of table.querySelectorAll('tbody')) {
			tbody.remove()
		}
		// The projects of the Other tab carry no category.
		const c = tab === 'other' ? '' : category.value
		// Only a shipped app is enabled or not by the server.
		const e = tab === 'shipped' && enabled.value ? ENABLED_FILTER[enabled.value] ?? [enabled.value] : null
		const tree = tab === 'shipped' && source.value ? source.value === 'tree' : null
		const frag = document.createDocumentFragment()
		for (const p of projects) {
			const older = p.lines.filter(counts)
			if (p.tab !== tab || (f && p.search.includes(f) === invert.checked) || (c && !p.categories.has(c)) || (e && !e.includes(p.enabled)) || (tree !== null && p.tree !== tree) || (!counts(p) && !older.length)) {
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
		save()
	}

	// Only the apps and the shipped apps are built and measured, so only their
	// tabs have the checks.
	const showTab = (next) => {
		if (next === tab) {
			return
		}
		ticks.set(tab, swapPicks(ticks.get(next) ?? []))
		tab = next
		table.dataset.tab = tab
		nameHead.textContent = { apps: 'App', exapps: 'ExApp', shipped: 'App', other: 'Project' }[tab]
		appFilters.hidden = tab === 'other'
		enabled.hidden = tab !== 'shipped'
		source.hidden = tab !== 'shipped'
		enabledCodes.hidden = tab !== 'shipped'
		for (const b of tabs) {
			b.setAttribute('aria-pressed', String(b.dataset.tab === tab))
		}
		render()
	}
	for (const b of tabs) {
		b.addEventListener('click', () => showTab(b.dataset.tab))
	}

	// A catalogue built without the names of the categories has no choice of them.
	const names = categories()
	category.append(...[...names].map(([id, name]) => el('option', { value: id }, name)))
	category.hidden = !names.size
	category.addEventListener('change', render)
	enabled.addEventListener('change', render)
	source.addEventListener('change', render)

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
	// a period leaves the slider where it is.
	const syncRange = () => {
		const t = sinceTime(since.value)
		if (t !== null) {
			sinceRange.value = sinceStep(t)
		}
	}
	sinceRange.max = SINCE_STEPS.length
	filter.addEventListener('input', render)
	invert.addEventListener('change', render)
	since.addEventListener('input', () => {
		syncRange()
		render()
	})
	sinceRange.addEventListener('input', () => {
		since.value = SINCE_STEPS[Number(sinceRange.value)] ?? ''
		render()
	})
	// The select offers the majors from the lowest to the highest min-version:
	// an upper bound may name a major far beyond any release, such as <=99.
	const firsts = catalogueSpecs().map(ncMajors).filter(Boolean).map((m) => m[0])
	for (let v = Math.min(...firsts); v <= Math.max(...firsts); v++) {
		nc.append(el('option', { value: v }, String(v)))
	}
	nc.addEventListener('change', render)
	sinceHelpToggle.addEventListener('click', () => {
		sinceHelp.hidden = !sinceHelp.hidden
		sinceHelpToggle.setAttribute('aria-expanded', String(!sinceHelp.hidden))
	})

	// Restored after the selects have their options, so a stored choice can be
	// checked against them. A stored tab or order the page no longer has
	// leaves the start.
	const restore = (s) => {
		restoreControls(s)
		syncRange()
		const keys = [...document.querySelectorAll('th[data-sort]')].map((th) => th.dataset.sort)
		const sorted = keys.includes(s.sort?.key) && typeof s.sort.desc === 'boolean'
		sortKey = sorted ? s.sort.key : 'total'
		sortDesc = sorted ? s.sort.desc : true
		showTab([...tabs].some((b) => b.dataset.tab === s.tab) ? s.tab : 'apps')
		drawCharts()
	}
	for (const id of CHART_SETTINGS) {
		document.getElementById(id).addEventListener('change', save)
	}
	// The defaults keep nothing, so the render after a reset removes the key.
	reset.addEventListener('click', () => {
		restore({})
		render()
	})
	restore(readSettings())
	render()
	addEventListener('hashchange', route)
	route()
}

// == Scrolling ==

// The column headings stick below the bar, so they follow its height, which
// changes when the filters wrap or the help of Released since opens. Back to
// top shows once the page header is out of view.
function initScrolling() {
	const overview = document.getElementById('overview')
	const bar = document.getElementById('listing-bar')
	new ResizeObserver(() => {
		overview.style.setProperty('--bar-height', `${bar.offsetHeight}px`)
	}).observe(bar)
	const toTop = document.getElementById('to-top')
	new IntersectionObserver(([entry]) => {
		toTop.hidden = entry.isIntersecting
	}).observe(document.querySelector('header'))
	toTop.addEventListener('click', () => scrollTo(0, 0))
}

// == Settings ==

// The controls of the start page outlast a reload: the browser keeps what
// differs from the defaults under one key. Without storage, in a private
// window or with the site data blocked, the page starts from the defaults.
const SETTINGS_KEY = 'gh-stats.settings'
const OVERVIEW_SETTINGS = ['filter', 'invert', 'since', 'category', 'nc', 'enabled', 'source']
const CHART_SETTINGS = ['scope', 'split', 'share-figure', 'measure', 'bucket', 'range', 'style', 'log']

// The defaults are those the page is written with.
function controlDefault(c) {
	if (c.type === 'checkbox') {
		return c.defaultChecked
	}
	if (c.tagName === 'SELECT') {
		return ([...c.options].find((o) => o.defaultSelected) ?? c.options[0]).value
	}
	return c.defaultValue
}

function controlSettings() {
	const s = {}
	for (const id of [...OVERVIEW_SETTINGS, ...CHART_SETTINGS]) {
		const c = document.getElementById(id)
		const v = c.type === 'checkbox' ? c.checked : c.value
		if (v !== controlDefault(c)) {
			s[id] = v
		}
	}
	return s
}

// A value the page no longer offers, such as a category the catalogue has
// dropped, leaves the default.
function restoreControls(s) {
	for (const id of [...OVERVIEW_SETTINGS, ...CHART_SETTINGS]) {
		const c = document.getElementById(id)
		const v = s[id]
		if (c.type === 'checkbox') {
			c.checked = typeof v === 'boolean' ? v : c.defaultChecked
		} else if (c.tagName === 'SELECT') {
			c.value = [...c.options].some((o) => o.value === v) ? v : controlDefault(c)
		} else {
			c.value = typeof v === 'string' ? v : c.defaultValue
		}
	}
}

function readSettings() {
	try {
		const s = JSON.parse(localStorage.getItem(SETTINGS_KEY))
		if (!s || typeof s !== 'object') {
			return {}
		}
		// One Nextcloud major replaced the pair from and to, of which it takes
		// the lower side, or the upper one alone.
		if (!('nc' in s) && (s['nc-min'] || s['nc-max'])) {
			s.nc = s['nc-min'] || s['nc-max']
		}
		return s
	} catch {
		return {}
	}
}

function writeSettings(s) {
	try {
		if (Object.keys(s).length) {
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
		} else {
			localStorage.removeItem(SETTINGS_KEY)
		}
	} catch {
		// Without storage the settings last as long as the page.
	}
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

// A version as gh-stats-request.yml accepts it: a stable release, numbers only.
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

// The site is static, so a request is a new issue with the title gh-stats-request.yml
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
				el('td', {}, r.version, ...restrictionMark(runs.get(r.version) ?? [])),
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

// The newest release of each major and master keep their check unless they
// enable the app always, so they have no button to remove it.
function shippedRequestCell(s, runs) {
	const links = []
	const as = `${s.id} as Nextcloud ${s.ref === 'master' ? 'master' : s.server} ships it`
	links.push(requestLink(runs ? 'recheck' : 'check', `Measure ${as}`,
		`Measures ${as} ${runs ? 'again, with a new build, ' : ''}and keeps its result.`))
	if (runs && !(s.latest && s.enabled !== 'always')) {
		links.push(' ', requestLink('remove check', `Remove the check of ${as}`,
			`Removes the results of ${as} and keeps it from being measured again.`))
	}
	return el('td', { class: 'request-col' }, ...links)
}

function appShipped(releases) {
	const asks = Boolean(issues)
	return el('table', {},
		el('thead', {}, el('tr', {}, ...['Nextcloud', 'Published', 'App version', 'Enabled', 'Source'].map((h) => el('th', {}, h)),
			el('th', { title: 'warnings of the measurement of the app as the server release ships it' }, 'Checks'),
			...(asks ? [el('th', { title: 'opens a prefilled issue that asks for the measurement' }, 'Request')] : []))),
		...releases.map((s) => {
			const runs = measuredShipped.get(`${s.id}\n${s.ref}`)
			const [checks, checksRow] = checksCell(runs, asks ? 6 : 5)
			return el('tbody', {}, el('tr', {},
				el('td', {}, serverLink(s)),
				el('td', {}, s.published === null ? '' : date(s.published)),
				el('td', {}, s.version, ...restrictionMark([s])),
				el('td', {}, ...enabledMark(s)),
				el('td', {}, el('a', { href: shippedSource(s) }, s.path ? `${s.repo}/${s.path}` : s.repo)),
				checks,
				...(asks ? [shippedRequestCell(s, runs)] : [])), checksRow)
		}))
}

function factList(facts) {
	return el('dl', { class: 'facts' }, ...facts.flatMap(([k, ...v]) => [el('dt', {}, k), el('dd', {}, ...v)]))
}

function appLines(lines) {
	return el('table', {},
		el('thead', {}, el('tr', {}, ...['Line', 'Release', 'Nextcloud', 'Published'].map((h) => el('th', {}, h)),
			...['Total', '1 day', '7 days', '30 days'].map((h) => el('th', { class: 'num' }, h)),
			el('th', { title: 'warnings of the measurement of the release shown' }, 'Checks'))),
		...lines.map((r) => {
			const [checks, checksRow] = lineChecks(r, 8)
			return el('tbody', {}, el('tr', {}, el('td', {}, lineLabel(r.line)), ...releaseCells(r, measured.get(`${r.project}\n${r.tag}`)), checks), checksRow)
		}))
}

// What the App Store shows of the app, in the browser's language where the
// app has it, the server releases that ship it, and below it the downloads
// gh-stats sampled. A shipped app the App Store does not list has the page of
// its server releases alone.
function appPage(id, lines) {
	const d = query('SELECT * FROM app_details WHERE id = $id', { $id: id })[0]
	const ships = shippedApps(id)
	const shippedFact = shipped.has(id) ? [['Shipped', el('span', { title: SHIPPED_TEXT }, `since Nextcloud ${shipped.get(id)}`)]] : []
	const shippedPart = ships.length ? [el('h3', {}, 'Shipped with Nextcloud'), el('div', { class: 'scroll' }, appShipped(ships))] : []
	if (!d) {
		return ships.length
			? [el('div', {}, el('h2', {}, ships[0].name), factList([['App id', el('code', {}, id)], ...shippedFact]),
				el('p', { class: 'hint' }, 'The App Store catalogue has no app of this id.'), ...shippedPart)]
			: [el('h2', {}, id), el('p', {}, 'The App Store catalogue has no app of this id.')]
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
	const names = categories()
	const facts = [
		['App id', el('code', {}, id)],
		['Categories', JSON.parse(d.categories).map((c) => names.get(c) ?? c).join(', ')],
		['Authors', ...authors],
		['Rating', rating(d.rating_overall, d.rating_num_overall)],
		['Recent rating', rating(d.rating_recent, d.rating_num_recent)],
		['Added', (d.created ?? '').slice(0, 10)],
		['Last changed', (d.last_modified ?? '').slice(0, 10)],
		...shippedFact,
		...(appProjects.has(id) ? [['Repositories', ...appRepos(appProjects.get(id))]] : []),
	]
	const shots = JSON.parse(d.screenshots)
	const page = el('div', {},
		el('h2', { lang: name.lang }, name.value || id),
		el('p', { class: 'summary', lang: summary.lang, dir: 'auto' }, summary.value),
		el('ul', { class: 'app-links' }, ...links.map((a) => el('li', {}, a))),
		factList(facts))
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
		...shippedPart,
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

initScrolling()
load()
