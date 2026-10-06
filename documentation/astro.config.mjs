import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://channelgate.dev',
  base: '/docs',
  trailingSlash: 'never',
  build: { format: 'directory' },
  integrations: [
    starlight({
      title: 'ChannelGate Docs',
      description: 'Install, connect, and operate governed AI agents in your team chat.',
      logo: { src: './src/assets/mark.svg' },
      customCss: ['./src/styles/custom.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/makeitfutureDev/channelgate' }],
      sidebar: [
        { label: 'Start here', items: [
          { label: 'Overview', slug: '' },
          { label: 'Your first conversation', slug: 'getting-started' },
          { label: 'Installation', slug: 'installation' },
          { label: 'Chat platforms', slug: 'platforms' },
        ] },
        { label: 'Using ChannelGate', items: [
          { label: 'Engines and permissions', slug: 'engines' },
          { label: 'Skills and plugins', slug: 'skills' },
          { label: 'SSH access', slug: 'ssh-access' },
        ] },
        { label: 'Operating a deployment', items: [
          { label: 'Operations', slug: 'operations' },
          { label: 'Privacy and data flow', slug: 'privacy' },
          { label: 'Compatibility', slug: 'compatibility' },
          { label: 'License keys and limits', slug: 'licensing' },
          { label: 'Licensing FAQ', slug: 'licensing/faq' },
          { label: 'Licensing summary', slug: 'licensing/summary' },
        ] },
        { label: 'Resources', items: [
          { label: 'Changelog', slug: 'changelog' },
          { label: 'Support', slug: 'support' },
          { label: 'Website', link: 'https://channelgate.dev/' },
          { label: 'Blog', link: 'https://channelgate.dev/blog' },
        ] },
      ],
    }),
  ],
});
