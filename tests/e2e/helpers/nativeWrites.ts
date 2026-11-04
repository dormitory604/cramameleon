import type { Page } from '@playwright/test';

type NativeWriteControl = {
  count: number;
  releaseThrough: number;
  abort: boolean;
  abortAfter: number;
};
declare global { interface Window { nativeWrites: NativeWriteControl } }

// Keep actual native transactions alive with reads; tests own release/abort timing.
export async function controlNativeWrites(page: Page, initial: Partial<NativeWriteControl> = {}) {
  await page.addInitScript(initial => {
    const control = window.nativeWrites = { count: 0, releaseThrough: Infinity, abort: false, abortAfter: Infinity, ...initial };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      const number = ++control.count;
      const hold = () => {
        if (control.abort || number > control.abortAfter) { this.transaction.abort(); return; }
        if (number <= control.releaseThrough) return;
        this.get('__native_write_hold__').onsuccess = hold;
      };
      hold();
      return request;
    };
  }, initial);
}
