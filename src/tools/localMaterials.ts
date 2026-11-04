import { AppError } from '../contracts/index.ts';
import type { ArchiveEntry, ImportResult } from '../contracts/index.ts';
import { FILE_LIMIT } from './localArchive.ts';

// Raw bytes live only in this disposable Worker. Cancellation kills parsing and late messages.
function task<T>(file:File,mode:'list'|'parse',signal:AbortSignal,onProgress:(message:string)=>void,entries?:string[]):Promise<T> {
 signal.throwIfAborted();
 if(file.size>FILE_LIMIT)return Promise.reject(new AppError('FILE_LIMIT','单文件最多 20MB'));
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./material.worker.ts',import.meta.url),{type:'module'});
  let finished=false;
  const finish=(error?:Error,value?:T)=>{if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener('abort',abort);worker.terminate();error?reject(error):resolve(value!);};
  const abort=()=>finish(new AppError('FILE_CANCELLED','已取消导入'));
  const timer=setTimeout(()=>finish(new AppError('FILE_TIMEOUT','解析超过两分钟，请拆分文件后重试')),120000);
  signal.addEventListener('abort',abort,{once:true});
  worker.onmessage=event=>{
   if(signal.aborted)return abort();
   const e=event.data;
   if(e.type==='progress')onProgress(e.message);
   else if(e.type==='error')finish(new AppError(e.code,e.message));
   else if(e.type==='result')finish(undefined,e.value);
  };
  worker.onerror=()=>finish(new AppError('FILE_WORKER','解析进程失败，请重新导出文件或重试'));
  worker.postMessage({mode,file,entries});
 });
}
export const listLocalArchive=(file:File,signal:AbortSignal)=>task<ArchiveEntry[]>(file,'list',signal,()=>{});
export const importLocalFile=(file:File,signal:AbortSignal,onProgress:(s:string)=>void,entries?:string[])=>task<ImportResult>(file,'parse',signal,onProgress,entries);
