const DB = 'tradegrok-static-v1';
export const reportMetadata = ({ equity, trades, orders, logs, positions, ...metadata }) => metadata;
export async function openStorage() {
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = () => {
      for (const name of ['datasets', 'datasetMeta', 'workspace', 'reports', 'reportMeta']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
      const cursor = request.transaction.objectStore('reports').openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (row) { request.transaction.objectStore('reportMeta').put(reportMetadata(row.value)); row.continue(); }
      };
    };
    request.onsuccess = () => {
      if (abandoned) request.result.close();
      else { request.result.onversionchange = () => request.result.close(); resolve(request.result); }
    };
    request.onerror = () => reject(new Error('Browser storage unavailable. Nothing has been saved. Allow site storage or export your work before leaving.'));
    request.onblocked = () => { abandoned = true; reject(new Error('Storage upgrade blocked. Close other TradeGrok demo tabs.')); };
  });
}
export async function saveReport(report) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(['reports', 'reportMeta'], 'readwrite');
      tx.objectStore('reports').put(report); tx.objectStore('reportMeta').put(reportMetadata(report));
    } catch (error) { tx?.abort(); db.close(); reject(new Error(`Report save failed: ${error.name}. Export it before leaving this tab.`)); return; }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error('Report could not be saved. Export it before leaving this tab.')); };
  });
}
export async function removeReport(id) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['reports', 'reportMeta'], 'readwrite');
    tx.objectStore('reports').delete(id); tx.objectStore('reportMeta').delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error('Report removal failed. Browser records were not partially removed.')); };
  });
}
export async function storageAction(store, method, value) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    let tx;
    let result;
    let request;
    try {
      tx = db.transaction(store, ['getAll', 'get', 'count'].includes(method) ? 'readonly' : 'readwrite');
      request = tx.objectStore(store)[method](...(value === undefined ? [] : [value]));
    } catch (error) { db.close(); reject(new Error(`Local ${store} operation failed: ${error.name}. Nothing was saved.`)); return; }
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error(`Local ${store} operation failed: ${tx.error?.name ?? 'storage error'}. Export your unsaved work.`)); };
  });
}
export async function saveDataset(dataset) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(['datasets', 'datasetMeta'], 'readwrite');
      const { bars, ...metadata } = dataset;
      tx.objectStore('datasets').put(dataset);
      tx.objectStore('datasetMeta').put(metadata);
    } catch (error) { tx?.abort(); db.close(); reject(new Error(`Dataset save failed: ${error.name}. It remains unsaved in this tab.`)); return; }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error('Dataset could not be saved. Check browser quota/permissions. It remains unsaved in this tab.')); };
  });
}
export async function removeDataset(id) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['datasets', 'datasetMeta'], 'readwrite');
    tx.objectStore('datasets').delete(id); tx.objectStore('datasetMeta').delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error('Dataset removal failed. Browser records were not partially removed.')); };
  });
}
