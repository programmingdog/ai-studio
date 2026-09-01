// Tiny deterministic hook runner for component event-handler tests (not a DOM renderer).
const fs = require('node:fs');
const ts = require('typescript');
const flush = () => new Promise(resolve => setImmediate(resolve));
function componentHarness(file, name, props, imports = {}) {
  const slots = [], effects = []; let cursor = 0, tree;
  const depsChanged = (old, next) => !old || !next || old.length !== next.length || next.some((x, i) => !Object.is(x, old[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || depsChanged(slots[i].deps, deps)) slots[i] = { deps, fn }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || depsChanged(slots[i].deps, deps)) { const old = slots[i]; slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const query = {
    useQueryClient: () => ({ async invalidateQueries() {} }),
    useMutation(options) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { isPending: false, isSuccess: false, error: null };
      const state = slots[i];
      state.reset = () => { state.error = null; state.isSuccess = false; };
      state.mutate = input => {
        state.isPending = true;
        Promise.resolve().then(() => options.mutationFn(input)).then(async result => { await options.onSuccess?.(result); state.isSuccess = true; }).catch(error => { state.error = error; }).finally(() => { state.isPending = false; options.onSettled?.(); });
      }; return state;
    },
  };
  const source = fs.readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const localRequire = id => id === 'react' ? react : id === '@tanstack/react-query' ? query : id === 'react-dom' ? { createPortal: node => node } : imports[id] || require(id);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled + `\nmodule.exports.TestComponent = ${name};`)(localRequire, module, module.exports);
  function render() { cursor = 0; tree = module.exports.TestComponent(props); while (effects.length) effects.shift()(); }
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(child => child == null ? [] : nodes(child)); return [node, ...nodes(node.props?.children ?? null)]; }
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
  const button = label => nodes().find(node => node.type === 'button' && text(node).includes(label));
  const edit = (node, value) => { node.props.onChange({ target: { value, checked: value } }); render(); };
  render();
  return { render, nodes, button, edit, text, async ready() { await flush(); render(); }, unmount() { slots.forEach(x => x?.cleanup?.()); } };
}
module.exports = { componentHarness, flush };
