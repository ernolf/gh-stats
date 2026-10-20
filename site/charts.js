// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT

'use strict'

// == Charts ==

// More series than colours would repeat a colour; the pie folds the rest into
// one slice and the chart over time leaves them out.
const MAX_SERIES = 10
// uPlot stays fluid up to a few thousand points per series.
const MAX_POINTS = 2500
const PLOT_HEIGHT = 320
const SVG = 'http://www.w3.org/2000/svg'

// The rows ticked in the table, in the order they were ticked.
const picked = new Map()

let ui
let plot
let pending = false

function pickRow(row, on) {
	const key = `${row.project}\n${row.line}`
	if (on) {
		picked.set(key, row)
	} else {
		picked.delete(key)
	}
	drawCharts()
}

// Ticks the rows given instead of those ticked, and returns those: an app page
// charts the lines of its app and gives the start page its ticks back when it
// closes.
function swapPicks(next) {
	const before = [...picked.values()]
	for (const row of before) {
		row.pick.checked = false
	}
	picked.clear()
	for (const row of next) {
		row.pick.checked = true
		picked.set(`${row.project}\n${row.line}`, row)
	}
	drawCharts()
	return before
}

function rows(sql, params = {}) {
	const stmt = db.prepare(sql)
	const out = []
	try {
		stmt.bind(params)
		while (stmt.step()) {
			out.push(stmt.get())
		}
	} finally {
		stmt.free()
	}
	return out
}

// What a ticked row stands for in the charts: its release, all releases of its
// line, or all releases of its project. Rows that stand for the same item count
// once.
function chartItems() {
	const items = new Map()
	for (const row of picked.values()) {
		const item = ui.scope.value === 'project'
			? { key: row.project, label: row.name, project: row.project }
			: ui.scope.value === 'line'
				? { key: `${row.project}\n${row.line}`, label: `${row.name} line ${lineLabel(row.line)}`, project: row.project, line: row.line }
				: { key: `${row.project}\n\n${row.tag}`, label: `${row.name} ${row.tag}`, project: row.project, tag: row.tag }
		items.set(item.key, item)
	}
	return [...items.values()]
}

// The counted assets of an item, each with the group it is split into and when
// the sampling of its repository began.
function assetsOf(item, split) {
	const where = ['j.project = $project']
	const params = { $project: item.project }
	if (item.tag !== undefined) {
		where.push('s.tag = $tag')
		params.$tag = item.tag
	}
	if (item.line !== undefined) {
		where.push(`s.tag IN (
			SELECT r.tag FROM releases r JOIN projects k ON r.owner = k.owner AND r.repo = k.repo
			 WHERE k.project = $project AND substr(r.vkey, 1, 12) = $line)`)
		params.$line = item.line
	}
	const group = split === 'release'
		? 's.tag'
		: split === 'asset'
			? `CASE ${ASSETS.map((e) => `WHEN s.asset GLOB '*.${e}' THEN '${e}'`).join(' ')} END`
			: "''"
	return {
		cte: `assets AS (
			SELECT DISTINCT s.owner, s.repo, s.tag, s.asset, ${group} AS g, j.first
			  FROM samples s JOIN projects j ON s.owner = j.owner AND s.repo = j.repo
			 WHERE ${where.join(' AND ')} AND (${assetFilter}))`,
		params,
	}
}

function lastSample(at) {
	return `(SELECT x.downloads FROM samples x
		WHERE x.owner = a.owner AND x.repo = a.repo AND x.tag = a.tag AND x.asset = a.asset AND x.ts <= ${at}
		ORDER BY x.ts DESC LIMIT 1)`
}

// A single item is named in its chip, so its series need only their group.
function seriesOf(item, g, alone = false) {
	return { key: `${item.key}\n${g}`, label: g ? (alone ? g : `${item.label} · ${g}`) : item.label }
}

// Downloads in total and in the last `days` days per series. A repository that
// was not sampled yet when the period began adds nothing to it, instead of its
// whole total.
function shares(items, split, days) {
	const then = now - days * DAY
	const out = []
	for (const item of items) {
		const { cte, params } = assetsOf(item, split)
		const sums = new Map()
		for (const [g, first, v, w] of rows(`WITH ${cte}
			SELECT a.g, a.first, ${lastSample('$now')}, ${lastSample('$then')} FROM assets a`,
		{ ...params, $now: now, $then: then })) {
			const s = sums.get(g) ?? { total: 0, value: 0 }
			s.total += v
			s.value += days ? v - (w ?? (first > then ? v : 0)) : v
			sums.set(g, s)
		}
		for (const [g, s] of sums) {
			out.push({ ...seriesOf(item, g, items.length === 1), ...s })
		}
	}
	return out.sort((a, b) => b.total - a.total)
}

