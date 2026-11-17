// A small, readable classifier: multinomial logistic regression.
//
// The model is a table: for each act, one weight per named feature plus a
// bias. "animalClose -> hunt: +2.1" means an animal close by pushes toward
// hunting. Saved as JSON with the names, so it can be read in a text editor
// and edited directly (stage 5b: Opus edits these numbers, no training).
//
//   train(X, y, { classes, features, weights?, l2, epochs, lr }) -> model
//   predict(model, x) -> { probs: {act: p}, pick, p }
//   toTable(model) -> { act: { feature: weight, bias } } (for reading/editing)

function softmax(z) {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

function train(X, y, { classes, features, weights = null, l2 = 1e-3, epochs = 600, lr = 0.5 } = {}) {
  const K = classes.length;
  const D = features.length;
  const idx = Object.fromEntries(classes.map((c, i) => [c, i]));
  const W = Array.from({ length: K }, () => new Array(D).fill(0));
  const b = new Array(K).fill(0);
  const n = X.length;
  // Each class counts equally, however rare (a hunt that worked matters as
  // much as a thousand quiet ticks).
  const counts = new Array(K).fill(0);
  for (const c of y) counts[idx[c]] += 1;
  const cw = counts.map((c) => (c ? n / (K * c) : 0));
  const sw = y.map((c, i) => cw[idx[c]] * (weights ? weights[i] : 1));
  const tot = sw.reduce((a, v) => a + v, 0) || 1;
  for (let ep = 0; ep < epochs; ep++) {
    const gW = Array.from({ length: K }, () => new Array(D).fill(0));
    const gb = new Array(K).fill(0);
    for (let i = 0; i < n; i++) {
      const x = X[i];
      const z = W.map((w, k) => w.reduce((s, wj, j) => s + wj * x[j], b[k]));
      const p = softmax(z);
      const t = idx[y[i]];
      for (let k = 0; k < K; k++) {
        const g = (p[k] - (k === t ? 1 : 0)) * sw[i] / tot;
        gb[k] += g;
        for (let j = 0; j < D; j++) gW[k][j] += g * x[j];
      }
    }
    for (let k = 0; k < K; k++) {
      b[k] -= lr * gb[k];
      for (let j = 0; j < D; j++) W[k][j] -= lr * (gW[k][j] + l2 * W[k][j]);
    }
  }
  return { classes, features, W: W.map((r) => r.map((v) => Math.round(v * 1000) / 1000)), b: b.map((v) => Math.round(v * 1000) / 1000) };
}

function predict(model, x) {
  const z = model.W.map((w, k) => w.reduce((s, wj, j) => s + wj * x[j], model.b[k]));
  const p = softmax(z);
  let best = 0;
  for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k;
  return { probs: Object.fromEntries(model.classes.map((c, k) => [c, Math.round(p[k] * 1000) / 1000])), pick: model.classes[best], p: p[best] };
}

function toTable(model) {
  const out = {};
  model.classes.forEach((c, k) => {
    out[c] = { bias: model.b[k] };
    model.features.forEach((f, j) => { out[c][f] = model.W[k][j]; });
  });
  return out;
}

/** The inverse of toTable: a (possibly hand- or Opus-edited) table back into a model. */
function fromTable(table, features) {
  const classes = Object.keys(table);
  return {
    classes, features,
    W: classes.map((c) => features.map((f) => Number(table[c][f]) || 0)),
    b: classes.map((c) => Number(table[c].bias) || 0),
  };
}

module.exports = { train, predict, toTable, fromTable, softmax };
