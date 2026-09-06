# Third-party notices

ChannelGate incorporates third-party software and assets. Those components remain licensed by
their respective owners under their original terms; the Makeitfuture Sustainable Use License does
not replace those terms.

## Poppins fonts

The files in `public/fonts/` are Poppins font binaries.

Copyright 2020 The Poppins Project Authors
(https://github.com/itfoundry/Poppins)

They are licensed under the SIL Open Font License, Version 1.1. The complete license text is in
[`public/fonts/OFL.txt`](public/fonts/OFL.txt).

## JavaScript dependencies

Package dependencies and their exact resolved versions are recorded in `package-lock.json`. Each
dependency retains the license supplied by its copyright holder. Release artifacts include the
npm lockfile inventory plus a separately generated runtime-image SBOM and signed artifact
attestations described in
`docs/RELEASE-CHECKLIST.md`.

## Runtime image

The source checkout's lockfile does not inventory the runtime image. `containers/Containerfile`
adds Debian/Node packages, Python packages, model weights and global CLIs (Claude Code, Codex,
mcp-remote, Vercel, Supabase and system tools). Those components retain their own licenses and
provider usage terms. A release build generates `runtime-image.spdx.json` from the installed image
and `runtime-models.json` with the model files' hashes. Review that candidate's inventory and
upstream notices before redistributing its image; metadata alone is not legal clearance.
Do not remove `/usr/share/doc` or package/model license notices from distributed images.

## Contributor Covenant

`CODE_OF_CONDUCT.md` adapts Contributor Covenant 2.1, copyright its contributors, under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
The project-specific contact and application wording are adaptations; the attribution and
[original text](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) remain identified.