// Weeks start on Monday; the epoch began on a Thursday.
function alignDown(t, step) {
	const offset = step === 7 * DAY ? 4 * DAY : 0
	return Math.floor((t - offset) / step) * step + offset
}

function chartStart(items, split) {
	if (ui.range.value) {
		return now - Number(ui.range.value) * DAY
	}
	let start = now
	for (const item of items) {
		const { cte, params } = assetsOf(item, split)
		const [[first]] = rows(`WITH ${cte} SELECT min(a.first) FROM assets a`, params)
		if (first !== null) {
			start = Math.min(start, first)
		}
	}
	return start
}

// A bucket too fine for the range is disabled, and a disabled choice moves to
// the finest one left.
function chartStep(start) {
	let fallback = null
	for (const o of ui.bucket.options) {
		o.disabled = (now - start) / Number(o.value) > MAX_POINTS
		fallback ??= o.disabled ? null : o
	}
	if (ui.bucket.selectedOptions[0].disabled) {
		fallback.selected = true
	}
	return Number(ui.bucket.value)
}

// The downloads of every series at each bucket edge, and those within each
// bucket. The sampler writes a row only on change, so the value of an asset
// at a time is its last sample at or before it. The first sample of a
// repository is where its counting begins, not downloads within the bucket.
function seriesHistory(items, split, start, step, keys) {
	const end = alignDown(now, step)
	const edges = []
	for (let t = alignDown(start, step); t <= end; t += step) {
		edges.push(t)
	}
	const out = new Map()
	for (const item of items) {
		const { cte, params } = assetsOf(item, split)
		const p = { ...params, $start: edges[0], $end: end }
		const current = new Map()
		const sums = new Map()
		const grown = new Map()
		for (const [id, g, v] of rows(`WITH ${cte}
			SELECT a.owner || '/' || a.repo || '/' || a.tag || '/' || a.asset, a.g, ${lastSample('$start')}
			  FROM assets a`, p)) {
			if (v !== null) {
				current.set(id, v)
				sums.set(g, (sums.get(g) ?? 0) + v)
			}
		}
		const changes = rows(`WITH ${cte}
			SELECT a.owner || '/' || a.repo || '/' || a.tag || '/' || a.asset, a.g, a.first, s.ts, s.downloads
			  FROM assets a JOIN samples s
			    ON s.owner = a.owner AND s.repo = a.repo AND s.tag = a.tag AND s.asset = a.asset
			 WHERE s.ts > $start AND s.ts <= $end ORDER BY s.ts`, p)
		const series = new Map()
		let i = 0
		edges.forEach((edge, e) => {
			for (; i < changes.length && changes[i][3] <= edge; i++) {
				const [id, g, first, ts, d] = changes[i]
				const before = current.get(id)
				sums.set(g, (sums.get(g) ?? 0) + d - (before ?? 0))
				if (before !== undefined || ts > first) {
					grown.set(g, (grown.get(g) ?? 0) + d - (before ?? 0))
				}
				current.set(id, d)
			}
			for (const [g, sum] of sums) {
				const { key } = seriesOf(item, g)
				if (!keys.has(key)) {
					continue
				}
				if (!series.has(key)) {
					series.set(key, { total: new Array(edges.length).fill(0), rate: new Array(edges.length - 1).fill(0) })
				}
				const s = series.get(key)
				s.total[e] = sum
				if (e > 0) {
					s.rate[e - 1] = grown.get(g) ?? 0
				}
			}
			grown.clear()
		})
		for (const [key, s] of series) {
			out.set(key, s)
		}
	}
	return { edges, series: out }
}

// == Drawing ==

function cssVar(name) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function palette() {
	return Array.from({ length: MAX_SERIES }, (_, i) => cssVar(`--series-${i + 1}`))
}

