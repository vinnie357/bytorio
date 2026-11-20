import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Marked } from "marked";
import { repo, run } from "./toolchain.mjs";
import { games, sections, publicDocuments } from "../site/catalog.mjs";
import { escape, shell, home, showcase, gamePage } from "../site/templates.mjs";

// Sequential builds keep compiler jobs from competing with browser checks.
if (!process.argv.includes("--staged")) {
  for (const task of ["//examples/rpg:build", "//examples/racing:build"]) {
    console.log(`Preparing showcase: ${task}`);
    run(process.env.MISE_BIN || "mise", ["run", task], { timeout: 1800000 });
  }
}

const output = resolve(repo, "build/site");
await mkdir(output, { recursive: true });
// These generated trees must not retain pages removed from the public catalog.
for (const directory of ["docs", "source"]) {
  await rm(resolve(output, directory), { recursive: true, force: true });
}
async function emit(path, content) {
  const target = resolve(output, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

await cp(resolve(repo, "site/assets"), resolve(output, "assets"), { recursive: true });
for (const file of ["site.css", "site.js"]) {
  await cp(resolve(repo, "site", file), resolve(output, file));
}
for (const game of games) {
  const source = resolve(repo, game.build, "web");
  for (const language of ["luau", "odin"]) {
    if (!existsSync(resolve(source, `${game.cartridge}-${language}.png`))) {
      throw new Error(
        `Missing ${game.title} ${language} cartridge. Run mise run build:site first.`,
      );
    }
  }
  const target = resolve(output, "games", game.id);
  await cp(source, target, { recursive: true });
  // Configure the SDK player through its public configuration contract.
  const player = await readFile(resolve(repo, "runtime/odin/web/player.html"), "utf8");
  await writeFile(
    resolve(target, "player.html"),
    player
      .replace("<title>Game player</title>", `<title>${escape(game.title)} · Bytorio</title>`)
      .replace("</head>", '<link rel="stylesheet" href="./showcase-player.css"></head>'),
  );
  await writeFile(
    resolve(target, "player-config.json"),
    JSON.stringify(
      {
        title: game.title,
        instructions: game.controls,
        controls: { visibility: "always", overrides: { action: { label: game.action } } },
      },
      null,
      2,
    ),
  );
  await cp(resolve(repo, "site/player.css"), resolve(target, "showcase-player.css"));
  await emit(`showcase/${game.id}/index.html`, gamePage(game));
}
await emit("index.html", home());
await emit("showcase/index.html", showcase());

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const markdown = [...new Set(publicDocuments)];
const documents = new Map(
  markdown.map((path) => {
    const text = readFileSync(resolve(repo, path), "utf8");
    const title = text.match(/^#\s+(.+)$/m)?.[1] || path;
    return [path, { title, text, url: `docs/${path.replace(/\.md$/, ".html")}` }];
  }),
);
const sourcePages = new Map();
const copiedImages = new Set();
const slug = (value) =>
  value
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
function sidebar(root, current) {
  return `<aside class="docs-sidebar"><label class="search-label" for="docs-search">Search documentation</label><input id="docs-search" type="search" placeholder="Try ‘sprites’ or ‘audio’" autocomplete="off"><p id="search-status" class="small" role="status"></p><ul id="search-results"></ul><nav aria-label="Documentation">${sections.map(([title, links]) => `<h2>${title}</h2>${links.map(([path, label]) => `<a href="${root}${documents.get(path).url}" ${path === current ? 'aria-current="page"' : ""}>${label}</a>`).join("")}`).join("")}<h2>More to explore</h2><a href="${root}docs/index.html#all-guides">All guides & specifications</a><a href="${root}showcase/index.html">Playable demos ↗</a></nav></aside>`;
}
function docShell(title, content, url, current = "", toc = "") {
  const root = "../".repeat(url.split("/").length - 1);
  return shell({
    title,
    description: `${title} — Bytorio documentation and developer reference.`,
    active: "docs",
    root,
    body: `<main id="main" class="docs-layout">${sidebar(root, current)}<article class="doc-content">${content}</article>${toc}</main>`,
  });
}

for (const [path, doc] of documents) {
  const root = "../".repeat(doc.url.split("/").length - 1);
  const headings = [];
  const ids = new Map();
  function destination(href, image = false) {
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href) || href.startsWith("#")) {
      return href;
    }
    if (/^[a-z]+:/i.test(href)) {
      return null;
    }
    const [file, fragment] = href.split("#");
    const target = posix.normalize(posix.join(posix.dirname(path), decodeURI(file)));
    if (target.startsWith("../") || target.startsWith("/")) {
      return null;
    }
    if (documents.has(target)) {
      return `${root}${documents.get(target).url}${fragment ? `#${fragment}` : ""}`;
    }
    if (!tracked.includes(target)) {
      return null;
    }
    // Do not republish internal documents as source pages through incoming links.
    if (target.endsWith(".md") || target.startsWith("docs/internal/")) {
      return null;
    }
    if (image && /\.(png|svg|jpe?g|webp)$/i.test(target)) {
      copiedImages.add(target);
      return `${root}source/${target}`;
    }
    sourcePages.set(target, `source/${target}.html`);
    return `${root}source/${target}.html`;
  }
  const marked = new Marked({
    gfm: true,
    renderer: {
      html({ text }) {
        return escape(text);
      },
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const base = slug(text);
        const count = ids.get(base) || 0;
        ids.set(base, count + 1);
        const id = count ? `${base}-${count}` : base;
        if (depth === 2) {
          headings.push({ id, text });
        }
        return `<h${depth} id="${id}">${text}</h${depth}>`;
      },
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        const link = destination(href);
        return link
          ? `<a href="${escape(link)}">${text}</a>`
          : `<span title="Available in the source checkout or local build">${text} (local source/build)</span>`;
      },
      image({ href, text }) {
        const link = destination(href, true);
        return link
          ? `<img src="${escape(link)}" alt="${escape(text)}" loading="lazy">`
          : `<span>${escape(text)} (local build image)</span>`;
      },
    },
  });
  const content = marked
    .parse(doc.text)
    .replaceAll("<table>", '<div class="table-scroll"><table>')
    .replaceAll("</table>", "</table></div>");
  const toc = headings.length
    ? `<aside class="doc-toc"><nav aria-label="On this page"><h2>On this page</h2>${headings.map((heading) => `<a href="#${heading.id}">${heading.text}</a>`).join("")}</nav></aside>`
    : "";
  await emit(
    doc.url,
    docShell(
      doc.title,
      `<p class="doc-kicker">DOCUMENTATION / ${escape(path)}</p>${content}`,
      doc.url,
      path,
      toc,
    ),
  );
}
for (const [path, url] of sourcePages) {
  const content = await readFile(resolve(repo, path), "utf8");
  await emit(
    url,
    docShell(
      path,
      `<h1>Source reference</h1><p>${escape(path)}</p><pre><code>${escape(content)}</code></pre>`,
      url,
    ),
  );
}
for (const path of copiedImages) {
  await mkdir(dirname(resolve(output, "source", path)), { recursive: true });
  await cp(resolve(repo, path), resolve(output, "source", path));
}
await emit(
  "search.json",
  JSON.stringify(
    [...documents.values()].map(({ title, text, url }) => ({
      title,
      text: text.replace(/[`#*|]/g, "").replace(/\s+/g, " "),
      url,
    })),
  ),
);
await emit(
  "docs/index.html",
  docShell(
    "Documentation",
    `<p class="eyebrow">THE CREATOR’S HANDBOOK</p><h1>A small machine.<br>An open book.</h1><p>From your first frame to the details of the cartridge format. Everything you need to understand Bytorio and make it your own.</p><div class="doc-index"><a href="docs/getting-started.html"><strong>Start making</strong><span>Set up your tools and run your first game in Luau or Odin.</span></a><a href="sdk/api.html"><strong>Find an API</strong><span>Drawing, input, resources, and the game lifecycle.</span></a><a href="sdk/graphics.html"><strong>Build a world</strong><span>Textures, explicit passes, graphics, and display modes.</span></a><a href="sdk/synthesis.html"><strong>Make some noise</strong><span>PCM audio, synthesized voices, and effects.</span></a></div><aside class="note">SDK 0.2.0 is the published resource profile. 3D and Ogg streaming use explicit preview profiles. The Windows and Mac CLI preview creates projects and downloads SDKs; <a href="https://github.com/ctxshift/bytorio/releases">choose a CLI release</a> or <a href="docs/getting-started.html#install-with-mise">install with mise</a>. Build and run commands still require the source setup. Exported games run in browsers.</aside><h2 id="all-guides">All guides & specifications</h2><ul>${[
      ...documents,
    ]
      .sort((a, b) => a[1].title.localeCompare(b[1].title))
      .map(([, doc]) => `<li><a href="${doc.url.slice(5)}">${escape(doc.title)}</a></li>`)
      .join("")}</ul>`,
    "docs/index.html",
  ),
);
console.log(`Built site: ${documents.size} documents, ${games.length} playable demos → build/site`);
