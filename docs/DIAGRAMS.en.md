# README diagram maintenance

[中文](DIAGRAMS.md) · [English](DIAGRAMS.en.md)

The README architecture diagrams were redrawn with `diagram-design`. Chinese and English share nodes, connections, and colors, with separate labels and accessible descriptions. The diagram explains component relationships. See [task workflow](TASK_WORKFLOW.en.md) and [architecture](ARCHITECTURE.en.md) for task steps and permission limits.

## Files and generation

| File | Purpose |
| --- | --- |
| [`scripts/render-diagrams.js`](../scripts/render-diagrams.js) | Shared layout, bilingual labels, HTML generation, SVG export |
| [`docs/diagram-style.json`](diagram-style.json) | Project colors and font configuration |
| [中文 HTML](assets/architecture.html) / [English HTML](assets/architecture.en.html) | Complete editable figures with inline SVG |
| [中文 SVG](assets/architecture.svg) / [English SVG](assets/architecture.en.svg) | Static vector images used by the READMEs |

Run from the source root:

```sh
npm run docs:diagrams
npm run check:docs
```

The generator creates HTML containing SVG, then extracts standalone SVG from that same content. Do not edit only the exported SVG. After changing labels or layout, regenerate both languages and inspect both HTML files in a browser. The program uses only Node.js standard libraries, never connects to DSH, and adds no runtime dependencies.

## Colors and typography

The project uses blue-gray backgrounds and a dark-blue focal color instead of the skill's default orange. Project settings live in `docs/diagram-style.json` without modifying the dskills-managed skill copy.

| Setting | Value | Purpose |
| --- | --- | --- |
| `paper` | `#f3f5f8` | Diagram background |
| `paper2` | `#e7ecf2` | Input and stored-record backgrounds |
| `ink` | `#1e293b` | Primary text and borders |
| `muted` | `#475569` | Secondary text and connections |
| `rule` | `#b8c4d3` | Host boundary and legend separator |
| `accent` / `accentTint` | `#254e88` / `#e5edf9` | Focal plugin node |
| `link` | `#345f9e` | MCP and native API connections |

Font stacks prefer Geist, Instrument Serif, and Geist Mono, with Noto CJK and system fallbacks. Files load no remote fonts. Missing preferred families fall back to installed fonts, so glyphs may differ across systems. Check both languages for clipping, overlap, and readability at small sizes. SVG includes `title`, `desc`, and `aria-labelledby`; each README also supplies localized alternative text.

## Fidelity to the original

The redraw uses the Architecture type, `doc-wide` size (1280 × 720), `balanced` detail, and `mixed` audience. Primary node names use 20 px, record nodes 16 px, and supporting text 12 px for readability when scaled in a README.

The original Mermaid diagram had 11 components, 1 Host container, and 13 connections. The redraw preserves all component meanings and relationships as 9 nodes, 1 container, and 10 connections:

- MCP server and task/review manager merge into “cd-connect plugin,” removing their internal connection.
- Native adapter and native session/agent merge into “DSH native execution,” removing their internal connection.
- Log writes during execution and log reads during recovery merge into a bidirectional connection between execution and native logs.
- User authorization, native DSH human approval, local stdio, loopback HTTP, persistent task records, workspace witnesses, and the actual workspace remain. No component meaning was dropped.

## Review with the skills

The local dskills pool must contain `diagram-design` and `plain-docs`. Run this only if the project is not initialized:

```sh
dskills init --agent codex --mode copy --no-track
```

Then install or inspect the project's selected versions:

```sh
dskills plug diagram-design plain-docs
dskills status
```

These skills support local project documentation work. Keep configuration and generated skill copies local rather than committing them with public documentation. Read the skill instructions again after changing versions. Updating the global pool does not automatically advance project pins.

After generation, run the check included with diagram-design:

```sh
python3 .agents/skills/diagram-design/scripts/self_check.py docs/assets/architecture.html docs/assets/architecture.en.html
```

This checks basic accessibility and single-file output requirements. Also open both languages and inspect arrow direction, Host membership, text, crossings, and label spacing. After editing documentation and figure text, reread everything with `plain-docs` and compare both languages, preserving exact states, numbers, and permission limits.
