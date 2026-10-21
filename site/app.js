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
let measured
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

// One row per project and release line, the newest line of a project first.
function summaryRows() {
	return query(`
		SELECT project, line, owner, repo, tag, published, nc, total, d1, d7, d30
		  FROM summary ORDER BY project, line DESC`)
}

function projectRepos() {
	return query('SELECT project, owner, repo FROM projects ORDER BY project, owner, repo')
}

// The apps.owner and apps.repo columns compare without case, as GitHub does;
// they stand on the left so their collation applies.
function projectApps() {
	return query(`
		SELECT DISTINCT j.project, a.id, a.name FROM apps a
		  JOIN projects j ON a.owner = j.owner AND a.repo = j.repo
		 ORDER BY j.project, a.name`)
}

const MEASUREMENT = `m.dir, m.app_id, m.version, m.tag, m.tarball, m.signed, m.diff,
	(SELECT count(*) FROM findings f WHERE f.dir = m.dir AND f.level = 'warn') AS warn`

// The measurements of each release, keyed by project and tag; a repository that
// holds several apps has one per app. A measurement belongs to the project of
// the repository it measured and to those of the repositories the catalogue
// links for its app, which may be others. The measurements and apps owner and
// repo columns compare without case and stand on the left.
function measurementsByRelease() {
	const rows = query(`
		SELECT p.project, ${MEASUREMENT}
		  FROM measurements m JOIN (
		       SELECT m.dir, j.project FROM measurements m
		         JOIN projects j ON m.owner = j.owner AND m.repo = j.repo
		       UNION
		       SELECT m.dir, j.project FROM measurements m JOIN apps a ON a.id = m.app_id
		         JOIN projects j ON a.owner = j.owner AND a.repo = j.repo) p ON p.dir = m.dir
		 WHERE m.tag IS NOT NULL ORDER BY m.subdir, m.app_id`)
	return Map.groupBy(rows, (r) => `${r.project}\n${r.tag}`)
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
		       max(r.prerelease OR r.pre_tag) AS pre,
		       (SELECT f.spec FROM platforms f JOIN projects k ON f.owner = k.owner AND f.repo = k.repo
		         WHERE k.project = $project AND f.tag = r.tag LIMIT 1) AS nc
		  FROM releases r JOIN projects j ON j.owner = r.owner AND j.repo = r.repo
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
		  SELECT DISTINCT s.owner, s.repo, s.asset FROM samples s
		    JOIN projects j ON s.owner = j.owner AND s.repo = j.repo
		   WHERE j.project = $project AND s.tag = $tag AND (${assetFilter})
		), k(d) AS (VALUES (0), (1), (7), (30))
		SELECT k.d, sum(coalesce((
		         SELECT s.downloads FROM samples s
		          WHERE s.owner = a.owner AND s.repo = a.repo AND s.tag = $tag AND s.asset = a.asset
		            AND s.ts <= $now - k.d * ${DAY}
		          ORDER BY s.ts DESC LIMIT 1), 0)) AS v
		  FROM assets a, k GROUP BY k.d`, { ...p, $now: now })) {
		at[r.d] = r.v
	}
	const repos = query(`
		SELECT j.owner, j.repo, j.first,
		       EXISTS (SELECT 1 FROM samples s WHERE s.owner = j.owner AND s.repo = j.repo
		                  AND s.tag = $tag AND (${assetFilter})) AS has,
		       EXISTS (SELECT 1 FROM releases r WHERE r.owner = j.owner AND r.repo = j.repo
		                  AND r.tag = $tag) AS tagged
		  FROM projects j WHERE j.project = $project ORDER BY j.owner, j.repo`, p)
	const { published, nc } = query(`
		SELECT (SELECT min(r.published) FROM releases r JOIN projects j ON j.owner = r.owner AND j.repo = r.repo
		         WHERE j.project = $project AND r.tag = $tag) AS published,
		       (SELECT f.spec FROM platforms f JOIN projects j ON f.owner = j.owner AND f.repo = j.repo
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
	const fig = { owner: home.owner, repo: home.repo, tag, published, nc, total }
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

function releaseLink(owner, repo, tag) {
	return el('a', { href: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}` }, tag)
}

function releaseCells(fig) {
	return [
		el('td', { class: 'tag' }, releaseLink(fig.owner, fig.repo, fig.tag)),
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
			const notes = [date(r.published), r.nc && `Nextcloud ${ncRange(r.nc)}`, r.pre && 'pre-release']
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
		if (select.value) {
			row.compare.append(el('td'), el('td', { class: 'compare-label' }, 'compared with'),
				...releaseCells(releaseFigures(row.project, select.value)), el('td'), el('td'))
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
// table from its second column.
function checksCell(runs, span) {
	const checks = el('tr', { class: 'checks', hidden: '' })
	if (!runs) {
		return [el('td', { title: 'not measured' }), checks]
	}
	const warn = runs.reduce((n, m) => n + m.warn, 0)
	const button = el('button', {
		type: 'button',
		class: warn ? 'check-count warn' : 'check-count',
		'aria-expanded': 'false',
		title: `${warn} warning${warn === 1 ? '' : 's'} in ${runs.length} measurement${runs.length === 1 ? '' : 's'}`,
	}, warn ? `⚠ ${warn}` : '✓')
	button.addEventListener('click', () => {
		if (!checks.hasChildNodes()) {
			checks.append(el('td'), el('td', { colspan: String(span) }, ...runs.map(checksBlock)))
		}
		checks.hidden = !checks.hidden
		button.setAttribute('aria-expanded', String(!checks.hidden))
	})
	return [el('td', {}, button), checks]
}

// The tick puts the row into the charts.
function lineRows(row, first) {
	row.pick = el('input', { type: 'checkbox', 'aria-label': `Chart ${row.name} line ${lineLabel(row.line)}` })
	row.pick.addEventListener('change', () => pickRow(row, row.pick.checked))
	const [checks, checksRow] = checksCell(measured.get(`${row.project}\n${row.tag}`), 10)
	row.checks = checksRow
	row.tr = el('tr', {}, el('td', { class: 'pick' }, row.pick), first, ...releaseCells(row), checks, el('td'))
	row.compare = el('tr', { class: 'compare', hidden: '' })
	row.tr.lastChild.append(compareSelect(row))
	return [row.tr, row.checks, row.compare]
}

function initOverview() {
	initCharts()
	measured = measurementsByRelease()
	const repos = Map.groupBy(projectRepos(), (r) => r.project)
	const apps = Map.groupBy(projectApps(), (r) => r.project)
	appProjects = new Map([...apps.values()].flat().map((a) => [a.id, a.project]))
	const projects = [...Map.groupBy(summaryRows(), (r) => r.project)].map(([project, lines]) => {
		const [main, ...older] = lines
		const slugs = repos.get(project).map((r) => `${r.owner}/${r.repo}`)
		const own = apps.get(project) ?? []
		const p = { project, name: own.map((a) => a.name).join(', ') || main.repo, ...main, lines: older }
		for (const r of lines) {
			r.name = p.name
		}
		projectLines.set(project, lines)
		p.search = `${p.name} ${slugs.join(' ')}`.toLowerCase()

		// Each app links its page; a project that is no App Store app has none.
		const links = own.flatMap((a, i) => [i ? ', ' : '', el('a', { href: `#app/${encodeURIComponent(a.id)}` }, a.name)])
		const head = el('td', {}, el('span', { class: 'name' }, ...(links.length ? links : [p.name])),
			...slugs.map((s) => el('a', { class: 'slug', href: `https://github.com/${s}` }, s)))
		p.main = el('tbody', {}, ...lineRows(main, head))
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

	const table = document.querySelector('#overview table')
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
			if ((f && !p.search.includes(f)) || (p.published < from && !older.length)) {
				continue
			}
			p.older.replaceChildren(...older.flatMap((r) => [r.tr, r.checks, r.compare]))
			p.toggle.hidden = !older.length
			p.toggle.textContent = `${older.length} older line${older.length > 1 ? 's' : ''}`
			frag.append(p.main, p.older)
		}
		table.append(frag)
		for (const th of document.querySelectorAll('th[data-sort]')) {
			th.setAttribute('aria-sort', th.dataset.sort === sortKey ? (sortDesc ? 'descending' : 'ascending') : 'none')
		}
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

function appReleases(id) {
	const runs = measurementsByVersion(id)
	const releases = query(`
		SELECT version, created, nightly, licenses, platform, php, databases, php_extensions
		  FROM app_releases WHERE id = $id ORDER BY created DESC`, { $id: id })
	return el('table', {},
		el('thead', {}, el('tr', {}, ...['Version', 'Released', 'Channel', 'Nextcloud', 'PHP', 'Databases', 'PHP extensions', 'Licences']
			.map((h) => el('th', {}, h)), el('th', { title: 'warnings of the measurement of the release' }, 'Checks'))),
		...releases.map((r) => {
			const [checks, checksRow] = checksCell(runs.get(r.version), 8)
			return el('tbody', {}, el('tr', {},
				el('td', {}, r.version),
				el('td', {}, (r.created ?? '').slice(0, 10)),
				el('td', {}, r.nightly ? 'nightly' : 'stable'),
				el('td', {}, ncRange(r.platform)),
				el('td', {}, r.php ?? ''),
				el('td', { class: 'wrap' }, specList(r.databases)),
				el('td', { class: 'wrap' }, specList(r.php_extensions)),
				el('td', {}, JSON.parse(r.licenses).join(', ')),
				checks), checksRow)
		}))
}

function appLines(lines) {
	return el('table', {},
		el('thead', {}, el('tr', {}, ...['Line', 'Release', 'Nextcloud', 'Published'].map((h) => el('th', {}, h)),
			...['Total', '1 day', '7 days', '30 days'].map((h) => el('th', { class: 'num' }, h)),
			el('th', { title: 'warnings of the measurement of the release shown' }, 'Checks'))),
		...lines.map((r) => {
			const [checks, checksRow] = checksCell(measured.get(`${r.project}\n${r.tag}`), 8)
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
		el('div', { class: 'scroll' }, appReleases(id)),
		el('h3', {}, 'Downloads'),
		...(lines
			? [el('div', { class: 'scroll' }, appLines(lines)), el('div', { id: 'app-charts' })]
			: [el('p', { class: 'hint' }, 'gh-stats samples no GitHub repository of this app.')]))
	if (page.querySelector('[data-src]')) {
		page.querySelector('h3').before(images)
	}
	return [page]
}

load()