function alpha(hex, a) {
	const n = parseInt(hex.slice(1), 16)
	return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

function svg(tag, attrs = {}, ...children) {
	const e = document.createElementNS(SVG, tag)
	for (const [k, v] of Object.entries(attrs)) {
		e.setAttribute(k, v)
	}
	e.append(...children)
	return e
}

// A ring segment between the angles a0 and a1, clockwise from 12 o'clock. A
// full ring stops just short of closing, as an arc cannot end where it starts.
function ringPath(a0, a1, inner, outer) {
	const span = Math.min(a1 - a0, 2 * Math.PI - 1e-4)
	const large = span > Math.PI ? 1 : 0
	const at = (r, a) => `${(r * Math.sin(a)).toFixed(3)} ${(-r * Math.cos(a)).toFixed(3)}`
	return `M ${at(outer, a0)} A ${outer} ${outer} 0 ${large} 1 ${at(outer, a0 + span)}`
		+ ` L ${at(inner, a0 + span)} A ${inner} ${inner} 0 ${large} 0 ${at(inner, a0)} Z`
}

function percent(v, total) {
	const p = (100 * v) / total
	return p >= 10 ? `${p.toFixed(0)}%` : `${p.toFixed(1)}%`
}

function drawShares(series, colors, period) {
	const slices = series.slice(0, MAX_SERIES).filter((s) => s.value > 0)
		.sort((a, b) => b.value - a.value)
		.map((s) => ({ ...s, color: colors.get(s.key) }))
	// The folded series close the ring, whatever their sum.
	const rest = series.slice(MAX_SERIES)
	const restValue = rest.reduce((n, s) => n + s.value, 0)
	if (restValue > 0) {
		slices.push({ key: '', label: `${rest.length} more`, color: cssVar('--muted'), value: restValue })
	}
	const total = slices.reduce((n, s) => n + s.value, 0)
	if (!total) {
		ui.shares.replaceChildren(el('p', { class: 'hint' }, `No downloads ${period}.`))
		return
	}

	const value = svg('text', { class: 'ring-value', y: '4' })
	const label = svg('text', { class: 'ring-label', y: '22' })
	const ring = svg('svg', { class: 'ring', viewBox: '-110 -110 220 220', role: 'img', 'aria-label': `Shares of the downloads ${period}` })
	const legend = el('ul', { class: 'ring-legend' })
	const focus = (s) => {
		ring.classList.toggle('focus', s !== null)
		for (const t of slices) {
			t.path.classList.toggle('active', t === s)
			t.item.classList.toggle('active', t === s)
		}
		value.textContent = (s?.value ?? total).toLocaleString('en')
		label.textContent = s ? percent(s.value, total) : period
	}

	let a = 0
	for (const s of slices) {
		const b = a + (2 * Math.PI * s.value) / total
		s.path = svg('path', { d: ringPath(a, b, 62, 100), fill: s.color },
			svg('title', {}, `${s.label}: ${s.value.toLocaleString('en')} (${percent(s.value, total)})`))
		s.item = el('li', {},
			el('span', { class: 'swatch', style: `background: ${s.color}` }),
			el('span', { class: 'ring-name', title: s.label }, s.label),
			el('span', { class: 'num' }, s.value.toLocaleString('en')),
			el('span', { class: 'num pct' }, percent(s.value, total)))
		for (const e of [s.path, s.item]) {
			e.addEventListener('pointerenter', () => focus(s))
			e.addEventListener('pointerleave', () => focus(null))
		}
		ring.append(s.path)
		legend.append(s.item)
		a = b
	}
	ring.append(value, label)
	focus(null)
	ui.shares.replaceChildren(ring, legend)
}

function drawHistory(edges, series, step) {
	plot?.destroy()
	plot = null
	const perBucket = ui.measure.value === 'rate'
	const bars = ui.style.value === 'bars'
	const log = ui.log.checked
	const x = perBucket ? edges.slice(0, -1) : edges
	if (!series.length || x.length < (bars ? 1 : 2)) {
		ui.history.replaceChildren(el('p', { class: 'hint' }, 'Too few points in this range; pick a longer one or a finer bucket.'))
		return
	}

	const n = series.length
	// Bars of one bucket stand side by side, together 80 % of its width.
	const barPaths = (k) => uPlot.paths.bars({
		radius: 0.15,
		disp: {
			x0: { unit: 1, values: (u) => u.data[0].map((t) => t + step * (0.1 + (0.8 * k) / n)) },
			size: { unit: 1, values: (u) => u.data[0].map(() => (0.8 * step) / n) },
		},
	})
	const line = uPlot.paths.linear()
	const fill = (color) => (u) => {
		const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height)
		g.addColorStop(0, alpha(color, n > 1 ? 0.12 : 0.3))
		g.addColorStop(1, alpha(color, 0))
		return g
	}
	const axis = {
		stroke: cssVar('--muted'),
		font: '12px system-ui, sans-serif',
		grid: { stroke: cssVar('--line'), width: 1 },
		ticks: { stroke: cssVar('--line'), width: 1, size: 4 },
	}
	const compact = new Intl.NumberFormat('en', { notation: 'compact' })
	const values = series.map((s) => (perBucket ? s.rate : s.total))
	// A logarithmic scale has no place for 0.
	const data = [x, ...values.map((ys) => (log ? ys.map((v) => (v > 0 ? v : null)) : ys))]
	// Without the cursor in the chart, the legend shows the last bucket.
	const at = (idx) => idx ?? x.length - 1

	ui.history.replaceChildren()
	plot = new uPlot({
		width: ui.history.clientWidth,
		height: PLOT_HEIGHT,
		tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC'),
		scales: {
			x: bars ? { time: true, range: () => [x[0], x[x.length - 1] + step] } : { time: true },
			y: log ? { distr: 3 } : { range: (u, min, max) => [0, max > 0 ? max * 1.08 : 1] },
		},
		axes: [axis, { ...axis, size: 56, values: (u, vals) => vals.map((v) => compact.format(v)) }],
		series: [
			{ label: perBucket ? 'Bucket from' : 'At', value: (u, t, si, idx) => date(x[at(idx)], step < DAY) },
			...series.map((s, k) => ({
				label: s.label,
				value: (u, v, si, idx) => values[k][at(idx)].toLocaleString('en'),
				stroke: s.color,
				fill: bars ? alpha(s.color, 0.85) : fill(s.color),
				width: bars ? 0 : 2,
				paths: bars ? barPaths(k) : line,
				points: { show: false },
			})),
		],
		cursor: { points: { size: 8 }, focus: { prox: 24 } },
		focus: { alpha: 0.3 },
		// The legend paints its markers with the series fill, before the plot has
		// a size to place a gradient in.
		legend: { markers: { fill: (u, i) => alpha(series[i - 1].color, bars ? 0.85 : 0.3) } },
	}, data, ui.history)
}

