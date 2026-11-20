// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT

// DOMPurify: the build the site ships, with the configuration the site gives
// it for the app descriptions, leaves no script, no event handler and no
// javascript: URL of a set of known XSS probes, and keeps a plain link.

import { fail, ok, shipped, siteFile, windowWith } from './lib.mjs'

// The configuration is read from app.js, so the test follows what the site
// runs. It is an object literal of strings, arrays and booleans.
const literal = siteFile('app.js').match(/^const DESCRIPTION = (\{[\s\S]*?^\})$/m)?.[1]
if (!literal) {
	fail('app.js has no const DESCRIPTION')
}
const config = Function(`"use strict"; return (${literal})`)()

const window = windowWith(shipped('dompurify', 'dist/purify.min.js'))
const DOMPurify = window.DOMPurify
if (typeof DOMPurify?.sanitize !== 'function' || !DOMPurify.isSupported) {
	fail('purify.min.js exposes no working DOMPurify')
}
ok(`purify.min.js exposes DOMPurify ${DOMPurify.version}`)

const probes = [
	'<script>alert(1)</script>',
	'<img src=x onerror=alert(1)>',
	'<a href="javascript:alert(1)">x</a>',
	'<a href="  JaVaScRiPt:alert(1)">x</a>',
	'<a href="jav&#x09;ascript:alert(1)">x</a>',
	'<a href="&#106;avascript:alert(1)">x</a>',
	'<svg><script>alert(1)</script></svg>',
	'<svg onload=alert(1)>',
	'<iframe src="javascript:alert(1)"></iframe>',
	'<details open ontoggle=alert(1)>x</details>',
	'<div style="background:url(javascript:alert(1))">x</div>',
	'<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
	'<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
	'<form><button formaction="javascript:alert(1)">x</button></form>',
	'<object data="javascript:alert(1)"></object>',
	'<p data-x="1" onclick="alert(1)">x</p>',
]

// The output is parsed again, as the site does with DOMParser, and every
// element and attribute of it is checked.
function unsafe(html) {
	const doc = new window.DOMParser().parseFromString(html, 'text/html')
	const found = []
	for (const el of doc.body.querySelectorAll('*')) {
		const tag = el.localName
		if (['script', 'iframe', 'object', 'embed', 'style', 'form', 'svg', 'math', 'noscript'].includes(tag)) {
			found.push(`<${tag}>`)
		}
		for (const { name, value } of el.attributes) {
			// eslint-disable-next-line no-control-regex
			const url = value.replace(/[\u0000- ]/g, '').toLowerCase()
			if (name.startsWith('on') || name === 'style' || name.startsWith('data-')) {
				found.push(`${tag}[${name}]`)
			} else if (url.startsWith('javascript:')) {
				found.push(`${tag}[${name}=${value}]`)
			}
		}
	}
	return found
}

let bad = 0
for (const probe of probes) {
	const out = DOMPurify.sanitize(probe, config)
	const found = unsafe(out)
	if (found.length) {
		console.error(`FAIL: ${probe}\n  gives ${out}\n  with ${found.join(', ')}`)
		bad++
	}
}
if (bad) {
	fail(`${bad} of ${probes.length} probes keep something unsafe`)
}
ok(`${probes.length} XSS probes come back clean`)

const link = DOMPurify.sanitize('<a href="https://example.org" title="t">l</a> <img src="https://example.org/i.png" alt="i">', config)
if (link !== '<a href="https://example.org" title="t">l</a> <img src="https://example.org/i.png" alt="i">') {
	fail(`a plain link and image come back as ${link}`)
}
ok('a plain link and image are kept')
