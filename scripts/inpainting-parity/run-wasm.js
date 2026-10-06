const fs = require('fs');
const path = require('path');
// usage: node run-wasm.js <inp.wasm> <out.txt>
const bytes = fs.readFileSync(process.argv[2]);
WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
  const { run, patchPtr, resultPtr, memory } = instance.exports;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.floor(clamp(v) + 0.5).toString(16).padStart(2, '0')).join('').toUpperCase();
  let out = '';
  ['flat', 'stripes', 'gradient', 'noise', 'blank'].forEach((name, id) => {
    const rc = run(id);
    if (rc !== 0) throw new Error('run failed ' + rc);
    const dv = new DataView(memory.buffer, resultPtr());
    const method = dv.getInt32(0, true), filled = dv.getInt32(4, true);
    const threshold = dv.getFloat64(8, true), sigma = dv.getFloat64(16, true), conf = dv.getFloat64(24, true);
    const hasText = dv.getInt32(32, true);
    const tr = dv.getFloat64(40, true), tg = dv.getFloat64(48, true), tb = dv.getFloat64(56, true);
    const mr = dv.getFloat64(64, true), mg = dv.getFloat64(72, true), mb = dv.getFloat64(80, true);
    const lum = 0.299 * mr + 0.587 * mg + 0.114 * mb;
    const textColor = hasText ? hex(tr, tg, tb) : lum > 128 ? '#111827' : '#F9FAFB';
    out += `${name} ${method ? 'inpaint' : 'plane'} ${filled} ${threshold.toFixed(6)} ${sigma.toFixed(6)} ${textColor} ${hex(mr, mg, mb)} ${conf.toFixed(6)}\n`;
    const p = new Uint8Array(memory.buffer, patchPtr(), 64 * 32 * 4);
    for (let k = 0; k < p.length; k += 4) out += [p[k], p[k + 1], p[k + 2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase() + ' ';
    out += '\n';
  });
  fs.writeFileSync(process.argv[3], out);

});
