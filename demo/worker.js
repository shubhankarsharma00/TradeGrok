import { parseCsv, csvRows, checksum } from './data.js';
import { createSimulation } from './engine.js';
let simulation;
self.onmessage = async ({ data: { id, action, input } }) => {
  try {
    let result;
    if (action === 'preview') {
      const rows = csvRows(await input.file.text());
      result = { headers: rows[0], sample: rows.slice(1, 4), rows: rows.length - 1 };
    } else if (action === 'parse') {
      result = parseCsv(await input.file.text(), input.mapping);
      result.sha256 = await checksum(result.bars);
    } else if (action === 'run') {
      const sim = createSimulation(input);
      let snapshot;
      do {
        snapshot = sim.step(1000);
        self.postMessage({ id, progress: { cursor: snapshot.cursor, total: snapshot.total } });
        await new Promise(resolve => setTimeout(resolve, 0));
      } while (!snapshot.done);
      result = sim.finish();
    } else if (action === 'init') { simulation = createSimulation(input); result = simulation.snapshot(); }
    else {
      if (!simulation && action !== 'seek') throw new Error('Initialize a historical replay first.');
      if (action === 'step') result = simulation.step(input.count);
      else if (action === 'seek') {
        simulation = createSimulation(input.config);
        let current = 0;
        for (const change of input.actions ?? []) {
          if (change.step > input.steps) break;
          if (!Number.isSafeInteger(change.step) || change.step < current) throw new Error('Invalid saved replay action order.');
          simulation.step(change.step - current); current = change.step;
          if (change.action === 'lock') simulation.lock(change.input.active);
          else if (change.action === 'enable') simulation.setEnabled(change.input.key, change.input.enabled);
          else if (change.action === 'close') simulation.close(change.input.key);
          else throw new Error('Unknown saved replay action.');
        }
        result = simulation.step(input.steps - current);
      } else if (action === 'lock') { simulation.lock(input.active); result = simulation.snapshot(); }
      else if (action === 'enable') { simulation.setEnabled(input.key, input.enabled); result = simulation.snapshot(); }
      else if (action === 'close') result = simulation.close(input.key);
      else if (action === 'report') result = simulation.report();
      else throw new Error('Unknown worker operation.');
    }
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
