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
	now = query('SELECT max(ts) AS t FROM runs')[0].t
	document.getElementById('asof').textContent = `Data as of ${date(now, true)} UTC`
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

// The apps.owner and apps.repo columns compare without case, as GitHub does;
// they stand on the left so their collation applies.
function overviewRows() {
	return query(`
		SELECT s.owner, s.repo, s.tag, s.published, s.total, s.d1, s.d7, s.d30,
		       (SELECT group_concat(name, ', ') FROM (
		          SELECT DISTINCT a.name FROM apps a
		           WHERE a.owner = s.owner AND a.repo = s.repo ORDER BY a.name)) AS name
		  FROM summary s`)
}

function otherReleases(owner, repo, tag) {
	return query(`
		SELECT tag, published, (prerelease OR pre_tag) AS pre FROM releases
		 WHERE owner = $owner AND repo = $repo AND tag <> $tag
		 ORDER BY vkey DESC, published DESC`, { $owner: owner, $repo: repo, $tag: tag })
}

// The same figures gh-stats-site-db writes to the summary, for any release: the
// value of an asset at a time is its last sample at or before it, an asset
// without one did not exist yet, and a period is left out when the release or
// the sampling of its repository is younger than it.
function releaseFigures(owner, repo, tag) {
	const p = { $owner: owner, $repo: repo, $tag: tag }
	const at = {}
	for (const r of query(`
		WITH assets AS (
		  SELECT DISTINCT asset FROM samples
		   WHERE owner = $owner AND repo = $repo AND tag = $tag AND (${assetFilter})
		), k(d) AS (VALUES (0), (1), (7), (30))
		SELECT k.d, sum(coalesce((
		         SELECT s.downloads FROM samples s
		          WHERE s.owner = $owner AND s.repo = $repo AND s.tag = $tag AND s.asset = a.asset
		            AND s.ts <= $now - k.d * ${DAY}
		          ORDER BY s.ts DESC LIMIT 1), 0)) AS v
		  FROM assets a, k GROUP BY k.d`, { ...p, $now: now })) {
		at[r.d] = r.v
	}
	const { published, first } = query(`
		SELECT (SELECT published FROM releases WHERE owner = $owner AND repo = $repo AND tag = $tag) AS published,
		       (SELECT min(ts) FROM samples WHERE owner = $owner AND repo = $repo) AS first`, p)[0]
	const total = at[0] ?? 0
	const fig = { tag, published, total }
	for (const d of PERIODS) {
		fig['d' + d] = Math.max(published, first) <= now - d * DAY ? total - (at[d] ?? 0) : null
	}
	return fig
}

// == Overview ==

function date(ts, withTime = false) {
	const iso = new Date(ts * 1000).toISOString()
	return withTime ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10)
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

function figureCells(fig) {
	return ['total', ...PERIODS.map((d) => 'd' + d)].map((k) => fig[k] === null
		? el('td', { class: 'num na', title: 'the release or its sampling is younger than this period' })
		: el('td', { class: 'num' }, fig[k].toLocaleString('en')))
}

// The compare drop-down is filled on first use: all releases of every
// repository at once would be tens of thousands of options.
function compareSelect(row) {
	const select = el('select', { 'aria-label': `Compare ${row.owner}/${row.repo} ${row.tag} with` },
		el('option', { value: '' }, 'none'))
	let filled = false
	const fill = () => {
		if (filled) {
			return
		}
		filled = true
		for (const r of otherReleases(row.owner, row.repo, row.tag)) {
			select.append(el('option', { value: r.tag },
				`${r.tag} (${date(r.published)}${r.pre ? ', pre-release' : ''})`))
		}
	}
	select.addEventListener('focus', fill)
	select.addEventListener('pointerdown', fill)
	select.addEventListener('change', () => {
		row.compare.replaceChildren()
		row.compare.hidden = !select.value
		if (select.value) {
			const fig = releaseFigures(row.owner, row.repo, select.value)
			row.compare.append(el('td', { class: 'compare-label' }, 'compared with'),
				el('td', {}, releaseLink(row.owner, row.repo, fig.tag)),
				el('td', {}, date(fig.published)), ...figureCells(fig), el('td'))
		}
	})
	return select
}

function initOverview() {
	const rows = overviewRows().map((r) => {
		r.name = r.name ?? r.repo
		r.search = `${r.name} ${r.owner}/${r.repo}`.toLowerCase()
		r.tr = el('tr', {},
			el('td', {}, el('span', { class: 'name' }, r.name),
				el('a', { class: 'slug', href: `https://github.com/${r.owner}/${r.repo}` }, `${r.owner}/${r.repo}`)),
			el('td', {}, releaseLink(r.owner, r.repo, r.tag)),
			el('td', {}, date(r.published)),
			...figureCells(r),
			el('td'))
		r.compare = el('tr', { class: 'compare', hidden: '' })
		r.tr.lastChild.append(compareSelect(r))
		return r
	})

	const tbody = document.getElementById('rows')
	const filter = document.getElementById('filter')
	let sortKey = 'total'
	let sortDesc = true

	const render = () => {
		const f = filter.value.trim().toLowerCase()
		// Empty periods sort last in either direction.
		rows.sort((a, b) => {
			const x = a[sortKey]
			const y = b[sortKey]
			if (x === null || y === null) {
				return (x === null) - (y === null)
			}
			const c = typeof x === 'string' ? x.localeCompare(y) : x - y
			return sortDesc ? -c : c
		})
		const frag = document.createDocumentFragment()
		for (const r of rows) {
			if (!f || r.search.includes(f)) {
				frag.append(r.tr, r.compare)
			}
		}
		tbody.replaceChildren(frag)
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
	filter.addEventListener('input', render)
	render()
}

load()
