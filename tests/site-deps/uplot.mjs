// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT

// uPlot: the script and the stylesheet the site ships exist, and the script
// evaluates as a classic script and exposes uPlot.

import { readFileSync } from 'node:fs'
import { fail, ok, shipped, windowWith } from './lib.mjs'

const script = shipped('uplot', 'dist/uPlot.iife.min.js')
const css = shipped('uplot', 'dist/uPlot.min.css')
if (!readFileSync(css, 'utf8').includes('.uplot')) {
	fail('uPlot.min.css has no rule for .uplot')
}
ok('uPlot.min.css styles .uplot')

// jsdom has no matchMedia, which uPlot asks for the pixel ratio.
const window = windowWith(script, (w) => {
	w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
})
if (typeof window.uPlot !== 'function') {
	fail(`uPlot.iife.min.js exposes uPlot as ${typeof window.uPlot}`)
}
ok('uPlot.iife.min.js exposes uPlot')
