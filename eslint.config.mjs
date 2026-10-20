// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT

import js from '@eslint/js'
import globals from 'globals'

// The pages load app.js and charts.js as classic scripts, so the two share one
// global scope: each file names what it takes from the other, which keeps
// no-undef catching a misspelt name, and a top-level name the other file uses
// is no unused variable.
const script = {
	sourceType: 'script',
	globals: { ...globals.browser },
}

export default [
	js.configs.recommended,
	{
		files: ['site/**/*.js'],
		rules: { 'no-unused-vars': ['error', { vars: 'local' }] },
	},
	{
		files: ['site/app.js'],
		languageOptions: {
			...script,
			globals: { ...script.globals, initSqlJs: 'readonly', initCharts: 'readonly', pickRow: 'readonly' },
		},
	},
	{
		files: ['site/charts.js'],
		languageOptions: {
			...script,
			globals: {
				...script.globals,
				uPlot: 'readonly',
				ASSETS: 'readonly',
				DAY: 'readonly',
				assetFilter: 'readonly',
				date: 'readonly',
				db: 'readonly',
				el: 'readonly',
				lineLabel: 'readonly',
				now: 'readonly',
			},
		},
	},
]
