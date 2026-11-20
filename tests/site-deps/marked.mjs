// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT

// marked: the UMD build the site ships loads as a classic script, and a fixed
// piece of Markdown renders to the HTML it always rendered to.

import { fail, ok, shipped, windowWith } from './lib.mjs'

const window = windowWith(shipped('marked', 'lib/marked.umd.js'))
if (typeof window.marked?.parse !== 'function') {
	fail('marked.umd.js exposes no marked.parse')
}
ok('marked.umd.js exposes marked.parse')

const md = [
	'# Title',
	'',
	'Some *emphasis*, **strong**, `code` and a [link](https://example.org).',
	'',
	'- one',
	'- two',
	'',
	'| a | b |',
	'| - | - |',
	'| 1 | 2 |',
	'',
].join('\n')
const expected = [
	'<h1>Title</h1>',
	'<p>Some <em>emphasis</em>, <strong>strong</strong>, <code>code</code> and a <a href="https://example.org">link</a>.</p>',
	'<ul>',
	'<li>one</li>',
	'<li>two</li>',
	'</ul>',
	'<table>',
	'<thead>',
	'<tr>',
	'<th>a</th>',
	'<th>b</th>',
	'</tr>',
	'</thead>',
	'<tbody><tr>',
	'<td>1</td>',
	'<td>2</td>',
	'</tr>',
	'</tbody></table>',
	'',
].join('\n')
const html = window.marked.parse(md)
if (html !== expected) {
	fail(`the Markdown renders to:\n${html}`)
}
ok('the Markdown renders as expected')
