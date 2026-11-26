import globals from 'globals';

export default [
	{
		files: ['build/**/*.mjs', 'projects/**/*.mjs', '*.mjs'],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: {
				...globals.node,
				Bun: 'readonly',
			},
		},
		rules: {
			'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'no-undef': 'error',
			'no-console': 'off',
		},
	},
	{
		files: ['public/**/*.mjs', 'samples/**/*.mjs', 'projects/**/public/*.mjs'],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
		rules: {
			'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'no-undef': 'error',
			'no-console': 'off',
			'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: 'Browser modules under public/ must not import Node built-ins.' }] }],
		},
	},
	{
		files: ['test/**/*.mjs'],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
		rules: {
			'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'no-undef': 'error',
			'no-console': 'off',
		},
	},
	{
		ignores: ['node_modules/**', 'coverage/**', 'public/workbench-client-vendor-*.mjs'],
	},
];
