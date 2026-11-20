import { games } from "./catalog.mjs";
export const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function scenery(root) {
  return (
    '<div class="scenery" aria-hidden="true">' +
    ["heart", "coin", "mushroom", "stone", "tree", "gem_teal", "bush", "star"]
      .map(
        (name, i) =>
          '<img class="scenery-item item-' +
          i +
          '" src="' +
          root +
          "assets/brand/" +
          name +
          '.png" alt="">',
      )
      .join("") +
    "</div>"
  );
}

export function shell({ title, description, active, body, root = "./" }) {
  const nav = [
    ["Games", "showcase/index.html", "showcase"],
    ["Documentation", "docs/index.html", "docs"],
    ["SDK", "docs/sdk/README.html", "sdk"],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${escape(description)}"><meta name="theme-color" content="#11151d"><title>${escape(title)} · Bytorio</title><link rel="icon" href="${root}assets/brand/fox.png"><link rel="stylesheet" href="${root}site.css"><script type="module" src="${root}site.js"></script></head>
<body data-root="${root}" class="page-${active}"><a class="skip" href="#main">Skip to content</a>
<svg class="asset-filters" aria-hidden="true"><defs><filter id="clean-alpha"><feMorphology in="SourceAlpha" operator="erode" radius="0.7" result="edge"/><feComposite in="SourceGraphic" in2="edge" operator="in"/></filter><filter id="blue-key" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 6 -6 0 2"/><feComposite in2="SourceAlpha" operator="in"/></filter><filter id="green-key" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  12 -24 12 0 1"/></filter></defs></svg>
<header class="header"><a class="brand" href="${root}index.html" aria-label="Bytorio home"><img src="${root}assets/brand/logo.png" alt="Bytorio" width="400" height="105"></a><nav aria-label="Main navigation">${nav.map(([label, href, key]) => '<a href="' + root + href + '" ' + (active === key ? 'aria-current="page"' : "") + ">" + label + "</a>").join("")}</nav><a class="header-cta" href="${root}docs/docs/getting-started.html">Get started <span aria-hidden="true">↗</span></a></header>
${body}
<footer><a class="brand" href="${root}index.html"><img src="${root}assets/brand/logo.png" alt="Bytorio" width="260" height="68" loading="lazy"></a><p>A tiny console for big adventures.</p><a href="${root}docs/index.html">Documentation ↗</a><span>bytor.io</span></footer></body></html>`;
}

export function card(game, root) {
  return `<article class="game-card" data-category="${game.category}"><a class="game-image" href="${root}showcase/${game.id}/index.html"><img src="${root}assets/${game.id}.png" alt="${escape(game.title)} gameplay" width="640" height="360" loading="lazy"></a><div class="card-content"><h3><a href="${root}showcase/${game.id}/index.html">${game.title}</a></h3><p>${game.description}</p><div class="tags"><span>2D</span><span>${game.category}</span></div><a class="text-link" href="${root}showcase/${game.id}/index.html">Play game →</a></div></article>`;
}

export function home() {
  return shell({
    title: "A tiny console for big adventures",
    description:
      "Make and play small games with Bytorio. A fantasy console with Luau and Odin, PNG cartridges, and browser-ready adventures.",
    active: "home",
    body: `<main id="main">
<section class="hero">${scenery("./")}<div class="hero-copy"><p class="eyebrow">MEET YOUR NEXT LITTLE WORLD</p><h1>A tiny console<br>for <em>big adventures.</em></h1><p>Make something small. Go somewhere extraordinary.<br>Build your own games in Luau or Odin, then share the whole adventure in a cartridge.</p><div class="actions"><a class="button primary" href="showcase/index.html">Play the games</a><a class="text-link" href="docs/docs/getting-started.html">Start creating ↗</a></div><p class="hero-note">Native + browser · Keyboard + touch</p></div>
<a class="hero-console" href="showcase/copper-circuit/index.html" aria-label="Play Copper Circuit"><img class="handheld-body" src="assets/brand/handheld.png" alt="Gray Bytorio handheld with a black direction pad and red buttons" width="670" height="953"><div class="handheld-screen"><img src="assets/copper-circuit.png" alt="Copper Circuit gameplay"><span>▶ PLAY COPPER CIRCUIT</span></div></a></section>
<section class="capabilities" aria-label="Create with Bytorio"><a href="docs/sdk/graphics.html"><img class="clean-asset" src="assets/brand/sword.png" alt="" width="110" height="110"><div><h2>2D</h2><p>Every pixel, a possibility.</p></div></a><a href="docs/docs/compact-3d.html"><img class="clean-asset" src="assets/brand/hero.png" alt="" width="110" height="110"><div><h2>3D</h2><p>Little worlds with depth.</p></div></a><a href="docs/docs/resource-profile.html"><img src="assets/brand/fox.png" alt="" width="110" height="110"><div><h2>Your rules.</h2><p>Small machine. Big ideas.</p></div></a></section>
<section class="section cartridge-section"><div class="section-heading"><div><p class="eyebrow">PICK UP & PLAY</p><h2>Good things come in cartridges.</h2></div><a class="text-link" href="showcase/index.html">All games ↗</a></div><div class="cartridge-shelf">${games.map((game) => '<a class="cartridge-link" href="showcase/' + game.id + '/index.html"><div class="cartridge"><img class="cartridge-frame" src="assets/brand/cartridge.png" alt=""><div class="cartridge-label"><img src="assets/' + game.id + '.png" alt="' + game.title + ' gameplay"><strong>' + game.title + "</strong><span>BYTORIO · " + game.category.toUpperCase() + "</span></div></div><h3>" + game.title + '</h3><span class="text-link">Play in your browser →</span></a>').join("")}<div class="create-cartridge"><img src="assets/brand/fox.png" alt="Bytorio’s red fox mascot" width="180" height="190" loading="lazy"><h3>The next one could be yours.</h3><p>A few lines of code. A spark of an idea.<br>A world only you could make.</p><a class="text-link" href="docs/docs/getting-started.html">Make your first game ↗</a></div></div></section>
<section class="make-section"><div><p class="eyebrow">FROM FIRST LINE TO FIRST ADVENTURE</p><h2>A little code.<br>A whole lot of play.</h2><p>Your editor, your language, your imagination. Typed Luau and Odin share one console, with graphics, audio, input, and portable PNG cartridges.</p><a class="button primary" href="docs/sdk/README.html">Explore the SDK</a></div><div class="terminal"><div class="terminal-bar">YOUR NEXT ADVENTURE</div><pre><span># Start with an idea</span>
byt new my-game

<span># Preview creates projects; source CLI runs games</span>
byt --help</pre><p><a href="docs/docs/getting-started.html#download-the-cli-preview">Download the Windows or Mac preview</a> · Build/run require source setup</p></div></section></main>`,
  });
}

export function showcase() {
  return shell({
    title: "Games",
    description:
      "Play complete Bytorio games in your browser. Desktop and mobile adventures, with keyboard and touch controls.",
    active: "showcase",
    root: "../",
    body: `<main id="main" class="showcase-page"><section class="page-intro">${scenery("../")}<h1>Games</h1><p>Small cartridges. Whole worlds to explore.</p></section><a class="featured-game" href="mossglen/index.html"><img src="../assets/mossglen.png" alt="Mossglen village and forest"><div><span class="eyebrow">FEATURED ADVENTURE</span><h2>Mossglen:<br>The Sunleaf</h2><p>A missing sunleaf. A village counting on you.</p><span class="button primary">Play</span></div></a><div class="game-filters" role="group" aria-label="Filter games"><button aria-pressed="true" data-filter="all">All games</button><button aria-pressed="false" data-filter="Arcade racing">Racing</button><button aria-pressed="false" data-filter="Tiny adventure">Adventure</button><span>Desktop + mobile · Touch ready</span></div><div class="game-grid">${games.map((game) => card(game, "../")).join("")}</div><p class="note">Both games run in your browser with keyboard or touch controls. No install or WebGPU required. Choose Luau or Odin on the game page, or download a PNG cartridge to keep.</p></main>`,
  });
}

export function gamePage(game) {
  return shell({
    title: game.title,
    description: game.description,
    active: "showcase",
    root: "../../",
    body: `<main id="main" class="game-page"><a class="back-link" href="../index.html">← Back to the showcase</a><div class="game-title"><div><p class="eyebrow">${game.category} / ${game.resolution}</p><h1>${game.title}</h1></div><span class="compatibility">${game.requiresGpu ? "GPU required" : "Desktop + mobile · CPU renderer"}</span></div><div class="play-layout"><section class="play-panel" aria-label="Game player"><div class="launch-screen" data-game="${game.id}" data-cartridge="${game.cartridge}" data-gpu="${game.requiresGpu}"><img src="../../assets/${game.id}.png" alt="${game.title} preview" width="640" height="360"><div class="launch-overlay"><button class="button primary" id="launch">▶ Load game</button><p>No download. Your next few minutes, sorted.</p></div></div><div id="player-slot" hidden></div><div class="player-toolbar"><label for="language">Cartridge language</label><select id="language"><option value="luau">Luau</option><option value="odin">Odin</option></select><button id="restart" hidden>Restart game</button><a id="download" href="../../games/${game.id}/${game.cartridge}-luau.png" download>↓ PNG cartridge</a></div><p id="play-status" role="status">Load the game, then press Start game to enable audio.</p></section><aside class="game-about"><p class="eyebrow">HOW TO PLAY</p><h2>A little field guide.</h2><p>${game.detail}</p><h3>At your desk</h3><p>${game.controls}</p><h3>On the go</h3><p>Use the on-screen direction pad and ${game.action} button. Hold more than one control to move and act together.</p><a class="text-link" href="../../docs/${game.guide.replace(/\.md$/, ".html")}">Read the making-of & source guide ↗</a><p class="small">Each language is a separate implementation of the same game. Changing language starts a new session.</p></aside></div></main>`,
  });
}
