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
output in a Vercel preview before publishing it. The existing Vercel project now runs the automatic documentation build described below
on website deployments. Other pipelines must also include this export step.
The website keeps its existing Vercel configuration, including its API rewrites.

## Source of truth

The handbook groups practical guides by chat work, files/reports, engines, memory, skills,
connections, security, developer tools, platforms, automation, administration, and operations.
The expanded catalog is **151 pages**: **106 feature guides**, **13 configuration guides**,
**13 control references**, four directories/maps, and 15 retained overview, walkthrough,
technical-reference and resource pages. `src/data/handbook.mjs` supplies feature/configuration
navigation; `control-reference.mjs` supplies control navigation. `functionality-coverage.mjs`
maps 45 product areas to their detailed articles.

Feature articles live under `src/content/docs/features/`; configuration articles live under
`src/content/docs/configuration/`. Author practical guides with a YAML title/description,
an explanation of the feature or setting, verified configuration locations, examples,
permissions/defaults/limits, and related `/docs` links. Add a new topic to the registry and
verify its route in the final build. Search includes authored handbook articles, the control reference, and retained technical references.

`npm run build` also verifies all 106 gateway and 10 external skills-library tools against
their source registrations. Every tool must have exactly one heading in the control reference;
unknown or duplicate headings fail the build. New tools therefore require documentation in
the same change. CI runs this gate on tool-source, feature-catalog and documentation changes.

`scripts/catalog.mjs` lists the 13 canonical guides. `npm run sync` reads those Markdown
files from the ChannelGate repository and generates copies under
`src/content/docs/generated/`; edit the original files instead of the generated copies.
The overview, first-conversation walkthrough and handbook are authored here. Links between published
guides point to `/docs`; links to other repository files point to their public GitHub source
on the `beta` branch. Set `CHANNELGATE_DOCS_REF` when building another source branch.

## Review and publication

Cross-review feature coverage against `FEATURES.md` and verify user-facing claims against
the canonical guides and current implementation. Keep Beta status, optional operator setup,
admin-only capabilities and engine differences visible; explanatory UI text can lag behind
the implementation. Preserve existing technical-reference URLs when adding shorter guides.

The acceptance results for the complete-functionality expansion are tracked in its section
of `TEST-PLAN.md`. Earlier 15- and 75-page publication records are historical evidence.
Build, peer review, browser and export checks pass. Preview and production results and
the exact published deployment are recorded in that acceptance section.

Only the public documentation build is exported. Do not add deployment secrets, private
instructions, local runtime state, or private source files to this project or the website
output.

## Automatic Vercel documentation build

`scripts/vercel-build.sh` builds the public documentation in a temporary checkout, exports
it into Vercel's current website output, and removes that checkout. The existing static
website project can use this build command:

```sh
curl -fsSL https://raw.githubusercontent.com/makeitfutureDev/channelgate/beta/documentation/scripts/vercel-build.sh -o /tmp/channelgate-docs-build.sh && bash /tmp/channelgate-docs-build.sh
```

The default source is `beta`; set `CHANNELGATE_DOCS_REF` in the build environment to select
a different public branch. This command assumes the main website's static files are already
present, as they are in the existing project. If the website later gains its own build step,
run that step first and export documentation into its final output directory. A `buildCommand`
in `vercel.json` overrides the project setting, so it must also include the documentation step.
The preview and production checks in `TEST-PLAN.md` record deployment acceptance.
