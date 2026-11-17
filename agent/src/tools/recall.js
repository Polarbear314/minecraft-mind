// What would a layer remember right now? (docs/design-subsumption.md, stage 2)
//
//   npm run recall -- "dusk, two sides closed, zombie at 12 blocks" --layer shelter [--k 8]
//   npm run recall -- --stats
//
// Ranks the live vault the way the upper layers will: similarity x weight x
// recency (vault/memory.js). Uses EMBED_MODEL from agent/.env if set and
// pulled in Ollama, otherwise word overlap. Read-only.
require('dotenv').config();
const path = require('path');
const { createMemory, ollamaEmbedder } = require('../vault/memory');

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
  const vaultPath = process.env.VAULT_PATH;
  if (!vaultPath) throw new Error('VAULT_PATH is not set in agent/.env');
  const model = (process.env.EMBED_MODEL || '').trim();
  const mem = createMemory({
    vaultPath,
    embed: model ? ollamaEmbedder({ model }) : null,
    cacheFile: model ? path.resolve(__dirname, '..', '..', '..', 'logs', 'memory-embeddings.json') : null,
  });
  mem.refresh();
  const question = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--stats')).join(' ');
  if (args.includes('--stats') || !question) {
    console.log(JSON.stringify(mem.stats(), null, 2));
    if (!question) return;
  }
  const hits = await mem.retrieve(question, { layer: opt('layer', null), k: Number(opt('k', 6)) });
  console.log(`Top notes for "${question}"${opt('layer') ? ` (layer ${opt('layer')})` : ''}, by ${mem.usingEmbeddings() ? 'embeddings' : 'words'}:\n`);
  for (const h of hits) {
    console.log(`  ${h.score.toFixed(3)}  [${h.kind}] ${h.title}   (similarity ${h.sim}, weight ${h.weight}, recency ${h.recency})`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
