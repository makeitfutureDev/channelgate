import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { controlPages } from './src/data/control-reference.mjs';
import { featureGroups, configurationPages } from './src/data/handbook.mjs';

export default defineConfig({
  site: 'https://channelgate.dev',
  base: '/docs',
  trailingSlash: 'never',
  build: { format: 'directory' },
  integrations: [
    starlight({
      title: 'ChannelGate',
      description: 'Install, connect, and operate governed AI agents in your team chat.',
      logo: { src: './src/assets/mark.svg' },
      customCss: ['./src/styles/custom.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/makeitfutureDev/channelgate' }],
      components: { Header: './src/components/DocsHeader.astro' },
      sidebar: [
        { label: 'Start here', items: [
          { label: 'Welcome', slug: '' },
          { label: 'Your first conversation', slug: 'getting-started' },
          { label: 'Installation', slug: 'installation' },
          { label: 'All features', slug: 'features' },
          { label: 'Functionality map', slug: 'functionality' },
          { label: 'Control reference', slug: 'controls' },
          { label: 'Configuration overview', slug: 'configuration' },
        ] },
        ...featureGroups.map((group) => ({
          label: group.label, collapsed: true,
          items: group.items.map((page) => ({ label: page.label, slug: `features/${page.slug}` })),
        })),
        { label: 'Configuration guides', collapsed: true, items: configurationPages.map((page) => ({ label: page.label, slug: `configuration/${page.slug}` })) },
        { label: 'Gateway controls', collapsed: true, items: controlPages.map((page) => ({ label: page.label, slug: `controls/${page.slug}` })) },
        { label: 'Technical reference', collapsed: true, items: [
          { label: 'Chat platform setup', slug: 'platforms' },
          { label: 'Engine capabilities', slug: 'engines' },
          { label: 'Skills reference', slug: 'skills' },
          { label: 'SSH reference', slug: 'ssh-access' },
          { label: 'Operations runbook', slug: 'operations' },
          { label: 'Privacy and data flow', slug: 'privacy' },
          { label: 'Compatibility', slug: 'compatibility' },
          { label: 'License keys and limits', slug: 'licensing' },
          { label: 'Licensing FAQ', slug: 'licensing/faq' },
          { label: 'Licensing summary', slug: 'licensing/summary' },
        ] },
        { label: 'Resources', collapsed: true, items: [
          { label: 'Changelog', slug: 'changelog' },
          { label: 'Support', slug: 'support' },
          { label: 'Website', link: 'https://channelgate.dev/' },
          { label: 'Blog', link: 'https://channelgate.dev/blog' },
        ] },
      ],
    }),
  ],
});