function unpickAll() {
	for (const row of picked.values()) {
		row.pick.checked = false
	}
	picked.clear()
	drawCharts()
}

function drawChips() {
	ui.all.indeterminate = picked.size > 0
	ui.all.checked = false
	ui.all.disabled = !picked.size
	ui.chips.replaceChildren(...[...picked.values()].map((row) => {
		const remove = el('button', { type: 'button', 'aria-label': `Remove ${row.name} line ${lineLabel(row.line)}` }, '×')
		remove.addEventListener('click', () => {
			row.pick.checked = false
			pickRow(row, false)
		})
		return el('span', { class: 'chip' }, `${row.name} ${lineLabel(row.line)}`, remove)
	}))
}

// Several controls can change in one task, as when the selection is cleared;
// the charts are drawn once for all of them.
function drawCharts() {
	if (pending) {
		return
	}
	pending = true
	requestAnimationFrame(() => {
		pending = false
		draw()
	})
}

function draw() {
	drawChips()
	const items = chartItems()
	ui.hint.hidden = items.length > 0
	ui.body.hidden = !items.length
	if (!items.length) {
		plot?.destroy()
		plot = null
		return
	}
	const split = ui.split.value
	const days = Number(ui.figure.value)
	const all = shares(items, split, days)
	const pal = palette()
	const colors = new Map(all.slice(0, MAX_SERIES).map((s, i) => [s.key, pal[i]]))
	drawShares(all, colors, ui.figure.selectedOptions[0].textContent)

	const start = chartStart(items, split)
	const step = chartStep(start)
	const { edges, series } = seriesHistory(items, split, start, step, new Set(colors.keys()))
	drawHistory(edges, all.filter((s) => series.has(s.key))
		.map((s) => ({ label: s.label, color: colors.get(s.key), ...series.get(s.key) })), step)
	ui.note.textContent = all.length > MAX_SERIES
		? `The ${MAX_SERIES} series with the most downloads of ${all.length}.`
		: ''
}

function initCharts() {
	const id = (name) => document.getElementById(name)
	ui = {
		hint: id('charts-hint'), body: id('charts-body'), chips: id('picked'), note: id('history-note'),
		scope: id('scope'), split: id('split'), figure: id('share-figure'), shares: id('shares'),
		measure: id('measure'), bucket: id('bucket'), range: id('range'), style: id('style'), log: id('log'),
		history: id('history'), all: id('pick-all'),
	}
	for (const c of [ui.scope, ui.split, ui.figure, ui.measure, ui.bucket, ui.range, ui.style, ui.log]) {
		c.addEventListener('change', drawCharts)
	}
	id('unpick').addEventListener('click', unpickAll)
	ui.all.addEventListener('change', unpickAll)
	new ResizeObserver(() => plot?.setSize({ width: ui.history.clientWidth, height: PLOT_HEIGHT })).observe(ui.history)
	// The colours of a chart are read from the page when it is drawn.
	matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawCharts)
	draw()
}
