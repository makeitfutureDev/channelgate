# ChannelGate public documentation

This Astro/Starlight project builds the static documentation for
`https://channelgate.dev/docs`. It is a standalone build that can be exported into the
**existing static website output** for deployment by the same Vercel website project. The
website home, blog, and other routes keep their own build and assets.

## Build and preview locally

Run these commands from this directory on Node.js 22.13 or newer:

```sh
npm ci
npm run build
npm test
npm run dev
```

`build` runs `sync` first and checks the generated routes, internal links, search index,
and assets. `dev` also runs `sync` before starting the Astro development server. The site is
served at `/docs`; use the URL printed by Astro and append `/docs`.

## Add docs to the current website output

Build the website through its existing pipeline first. Pass that existing static output
directory to the export command:

```sh
npm run export -- --output /absolute/path/to/current-website-output
```

The exporter requires the destination directory, verifies the docs build, copies the docs
HTML, CSS, JavaScript, and Pagefind assets into its `/docs` subtree, writes the root
`docs.html` entry point for the website's clean URL routing, and merges docs URLs into the
existing root sitemap. It does not build or replace the main website. Test the combined
output in a Vercel preview before publishing it. Every subsequent main-site deployment must
include this export step, otherwise an older website build can replace the docs entry point.
The website keeps its existing Vercel configuration, including its API rewrites.

## Source of truth

`scripts/catalog.mjs` lists the 13 canonical guides. `npm run sync` reads those Markdown
files from the ChannelGate repository and generates copies under
`src/content/docs/generated/`; edit the original files instead of the generated copies.
The overview and first-conversation walkthrough are authored here. Links between published
guides point to `/docs`; links to other repository files point to their public GitHub source
on the `beta` branch. Set `CHANNELGATE_DOCS_REF` when building another source branch.

Only the public documentation build is exported. Do not add deployment secrets, private
instructions, local runtime state, or private source files to this project or the website
output.
