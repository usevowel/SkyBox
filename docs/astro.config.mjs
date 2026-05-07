// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	site: 'https://skybox.matchbox.ortus.com',
	integrations: [
		starlight({
			title: 'SkyBox — MatchBox CF Worker',
			description: 'BoxLang WebSockets on Cloudflare Workers + Durable Objects',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/ortus-solutions/matchbox' },
			],
			sidebar: [
				{
					label: 'Overview',
					slug: 'overview',
				},
				{
					label: 'Getting Started',
					items: [
						{ label: 'Quick Start', slug: 'getting-started/quickstart' },
						{ label: 'Prerequisites', slug: 'getting-started/prerequisites' },
						{ label: 'Creating a Project', slug: 'getting-started/new-project' },
					],
				},
				{
					label: 'Architecture',
					autogenerate: { directory: 'architecture' },
				},
				{
					label: 'Build Pipeline',
					autogenerate: { directory: 'build' },
				},
				{
					label: 'WASM Guide',
					autogenerate: { directory: 'wasm' },
				},
				{
					label: 'Demos',
					autogenerate: { directory: 'demos' },
				},
				{
					label: 'Testing',
					autogenerate: { directory: 'testing' },
				},
				{
					label: 'Reference',
					autogenerate: { directory: 'reference' },
				},
			],
			head: [
				{
					tag: 'link',
					attrs: { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
				},
			],
		}),
	],
});
